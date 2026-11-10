// Screenshots: ScreenCaptureKit (macOS 14+) with a CGWindowList fallback for
// older systems. The JPEG is produced in memory and handed to JS as a Buffer;
// nothing is written to disk.

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <dlfcn.h>

#include "napi_util.h"
#include "screenshot.h"

namespace lens {
namespace {

const int64_t kSCKTimeoutNs = 5 * NSEC_PER_SEC;

struct ShotWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool window = false;
  pid_t pid = 0;
  double maxWidth = 1920;
  double quality = 0.8;
  // result
  NSData *jpeg = nil;
  size_t width = 0;
  size_t height = 0;
  const char *backend = "";
};

// Frontmost layer-0 on-screen window of pid, in front-to-back order.
CGWindowID FrontWindowOf(pid_t pid) {
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!list) return kCGNullWindowID;
  NSArray *windows = CFBridgingRelease(list);
  for (NSDictionary *w in windows) {
    if ([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
    if ([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    return [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
  }
  return kCGNullWindowID;
}

CGImageRef CaptureWithSCK(ShotWork *w) API_AVAILABLE(macos(14.0)) {
  __block SCShareableContent *content = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                             onScreenWindowsOnly:YES
                                               completionHandler:^(SCShareableContent *c,
                                                                   NSError *) {
                                                 content = c;
                                                 dispatch_semaphore_signal(sem);
                                               }];
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kSCKTimeoutNs)) != 0 ||
      !content) {
    return nullptr;
  }

  SCContentFilter *filter = nil;
  if (w->window) {
    CGWindowID target = FrontWindowOf(w->pid);
    for (SCWindow *win in content.windows) {
      if (win.windowID == target) {
        filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:win];
        break;
      }
    }
  } else {
    CGDirectDisplayID main = CGMainDisplayID();
    for (SCDisplay *d in content.displays) {
      if (d.displayID == main) {
        filter = [[SCContentFilter alloc] initWithDisplay:d excludingWindows:@[]];
        break;
      }
    }
  }
  if (!filter) return nullptr;

  CGRect rect = filter.contentRect;
  double scale = filter.pointPixelScale;
  double pxWidth = rect.size.width * scale;
  double pxHeight = rect.size.height * scale;
  if (pxWidth < 1 || pxHeight < 1) return nullptr;
  double ratio = (w->maxWidth > 0 && pxWidth > w->maxWidth) ? w->maxWidth / pxWidth : 1.0;

  SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
  config.width = (size_t)(pxWidth * ratio);
  config.height = (size_t)(pxHeight * ratio);
  config.showsCursor = NO;

  __block CGImageRef image = nullptr;
  dispatch_semaphore_t sem2 = dispatch_semaphore_create(0);
  [SCScreenshotManager captureImageWithFilter:filter
                                configuration:config
                            completionHandler:^(CGImageRef img, NSError *) {
                              if (img) image = CGImageRetain(img);
                              dispatch_semaphore_signal(sem2);
                            }];
  if (dispatch_semaphore_wait(sem2, dispatch_time(DISPATCH_TIME_NOW, kSCKTimeoutNs)) != 0) {
    // Late completion would leak one image; acceptable versus blocking forever.
    return nullptr;
  }
  return image;
}

// CGWindowListCreateImage is obsoleted in the macOS 15 SDK, so resolve it at
// runtime; it is the only path on macOS 12-13.
CGImageRef CaptureWithCGWindowList(ShotWork *w) {
  using Fn = CGImageRef (*)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);
  static Fn fn = (Fn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
  if (!fn) return nullptr;
  if (w->window) {
    CGWindowID target = FrontWindowOf(w->pid);
    if (target == kCGNullWindowID) return nullptr;
    return fn(CGRectNull, kCGWindowListOptionIncludingWindow, target,
              kCGWindowImageBoundsIgnoreFraming);
  }
  return fn(CGDisplayBounds(CGMainDisplayID()), kCGWindowListOptionOnScreenOnly, kCGNullWindowID,
            kCGWindowImageDefault);
}

NSData *EncodeJPEG(CGImageRef image, double maxWidth, double quality, size_t *outW,
                   size_t *outH) {
  size_t w = CGImageGetWidth(image);
  size_t h = CGImageGetHeight(image);
  CGImageRef scaled = CGImageRetain(image);
  if (maxWidth > 0 && w > (size_t)maxWidth) {
    size_t nw = (size_t)maxWidth;
    size_t nh = (size_t)((double)h * ((double)nw / (double)w));
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(nullptr, nw, nh, 8, 0, cs,
                                             (CGBitmapInfo)kCGImageAlphaNoneSkipFirst | (CGBitmapInfo)kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (ctx) {
      CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
      CGContextDrawImage(ctx, CGRectMake(0, 0, nw, nh), image);
      CGImageRef out = CGBitmapContextCreateImage(ctx);
      CGContextRelease(ctx);
      if (out) {
        CGImageRelease(scaled);
        scaled = out;
        w = nw;
        h = nh;
      }
    }
  }
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, nullptr);
  bool ok = false;
  if (dest) {
    NSDictionary *props = @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(quality)};
    CGImageDestinationAddImage(dest, scaled, (__bridge CFDictionaryRef)props);
    ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
  }
  CGImageRelease(scaled);
  if (!ok) return nil;
  *outW = w;
  *outH = h;
  return data;
}

}  // namespace

napi_value Screenshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto *w = new ShotWork();
  // Default: the frontmost window only. A display grab would include windows of
  // other (possibly excluded) apps behind it.
  w->window = true;
  bool havePid = false;
  if (argc > 0) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object) {
      NSString *scope = nil;
      if (GetString(env, argv[0], "scope", &scope)) {
        if ([scope isEqualToString:@"display"]) {
          w->window = false;
        } else if (![scope isEqualToString:@"frontmostWindow"]) {
          delete w;
          ThrowCode(env, "ERR_INVALID_ARG", "scope must be 'display' or 'frontmostWindow'");
          return nullptr;
        }
      }
      double d;
      if (GetNumber(env, argv[0], "maxWidth", &d)) w->maxWidth = d;
      if (GetNumber(env, argv[0], "quality", &d)) w->quality = d > 1 ? d / 100.0 : d;
      // Caller-pinned pid: the app the caller already checked against the
      // exclusion list, so a foreground change cannot redirect the grab.
      if (GetNumber(env, argv[0], "pid", &d) && d > 0) {
        w->pid = (pid_t)d;
        havePid = true;
      }
    }
  }
  if (w->window && !havePid) {
    NSRunningApplication *front = [NSWorkspace sharedWorkspace].frontmostApplication;
    w->pid = front ? front.processIdentifier : 0;
  }
  napi_value promise, name;
  napi_create_promise(env, &w->deferred, &promise);
  napi_create_string_utf8(env, "lens.screenshot", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *data) {
        auto *w = static_cast<ShotWork *>(data);
        @autoreleasepool {
          if (!CGPreflightScreenCaptureAccess()) return;  // never prompt from capture
          if (w->window && w->pid == 0) return;
          CGImageRef image = nullptr;
          if (@available(macOS 14.0, *)) {
            image = CaptureWithSCK(w);
            if (image) w->backend = "screencapturekit";
          }
          if (!image) {
            image = CaptureWithCGWindowList(w);
            if (image) w->backend = "cgwindowlist";
          }
          if (!image) return;
          w->jpeg = EncodeJPEG(image, w->maxWidth, w->quality, &w->width, &w->height);
          CGImageRelease(image);
        }
      },
      [](napi_env env, napi_status, void *data) {
        auto *w = static_cast<ShotWork *>(data);
        napi_value result;
        if (!w->jpeg) {
          napi_get_null(env, &result);
        } else {
          napi_create_object(env, &result);
          napi_value buf;
          void *copy = nullptr;
          napi_create_buffer_copy(env, w->jpeg.length, w->jpeg.bytes, &copy, &buf);
          napi_set_named_property(env, result, "data", buf);
          SetNumber(env, result, "width", (double)w->width);
          SetNumber(env, result, "height", (double)w->height);
          napi_value mime, backend;
          napi_create_string_utf8(env, "image/jpeg", NAPI_AUTO_LENGTH, &mime);
          napi_create_string_utf8(env, w->backend, NAPI_AUTO_LENGTH, &backend);
          napi_set_named_property(env, result, "mimeType", mime);
          napi_set_named_property(env, result, "backend", backend);
        }
        napi_resolve_deferred(env, w->deferred, result);
        napi_delete_async_work(env, w->work);
        w->jpeg = nil;
        delete w;
      },
      w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

struct ProbeWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool granted = false;
  double displays = 0;
};

napi_value ProbeScreenRecording(napi_env env, napi_callback_info) {
  auto *w = new ProbeWork();
  napi_value promise, name;
  napi_create_promise(env, &w->deferred, &promise);
  napi_create_string_utf8(env, "lens.probeScreenRecording", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *data) {
        auto *w = static_cast<ProbeWork *>(data);
        if (@available(macOS 12.3, *)) @autoreleasepool {
          __block SCShareableContent *content = nil;
          __block NSError *error = nil;
          dispatch_semaphore_t sem = dispatch_semaphore_create(0);
          [SCShareableContent
              getShareableContentWithCompletionHandler:^(SCShareableContent *c, NSError *e) {
                content = c;
                error = e;
                dispatch_semaphore_signal(sem);
              }];
          if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kSCKTimeoutNs)) == 0) {
            w->granted = content != nil && error == nil;
            w->displays = content ? (double)content.displays.count : 0;
          }
        }
      },
      [](napi_env env, napi_status, void *data) {
        auto *w = static_cast<ProbeWork *>(data);
        napi_value result;
        napi_create_object(env, &result);
        SetBool(env, result, "granted", w->granted);
        SetNumber(env, result, "displays", w->displays);
        napi_resolve_deferred(env, w->deferred, result);
        napi_delete_async_work(env, w->work);
        delete w;
      },
      w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

}  // namespace lens
