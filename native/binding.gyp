{
  "targets": [
    {
      "target_name": "navalia-native",
      "sources": [
        "src/addon.mm",
        "src/ax_core.mm",
        "src/screenshot.mm",
        "src/observe.mm",
        "src/browser.mm"
      ],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc", "-Wall", "-Wno-unused-parameter"],
            "OTHER_LDFLAGS": ["-weak_framework", "ScreenCaptureKit"]
          },
          "link_settings": {
            "libraries": [
              "-framework AppKit",
              "-framework ApplicationServices",
              "-framework CoreGraphics",
              "-framework Foundation",
              "-framework ImageIO"
            ]
          }
        }]
      ]
    }
  ]
}
