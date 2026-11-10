#pragma once

#include <node_api.h>

namespace lens {

// browserUrl(pid?) -> string | null
// URL of the web page in the focused window of `pid` (default: frontmost app),
// read from the AXURL attribute of its AXWebArea. Uses Accessibility only:
// no Apple Events, so no Automation (TCC) prompt per browser.
napi_value BrowserUrl(napi_env env, napi_callback_info info);

// urlHandlers() -> string[]
// Bundle ids registered with LaunchServices to open http/https URLs (the
// in-process equivalent of the OSS mac-url-handlers helper). No permission.
napi_value UrlHandlers(napi_env env, napi_callback_info info);

}  // namespace lens
