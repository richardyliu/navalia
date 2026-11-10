// navalia-native: N-API entry points. Loaded in the Electron main process
// only, so every TCC grant (Accessibility, Screen Recording) attaches to the
// Lens app itself rather than to a helper executable.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <node_api.h>

#include <memory>
#include <string>

#include "ax_core.h"
#include "browser.h"
#include "napi_util.h"
#include "observe.h"
#include "screenshot.h"

using namespace lens;

namespace {

// MARK: - Options

bool ParseAXConfig(napi_env env, napi_value options, AXConfig *config) {
  if (options == nullptr) return true;
  napi_valuetype t;
  napi_typeof(env, options, &t);
  if (t == napi_undefined || t == napi_null) return true;
  if (t != napi_object) {
    ThrowCode(env, "ERR_INVALID_ARG", "options must be an object");
    return false;
  }
  bool b;
  double d;
  NSString *s;
  if (GetBool(env, options, "allVisible", &b)) config->allVisible = b;
  if (GetBool(env, options, "focusedWindowOnly", &b)) config->focusedWindowOnly = b;
  if (GetBool(env, options, "raw", &b)) config->raw = b;
  if (GetBool(env, options, "forceAppAccessibility", &b)) config->forceAppAccessibility = b;
  if (GetNumber(env, options, "maxDepth", &d)) config->maxDepth = (int)d;
  if (GetNumber(env, options, "timeout", &d)) config->timeout = d;
  if (GetString(env, options, "appName", &s)) config->appName = s;
  return true;
}

const char *StatusCode(AXTreeStatus s) {
  switch (s) {
    case AXTreeStatus::ok:
      return nullptr;
    case AXTreeStatus::noFrontmost:
      return "ERR_NO_FRONTMOST";
    case AXTreeStatus::appNotFound:
      return "ERR_APP_NOT_FOUND";
    case AXTreeStatus::serializeFailed:
      return "ERR_SERIALIZE";
  }
  return "ERR_UNKNOWN";
}

// MARK: - axTree(options?) -> Promise<string>

struct AXTreeWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::unique_ptr<AXSource> source;
  AXConfig config;
  AXTreeResult result;
};

napi_value AXTree(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto *w = new AXTreeWork();
  if (!ParseAXConfig(env, argc > 0 ? argv[0] : nullptr, &w->config)) {
    delete w;
    return nullptr;
  }
  napi_value promise, name;
  napi_create_promise(env, &w->deferred, &promise);
  // The helper exits 2 when untrusted; mirror that as a typed rejection.
  if (!AXIsProcessTrusted()) {
    napi_reject_deferred(env, w->deferred,
                         MakeError(env, "ERR_AX_NOT_TRUSTED",
                                   "Accessibility permission is not granted to this app"));
    delete w;
    return promise;
  }
  @autoreleasepool {
    w->source = MakeLiveSource();  // NSWorkspace snapshot on the main thread
  }
  napi_create_string_utf8(env, "lens.axTree", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *data) {
        auto *w = static_cast<AXTreeWork *>(data);
        @autoreleasepool {
          w->result = CaptureAXTree(*w->source, w->config);
        }
      },
      [](napi_env env, napi_status, void *data) {
        auto *w = static_cast<AXTreeWork *>(data);
        if (w->result.status == AXTreeStatus::ok) {
          napi_resolve_deferred(env, w->deferred, MakeString(env, w->result.json));
        } else {
          napi_reject_deferred(env, w->deferred,
                               MakeError(env, StatusCode(w->result.status), "axTree failed"));
        }
        napi_delete_async_work(env, w->work);
        delete w;
      },
      w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

// _axTreeFromFixture(fixtureJson: string, options?) -> string. Test seam: same
// traversal + serialization as axTree(), fed by a recorded element graph.
napi_value AXTreeFromFixture(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSString *fixture = nil;
  if (argc < 1 || !ValueToString(env, argv[0], &fixture)) {
    ThrowCode(env, "ERR_INVALID_ARG", "fixture JSON string required");
    return nullptr;
  }
  AXConfig config;
  if (!ParseAXConfig(env, argc > 1 ? argv[1] : nullptr, &config)) return nullptr;
  @autoreleasepool {
    NSString *error = nil;
    auto source = MakeFixtureSource([fixture dataUsingEncoding:NSUTF8StringEncoding], &error);
    if (!source) {
      ThrowCode(env, "ERR_FIXTURE", error.UTF8String ?: "bad fixture");
      return nullptr;
    }
    AXTreeResult r = CaptureAXTree(*source, config);
    if (r.status != AXTreeStatus::ok) {
      ThrowCode(env, StatusCode(r.status), "axTree failed");
      return nullptr;
    }
    return MakeString(env, r.json);
  }
}

// MARK: - Permissions

// Non-prompting probe. CGPreflightScreenCaptureAccess does not register the app
// in TCC; SCShareableContent does, so that lives behind probeScreenRecording().
napi_value Permissions(napi_env env, napi_callback_info) {
  napi_value obj;
  napi_create_object(env, &obj);
  SetBool(env, obj, "accessibility", AXIsProcessTrusted());
  SetBool(env, obj, "screenRecording", CGPreflightScreenCaptureAccess());
  return obj;
}

napi_value RequestAccessibility(napi_env env, napi_callback_info) {
  NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
  bool trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
  napi_value v;
  napi_get_boolean(env, trusted, &v);
  return v;
}

napi_value RequestScreenRecording(napi_env env, napi_callback_info) {
  napi_value v;
  napi_get_boolean(env, CGRequestScreenCaptureAccess(), &v);
  return v;
}

// MARK: - frontmost()

napi_value Frontmost(napi_env env, napi_callback_info) {
  @autoreleasepool {
    NSRunningApplication *app = [NSWorkspace sharedWorkspace].frontmostApplication;
    napi_value result;
    if (!app) {
      napi_get_null(env, &result);
      return result;
    }
    napi_create_object(env, &result);
    napi_value pid;
    napi_create_int32(env, app.processIdentifier, &pid);
    napi_set_named_property(env, result, "pid", pid);
    SetStringOrNull(env, result, "name", app.localizedName);
    SetStringOrNull(env, result, "bundleId", app.bundleIdentifier);
    SetStringOrNull(env, result, "bundlePath", app.bundleURL.path);
    NSString *title = nil;
    if (AXIsProcessTrusted()) title = FocusedWindowTitle(app.processIdentifier);
    SetStringOrNull(env, result, "windowTitle", title);
    return result;
  }
}

// selfBundle() -> { bundleId: string | null, bundlePath: string }
// The bundle this process runs from (Navalia.app when packaged, the
// repo's node_modules/electron/dist/Electron.app in dev).
napi_value SelfBundle(napi_env env, napi_callback_info) {
  @autoreleasepool {
    napi_value result;
    napi_create_object(env, &result);
    NSBundle *main = [NSBundle mainBundle];
    SetStringOrNull(env, result, "bundleId", main.bundleIdentifier);
    SetStringOrNull(env, result, "bundlePath", main.bundlePath);
    return result;
  }
}

// MARK: - Module

napi_value Init(napi_env env, napi_value exports) {
  struct Entry {
    const char *name;
    napi_callback fn;
  } entries[] = {
      {"axTree", AXTree},
      {"_axTreeFromFixture", AXTreeFromFixture},
      {"permissions", Permissions},
      {"requestAccessibility", RequestAccessibility},
      {"requestScreenRecording", RequestScreenRecording},
      {"probeScreenRecording", ProbeScreenRecording},
      {"frontmost", Frontmost},
      {"screenshot", Screenshot},
      {"observe", Observe},
      {"stopObserving", StopObserving},
      {"browserUrl", BrowserUrl},
      {"urlHandlers", UrlHandlers},
      {"selfBundle", SelfBundle},
  };
  for (const auto &e : entries) {
    napi_value fn;
    napi_create_function(env, e.name, NAPI_AUTO_LENGTH, e.fn, nullptr, &fn);
    napi_set_named_property(env, exports, e.name, fn);
  }
  return exports;
}

}  // namespace

NAPI_MODULE_INIT() { return Init(env, exports); }
