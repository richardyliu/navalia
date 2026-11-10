// AX tree capture core. A line-by-line port of the OSS Runtime's
// resources/mac-ax-helper.swift (personal-model) so that the JSON bytes match
// what `mac-ax-helper` prints. The element source is abstract so the same
// traversal runs against live AXUIElements or a recorded fixture.
#pragma once

#import <Foundation/Foundation.h>
#include <sys/types.h>

#include <memory>
#include <vector>

namespace lens {

struct AXConfig {
  bool allVisible = false;
  NSString *appName = nil;
  bool focusedWindowOnly = false;
  bool raw = false;
  int maxDepth = 100;  // 0 = unlimited
  double timeout = 3;
  int maxValueLength = 1000;
  bool forceAppAccessibility = true;
};

struct RunningApp {
  pid_t pid = 0;
  NSString *localizedName = nil;  // may be nil
  NSString *bundleId = nil;       // may be nil
  NSString *executableName = nil; // executableURL.lastPathComponent, may be nil
  bool regular = false;           // activationPolicy == .regular
};

// Abstract AX element source. Elements are opaque ObjC objects.
class AXSource {
 public:
  virtual ~AXSource() = default;
  // Equivalent of AXUIElementCopyAttributeValue; nil when the call fails.
  virtual id copyValue(id element, NSString *attribute) = 0;
  // Equivalent of AXUIElementCopyAttributeNames; nil when the call fails.
  virtual NSArray *attributeNames(id element) = 0;
  virtual void setManualAccessibility(id appElement) = 0;
  virtual id applicationElement(pid_t pid) = 0;
  virtual bool isElement(id object) = 0;
  virtual bool elementsEqual(id a, id b) = 0;
  // Process-level inputs that main() of the helper reads from NSWorkspace.
  virtual std::vector<RunningApp> runningApps() = 0;
  virtual bool frontmostApp(RunningApp *out) = 0;
  virtual NSDate *now() = 0;
};

enum class AXTreeStatus { ok, noFrontmost, appNotFound, serializeFailed };

struct AXTreeResult {
  AXTreeStatus status = AXTreeStatus::ok;
  NSString *json = nil;  // helper stdout without the trailing newline
};

AXTreeResult CaptureAXTree(AXSource &source, const AXConfig &config);

// Snapshots NSWorkspace state; call on the main thread. The returned source
// may then be used from a worker thread.
std::unique_ptr<AXSource> MakeLiveSource();
// Fixture document format: see native/test-oracle/main.swift (the oracle
// loader) and tests/capture/ax-fixture.test.ts. Returns nullptr and sets
// *error on malformed input.
std::unique_ptr<AXSource> MakeFixtureSource(NSData *json, NSString **error);

}  // namespace lens
