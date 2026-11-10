#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <deque>

#include "browser.h"
#include "napi_util.h"

namespace lens {
namespace {

const int kMaxNodes = 4000;
const int kMaxDepth = 40;

id Copy(AXUIElementRef el, CFStringRef attr) {
  CFTypeRef ref = nullptr;
  if (AXUIElementCopyAttributeValue(el, attr, &ref) != kAXErrorSuccess || !ref) return nil;
  return CFBridgingRelease(ref);
}

bool IsElement(id obj) {
  return obj && CFGetTypeID((__bridge CFTypeRef)obj) == AXUIElementGetTypeID();
}

NSString *UrlString(id value) {
  if ([value isKindOfClass:[NSURL class]]) return [(NSURL *)value absoluteString];
  if ([value isKindOfClass:[NSString class]]) return value;
  return nil;
}

// Breadth-first: the top-level web area of the focused window is the page;
// nested web areas (iframes) sit deeper.
NSString *FindWebAreaURL(AXUIElementRef window) {
  std::deque<std::pair<id, int>> queue;
  queue.emplace_back((__bridge id)window, 0);
  int visited = 0;
  while (!queue.empty() && visited < kMaxNodes) {
    auto [node, depth] = queue.front();
    queue.pop_front();
    visited++;
    AXUIElementRef el = (__bridge AXUIElementRef)node;
    NSString *role = Copy(el, kAXRoleAttribute);
    if ([role isEqualToString:@"AXWebArea"]) {
      NSString *url = UrlString(Copy(el, CFSTR("AXURL")));
      if (url.length > 0) return url;
    }
    if (depth >= kMaxDepth) continue;
    id children = Copy(el, kAXChildrenAttribute);
    if (![children isKindOfClass:[NSArray class]]) continue;
    for (id child in (NSArray *)children) {
      if (IsElement(child)) queue.emplace_back(child, depth + 1);
    }
  }
  return nil;
}

}  // namespace

napi_value BrowserUrl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  napi_get_null(env, &result);
  if (!AXIsProcessTrusted()) return result;
  @autoreleasepool {
    pid_t pid = 0;
    napi_valuetype t = napi_undefined;
    if (argc > 0) napi_typeof(env, argv[0], &t);
    if (t == napi_number) {
      int32_t v = 0;
      napi_get_value_int32(env, argv[0], &v);
      pid = v;
    } else {
      NSRunningApplication *front = [NSWorkspace sharedWorkspace].frontmostApplication;
      pid = front ? front.processIdentifier : 0;
    }
    if (pid <= 0) return result;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    id window = Copy(app, kAXFocusedWindowAttribute);
    CFRelease(app);
    if (!IsElement(window)) return result;
    NSString *url = FindWebAreaURL((__bridge AXUIElementRef)window);
    if (url) result = MakeString(env, url);
    return result;
  }
}

napi_value UrlHandlers(napi_env env, napi_callback_info) {
  napi_value arr;
  napi_create_array(env, &arr);
  @autoreleasepool {
    NSMutableOrderedSet *ids = [NSMutableOrderedSet orderedSet];
    if (@available(macOS 12.0, *)) {
      for (NSString *scheme in @[ @"https", @"http" ]) {
        NSURL *probe = [NSURL URLWithString:[scheme stringByAppendingString:@"://example.com"]];
        for (NSURL *appURL in [[NSWorkspace sharedWorkspace] URLsForApplicationsToOpenURL:probe]) {
          NSString *bid = [NSBundle bundleWithURL:appURL].bundleIdentifier;
          if (bid.length > 0) [ids addObject:bid];
        }
      }
    }
    uint32_t i = 0;
    for (NSString *bid in ids) napi_set_element(env, arr, i++, MakeString(env, bid));
  }
  return arr;
}

}  // namespace lens
