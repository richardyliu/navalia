// Event source for the capture coordinator. Mirrors the OSS mac-ax-watcher's
// notification set (focused window, title, value changed per regular app) but
// runs inside the Lens process, so there is no separate watcher subject in TCC.
// Must be called on the main thread (Electron main), whose run loop delivers
// NSWorkspace and AXObserver callbacks.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <string>

#include "napi_util.h"
#include "observe.h"

@interface LensObservedApp : NSObject
@property(nonatomic) pid_t pid;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *bundleId;
@property(nonatomic, copy) NSString *bundlePath;
@property(nonatomic) AXObserverRef observer;
@end
@implementation LensObservedApp
- (void)dealloc {
  if (_observer) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer),
                          kCFRunLoopDefaultMode);
    CFRelease(_observer);
  }
}
@end

namespace lens {
namespace {

struct Event {
  std::string eventType, appName, bundleId, bundlePath, windowTitle;
  pid_t pid = 0;
  bool hasTitle = false;
};

napi_threadsafe_function g_tsfn = nullptr;
NSMutableDictionary<NSNumber *, LensObservedApp *> *g_apps = nil;
NSMutableArray *g_tokens = nil;

std::string U(NSString *s) { return std::string(s.UTF8String ?: ""); }

bool FocusedIsSecure(AXUIElementRef app) {
  CFTypeRef el = nullptr;
  if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &el) != kAXErrorSuccess ||
      !el) {
    return false;
  }
  CFTypeRef sub = nullptr;
  bool secure = false;
  if (AXUIElementCopyAttributeValue((AXUIElementRef)el, kAXSubroleAttribute, &sub) ==
          kAXErrorSuccess &&
      sub) {
    secure = CFGetTypeID(sub) == CFStringGetTypeID() &&
             CFStringCompare((CFStringRef)sub, CFSTR("AXSecureTextField"), 0) == kCFCompareEqualTo;
    CFRelease(sub);
  }
  CFRelease(el);
  return secure;
}

void Emit(NSString *type, LensObservedApp *app, bool withTitle) {
  if (!g_tsfn) return;
  auto *e = new Event();
  e->eventType = U(type);
  e->pid = app.pid;
  e->appName = U(app.name);
  e->bundleId = U(app.bundleId);
  e->bundlePath = U(app.bundlePath);
  if (withTitle && AXIsProcessTrusted()) {
    AXUIElementRef ax = AXUIElementCreateApplication(app.pid);
    NSString *title = FocusedWindowTitle(app.pid);
    if (FocusedIsSecure(ax)) title = @"[REDACTED]";
    CFRelease(ax);
    e->hasTitle = true;
    e->windowTitle = U(title ?: @"");
  }
  if (napi_call_threadsafe_function(g_tsfn, e, napi_tsfn_nonblocking) != napi_ok) delete e;
}

void AXCallback(AXObserverRef, AXUIElementRef, CFStringRef notification, void *refcon) {
  LensObservedApp *app = (__bridge LensObservedApp *)refcon;
  Emit((__bridge NSString *)notification, app, true);
}

LensObservedApp *Ensure(NSRunningApplication *ra) {
  NSNumber *key = @(ra.processIdentifier);
  LensObservedApp *app = g_apps[key];
  if (!app) {
    app = [[LensObservedApp alloc] init];
    app.pid = ra.processIdentifier;
    app.name = ra.localizedName ?: @"Unknown";
    app.bundleId = ra.bundleIdentifier ?: @"";
    app.bundlePath = ra.bundleURL.path ?: @"";
    g_apps[key] = app;
  }
  if (!app.observer && AXIsProcessTrusted() &&
      ra.activationPolicy == NSApplicationActivationPolicyRegular) {
    AXObserverRef obs = nullptr;
    if (AXObserverCreate(app.pid, AXCallback, &obs) == kAXErrorSuccess && obs) {
      AXUIElementRef el = AXUIElementCreateApplication(app.pid);
      void *refcon = (__bridge void *)app;  // g_apps keeps app alive
      AXObserverAddNotification(obs, el, kAXFocusedWindowChangedNotification, refcon);
      AXObserverAddNotification(obs, el, kAXTitleChangedNotification, refcon);
      AXObserverAddNotification(obs, el, kAXValueChangedNotification, refcon);
      CFRelease(el);
      CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs),
                         kCFRunLoopDefaultMode);
      app.observer = obs;
    }
  }
  return app;
}

void CallJs(napi_env env, napi_value cb, void *, void *data) {
  auto *e = static_cast<Event *>(data);
  if (env && cb) {
    napi_value obj, undefined, pid;
    napi_create_object(env, &obj);
    auto setStr = [&](const char *k, const std::string &v) {
      napi_value s;
      napi_create_string_utf8(env, v.c_str(), v.size(), &s);
      napi_set_named_property(env, obj, k, s);
    };
    setStr("eventType", e->eventType);
    setStr("appName", e->appName);
    setStr("bundleId", e->bundleId);
    setStr("bundlePath", e->bundlePath);
    if (e->hasTitle) setStr("windowTitle", e->windowTitle);
    napi_create_int32(env, e->pid, &pid);
    napi_set_named_property(env, obj, "pid", pid);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, cb, 1, &obj, nullptr);
  }
  delete e;
}

void Teardown() {
  NSNotificationCenter *nc = [NSWorkspace sharedWorkspace].notificationCenter;
  for (id token in g_tokens) [nc removeObserver:token];
  g_tokens = nil;
  g_apps = nil;  // LensObservedApp dealloc removes run loop sources
  if (g_tsfn) {
    napi_release_threadsafe_function(g_tsfn, napi_tsfn_abort);
    g_tsfn = nullptr;
  }
}

}  // namespace

NSString *FocusedWindowTitle(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef win = nullptr;
  NSString *title = nil;
  if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &win) == kAXErrorSuccess &&
      win) {
    CFTypeRef t = nullptr;
    if (AXUIElementCopyAttributeValue((AXUIElementRef)win, kAXTitleAttribute, &t) ==
            kAXErrorSuccess &&
        t) {
      if (CFGetTypeID(t) == CFStringGetTypeID()) title = (__bridge NSString *)t;
      title = [title copy];
      CFRelease(t);
    }
    CFRelease(win);
  }
  CFRelease(app);
  return title;
}

napi_value Observe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype t = napi_undefined;
  if (argc > 0) napi_typeof(env, argv[0], &t);
  if (t != napi_function) {
    ThrowCode(env, "ERR_INVALID_ARG", "observe(callback) requires a function");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    ThrowCode(env, "ERR_NOT_MAIN_THREAD", "observe() must run on the main thread");
    return nullptr;
  }
  Teardown();
  napi_value name;
  napi_create_string_utf8(env, "lens.observe", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 1024, 1, nullptr, nullptr,
                                      nullptr, CallJs, &g_tsfn) != napi_ok) {
    ThrowCode(env, "ERR_TSFN", "could not create event channel");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, g_tsfn);

  g_apps = [NSMutableDictionary dictionary];
  g_tokens = [NSMutableArray array];
  NSNotificationCenter *nc = [NSWorkspace sharedWorkspace].notificationCenter;
  NSOperationQueue *main = [NSOperationQueue mainQueue];
  [g_tokens addObject:[nc addObserverForName:NSWorkspaceDidActivateApplicationNotification
                                      object:nil
                                       queue:main
                                  usingBlock:^(NSNotification *n) {
                                    NSRunningApplication *ra =
                                        n.userInfo[NSWorkspaceApplicationKey];
                                    if (!ra || !g_apps) return;
                                    Emit(@"AXApplicationActivated", Ensure(ra), true);
                                  }]];
  [g_tokens addObject:[nc addObserverForName:NSWorkspaceDidLaunchApplicationNotification
                                      object:nil
                                       queue:main
                                  usingBlock:^(NSNotification *n) {
                                    NSRunningApplication *ra =
                                        n.userInfo[NSWorkspaceApplicationKey];
                                    if (ra && g_apps) Ensure(ra);
                                  }]];
  [g_tokens addObject:[nc addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                                      object:nil
                                       queue:main
                                  usingBlock:^(NSNotification *n) {
                                    NSRunningApplication *ra =
                                        n.userInfo[NSWorkspaceApplicationKey];
                                    if (ra && g_apps) [g_apps removeObjectForKey:@(ra.processIdentifier)];
                                  }]];
  bool axObservers = AXIsProcessTrusted();
  for (NSRunningApplication *ra in [NSWorkspace sharedWorkspace].runningApplications) {
    if (ra.activationPolicy == NSApplicationActivationPolicyRegular && !ra.isHidden) Ensure(ra);
  }
  napi_value result;
  napi_create_object(env, &result);
  SetBool(env, result, "accessibilityObservers", axObservers);
  return result;
}

napi_value StopObserving(napi_env env, napi_callback_info) {
  Teardown();
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

}  // namespace lens
