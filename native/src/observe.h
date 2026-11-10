#pragma once

#import <Foundation/Foundation.h>
#include <node_api.h>
#include <sys/types.h>

namespace lens {

// observe((event) => void): NSWorkspace activation events always; AXObserver
// focused-window / title / value notifications for regular apps when
// Accessibility is trusted. Events are delivered on the JS thread.
napi_value Observe(napi_env env, napi_callback_info info);
napi_value StopObserving(napi_env env, napi_callback_info info);

NSString *FocusedWindowTitle(pid_t pid);

}  // namespace lens
