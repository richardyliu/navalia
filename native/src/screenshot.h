#pragma once

#include <node_api.h>

namespace lens {

// screenshot({ scope?: 'frontmostWindow' (default) | 'display', pid?, maxWidth?, quality? })
//   -> Promise<{ data: Buffer, width, height, mimeType, backend } | null>
// Window scope captures only that window's pixels and never falls back to the
// display. Resolves null when Screen Recording is not granted; never prompts.
napi_value Screenshot(napi_env env, napi_callback_info info);

// probeScreenRecording() -> Promise<{ granted: boolean, displays: number }>
// Uses SCShareableContent, which registers the app with TCC (and may show the
// system prompt). Call only after the user explicitly asked for it.
napi_value ProbeScreenRecording(napi_env env, napi_callback_info info);

}  // namespace lens
