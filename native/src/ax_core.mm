// Port of personal-model resources/mac-ax-helper.swift (filtered AX tree ->
// semantic JSON). Function names and control flow intentionally mirror the
// Swift source so a reviewer can diff them side by side. Any behavioural
// change here must be matched by a fixture in native/fixtures/ax and the
// byte-equality test in tests/capture/ax-fixture.test.ts.

#import "ax_core.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <map>
#include <set>
#include <string>
#include <tuple>

namespace lens {
namespace {

// MARK: - Filtered AX Node

NSSet<NSString *> *DropRoles() {
  static NSSet *s = [NSSet setWithArray:@[
    @"AXImage", @"AXScrollBar", @"AXValueIndicator", @"AXSplitter", @"AXColumn", @"AXMenuBar",
    @"AXGrowArea", @"AXRuler", @"AXMatte", @"AXLayoutArea", @"AXLayoutItem"
  ]];
  return s;
}

NSSet<NSString *> *TextBearingRoles() {
  static NSSet *s = [NSSet setWithArray:@[
    @"AXStaticText", @"AXTextField", @"AXTextArea", @"AXLink", @"AXButton", @"AXMenuItem",
    @"AXRadioButton", @"AXCheckBox", @"AXTab", @"AXHeading", @"AXCell", @"AXRow", @"AXWebArea",
    @"AXPopUpButton", @"AXMenuButton", @"AXDisclosureTriangle", @"AXComboBox", @"AXSlider",
    @"AXTabGroup"
  ]];
  return s;
}

NSSet<NSString *> *ContainerRoles() {
  static NSSet *s = [NSSet setWithArray:@[
    @"AXGroup", @"AXSplitGroup", @"AXScrollArea", @"AXList", @"AXOutline", @"AXBrowser",
    @"AXDrawer", @"AXSheet", @"AXToolbar"
  ]];
  return s;
}

NSSet<NSString *> *EditableTextRoles() {
  static NSSet *s =
      [NSSet setWithArray:@[ @"AXTextField", @"AXTextArea", @"AXComboBox", @"AXSearchField" ]];
  return s;
}

const int kPlaceholderScanNodeLimit = 256;
const int kPlaceholderScanDepthLimit = 12;

// MARK: - Swift String semantics

NSString *Trim(NSString *s) {
  return [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

// Swift `String.count`: extended grapheme clusters.
NSUInteger CharacterCount(NSString *s) {
  __block NSUInteger n = 0;
  [s enumerateSubstringsInRange:NSMakeRange(0, s.length)
                        options:NSStringEnumerationByComposedCharacterSequences |
                                NSStringEnumerationSubstringNotRequired
                     usingBlock:^(NSString *, NSRange, NSRange, BOOL *) {
                       n++;
                     }];
  return n;
}

// Swift `String(s.prefix(n))`.
NSString *CharacterPrefix(NSString *s, NSUInteger count) {
  __block NSUInteger seen = 0;
  __block NSUInteger end = 0;
  [s enumerateSubstringsInRange:NSMakeRange(0, s.length)
                        options:NSStringEnumerationByComposedCharacterSequences |
                                NSStringEnumerationSubstringNotRequired
                     usingBlock:^(NSString *, NSRange range, NSRange, BOOL *stop) {
                       if (seen == count) {
                         *stop = YES;
                         return;
                       }
                       seen++;
                       end = NSMaxRange(range);
                     }];
  return [s substringToIndex:end];
}

// Swift `value.split(whereSeparator: \.isWhitespace).map(String.init)`.
NSArray<NSString *> *SplitOnWhitespace(NSString *s) {
  NSMutableArray *parts = [NSMutableArray array];
  NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  __block NSUInteger start = 0;
  __block bool inToken = false;
  [s enumerateSubstringsInRange:NSMakeRange(0, s.length)
                        options:NSStringEnumerationByComposedCharacterSequences
                     usingBlock:^(NSString *cluster, NSRange range, NSRange, BOOL *) {
                       UTF32Char first = 0;
                       [cluster getBytes:&first
                               maxLength:sizeof(first)
                              usedLength:NULL
                                encoding:NSUTF32LittleEndianStringEncoding
                                 options:0
                                   range:NSMakeRange(0, cluster.length)
                          remainingRange:NULL];
                       bool isWhitespace = [ws longCharacterIsMember:first];
                       if (isWhitespace) {
                         if (inToken) {
                           [parts addObject:[s substringWithRange:NSMakeRange(start,
                                                                     range.location - start)]];
                           inToken = false;
                         }
                       } else if (!inToken) {
                         inToken = true;
                         start = range.location;
                       }
                     }];
  if (inToken) [parts addObject:[s substringFromIndex:start]];
  return parts;
}

// Swift `NSNumber as? Bool`: true for CFBoolean, or a number equal to 0 / 1.
bool NumberAsBool(id ref, bool *out) {
  if (![ref isKindOfClass:[NSNumber class]]) return false;
  NSNumber *n = ref;
  if ((__bridge CFTypeRef)n == kCFBooleanTrue || [n isEqualToNumber:@1]) {
    *out = true;
    return true;
  }
  if ((__bridge CFTypeRef)n == kCFBooleanFalse || [n isEqualToNumber:@0]) {
    *out = false;
    return true;
  }
  return false;
}

// MARK: - AX Helpers

class Walker {
 public:
  Walker(AXSource &src, const AXConfig &config) : src_(src), config_(config) {}

  id axValue(id element, NSString *attribute) { return src_.copyValue(element, attribute); }

  NSString *axString(id element, NSString *attribute) {
    id ref = axValue(element, attribute);
    return [ref isKindOfClass:[NSString class]] ? (NSString *)ref : nil;
  }

  NSArray<NSString *> *axStringList(id element, NSString *attribute) {
    id ref = axValue(element, attribute);
    if (ref == nil) return @[];
    if ([ref isKindOfClass:[NSArray class]]) {
      bool allStrings = true;
      for (id v in (NSArray *)ref) {
        if (![v isKindOfClass:[NSString class]]) {
          allStrings = false;
          break;
        }
      }
      if (allStrings) {
        NSMutableArray *out = [NSMutableArray array];
        for (NSString *v in (NSArray *)ref) {
          NSString *t = Trim(v);
          if (t.length > 0) [out addObject:t];
        }
        return out;
      }
    }
    if ([ref isKindOfClass:[NSString class]]) {
      NSMutableArray *out = [NSMutableArray array];
      for (NSString *part in SplitOnWhitespace(ref)) {
        NSString *t = Trim(part);
        if (t.length > 0) [out addObject:t];
      }
      return out;
    }
    return @[];
  }

  bool axBool(id element, NSString *attribute, bool *out) {
    id ref = axValue(element, attribute);
    if (ref == nil) return false;
    return NumberAsBool(ref, out);
  }

  NSArray *axChildren(id element) {
    id ref = axValue(element, (__bridge NSString *)kAXChildrenAttribute);
    if (![ref isKindOfClass:[NSArray class]]) return @[];
    for (id child in (NSArray *)ref) {
      if (!src_.isElement(child)) return @[];
    }
    return ref;
  }

  static NSString *normalizedAXText(NSString *value) { return Trim(value ?: @""); }

  bool hasPlaceholderDOMClass(id element) {
    for (NSString *cls in axStringList(element, @"AXDOMClassList")) {
      if ([[Trim(cls) lowercaseString] isEqualToString:@"placeholder"]) return true;
    }
    return false;
  }

  NSMutableSet<NSString *> *placeholderDescendantTexts(id element) {
    NSMutableSet *result = [NSMutableSet set];
    std::vector<std::tuple<id, int, bool>> pending;
    NSArray *children = axChildren(element);
    for (NSInteger i = (NSInteger)children.count - 1; i >= 0; i--) {
      pending.emplace_back(children[i], 1, false);
    }
    int scanned = 0;
    while (!pending.empty()) {
      auto [current, depth, inheritedPlaceholder] = pending.back();
      pending.pop_back();
      if (scanned >= kPlaceholderScanNodeLimit) break;
      scanned += 1;
      NSString *role = axString(current, (__bridge NSString *)kAXRoleAttribute) ?: @"";
      if ([EditableTextRoles() containsObject:role]) continue;
      bool inPlaceholder = inheritedPlaceholder || hasPlaceholderDOMClass(current);
      if (inPlaceholder) {
        for (NSString *attribute in @[
               (__bridge NSString *)kAXValueAttribute, (__bridge NSString *)kAXTitleAttribute,
               (__bridge NSString *)kAXDescriptionAttribute
             ]) {
          NSString *text = normalizedAXText(axString(current, attribute));
          if (text.length > 0) [result addObject:text];
        }
      }
      if (depth >= kPlaceholderScanDepthLimit) continue;
      NSArray *kids = axChildren(current);
      for (NSInteger i = (NSInteger)kids.count - 1; i >= 0; i--) {
        pending.emplace_back(kids[i], depth + 1, inPlaceholder);
      }
    }
    return result;
  }

  NSSet<NSString *> *confirmedPlaceholderTexts(id element, NSString *role) {
    if (role == nil || ![EditableTextRoles() containsObject:role]) return [NSSet set];
    NSString *standard = normalizedAXText(axString(element, @"AXPlaceholderValue"));
    NSMutableSet *evidence = placeholderDescendantTexts(element);
    if (standard.length > 0) [evidence addObject:standard];
    NSMutableSet *ownText = [NSMutableSet set];
    for (NSString *attribute in @[
           (__bridge NSString *)kAXValueAttribute, (__bridge NSString *)kAXTitleAttribute,
           (__bridge NSString *)kAXDescriptionAttribute
         ]) {
      NSString *t = normalizedAXText(axString(element, attribute));
      if (t.length > 0) [ownText addObject:t];
    }
    NSMutableSet *out = [NSMutableSet set];
    for (NSString *e in evidence) {
      if ([e isEqualToString:standard] || [ownText containsObject:e]) [out addObject:e];
    }
    return out;
  }

  NSArray<NSString *> *axAttributeNames(id element) {
    NSArray *names = src_.attributeNames(element);
    if (names == nil) return @[];
    for (id n in names) {
      if (![n isKindOfClass:[NSString class]]) return @[];
    }
    return [names sortedArrayUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
      return [a compare:b options:NSLiteralSearch];
    }];
  }

  // MARK: - Tree Traversal with Filtering

  struct Node {
    NSString *role = nil;
    NSString *subrole = nil;
    NSString *title = nil;
    NSString *description = nil;
    NSString *value = nil;
    NSString *placeholderValue = nil;
    NSString *identifier = nil;
    NSString *domIdentifier = nil;
    NSArray<NSString *> *domClassList = @[];
    NSArray<NSString *> *attributeNames = @[];
    std::vector<Node> children;

    bool isEmpty() const {
      return subrole == nil && title == nil && description == nil && value == nil &&
             placeholderValue == nil && identifier == nil && domIdentifier == nil &&
             domClassList.count == 0 && attributeNames.count == 0 && children.empty();
    }

    NSDictionary *toDict() const {
      if (isEmpty()) return nil;
      NSMutableDictionary *dict = [NSMutableDictionary dictionary];
      if (role) dict[@"role"] = role;
      if (subrole) dict[@"subrole"] = subrole;
      if (title) dict[@"title"] = title;
      if (description) dict[@"description"] = description;
      if (value) dict[@"value"] = value;
      if (placeholderValue) dict[@"AXPlaceholderValue"] = placeholderValue;
      if (identifier) dict[@"identifier"] = identifier;
      if (domIdentifier) dict[@"domIdentifier"] = domIdentifier;
      if (domClassList.count > 0) dict[@"domClassList"] = domClassList;
      if (attributeNames.count > 0) dict[@"attributeNames"] = attributeNames;
      if (!children.empty()) {
        NSMutableArray *childDicts = [NSMutableArray array];
        for (const Node &c : children) {
          NSDictionary *d = c.toDict();
          if (d) [childDicts addObject:d];
        }
        if (childDicts.count > 0) dict[@"children"] = childDicts;
      }
      if (dict.count == 1 && dict[@"role"] != nil) return nil;
      return dict;
    }
  };

  static NSString *TrimOpt(NSString *s) { return s ? Trim(s) : nil; }

  bool traverseElement(id element, int depth, Node *out) {
    if (config_.maxDepth > 0 && depth > config_.maxDepth) return false;

    NSString *role = axString(element, (__bridge NSString *)kAXRoleAttribute);

    if (!config_.raw && role && [DropRoles() containsObject:role]) return false;

    NSString *subrole = axString(element, (__bridge NSString *)kAXSubroleAttribute);
    bool isSecure =
        [role isEqualToString:@"AXTextField"] && [subrole isEqualToString:@"AXSecureTextField"];
    NSString *rawDescription =
        TrimOpt(axString(element, (__bridge NSString *)kAXDescriptionAttribute));
    NSString *rawIdentifier =
        TrimOpt(axString(element, (__bridge NSString *)kAXIdentifierAttribute));
    NSString *rawDOMIdentifier = TrimOpt(axString(element, @"AXDOMIdentifier"));
    NSArray *domClassList = axStringList(element, @"AXDOMClassList");
    NSArray *attributeNames = config_.raw ? axAttributeNames(element) : @[];
    NSString *rawPlaceholderValue = [EditableTextRoles() containsObject:(role ?: @"")]
                                        ? normalizedAXText(axString(element, @"AXPlaceholderValue"))
                                        : @"";
    NSString *placeholderValue = rawPlaceholderValue.length == 0 ? nil : rawPlaceholderValue;

    NSString *title = TrimOpt(axString(element, (__bridge NSString *)kAXTitleAttribute));
    NSString *value = nil;

    if (isSecure) {
      value = @"[REDACTED]";
    } else {
      NSString *rawValue = axString(element, (__bridge NSString *)kAXValueAttribute);
      if (rawValue) {
        NSString *v = Trim(rawValue);
        if (CharacterCount(v) > (NSUInteger)config_.maxValueLength) {
          v = [CharacterPrefix(v, (NSUInteger)config_.maxValueLength) stringByAppendingString:@"..."];
        }
        if (v.length > 0) value = v;
      }
    }

    if (title && title.length == 0) title = nil;
    NSString *description = (rawDescription && rawDescription.length == 0) ? nil : rawDescription;
    NSString *identifier = (rawIdentifier && rawIdentifier.length == 0) ? nil : rawIdentifier;
    NSString *domIdentifier =
        (rawDOMIdentifier && rawDOMIdentifier.length == 0) ? nil : rawDOMIdentifier;

    if (!config_.raw && [role isEqualToString:@"AXGroup"]) title = nil;

    if (!config_.raw && title == nil && value == nil && ![role isEqualToString:@"AXGroup"]) {
      if (description && description.length > 0) title = description;
    }

    std::vector<Node> childNodes;
    for (id child in axChildren(element)) {
      Node n;
      if (traverseElement(child, depth + 1, &n)) childNodes.push_back(std::move(n));
    }

    bool hasText = title != nil || value != nil;
    bool hasMetadata = subrole != nil || description != nil || placeholderValue != nil ||
                       identifier != nil || domIdentifier != nil || domClassList.count > 0;

    auto make = [&](Node *dst) {
      dst->role = role;
      dst->subrole = subrole;
      dst->title = title;
      dst->description = description;
      dst->value = value;
      dst->placeholderValue = placeholderValue;
      dst->identifier = identifier;
      dst->domIdentifier = domIdentifier;
      dst->domClassList = domClassList;
      dst->attributeNames = attributeNames;
      dst->children = std::move(childNodes);
    };

    if (role && [TextBearingRoles() containsObject:role]) {
      if (hasText || description != nil || placeholderValue != nil || !childNodes.empty()) {
        make(out);
        return true;
      }
      return false;
    }

    if (role && [ContainerRoles() containsObject:role]) {
      if (!config_.raw && !hasText && !hasMetadata) {
        if (childNodes.size() == 1) {
          *out = std::move(childNodes[0]);
          return true;
        }
        if (childNodes.empty()) return false;
      }
      make(out);
      return true;
    }

    if (role && ([role isEqualToString:@"AXWindow"] || [role isEqualToString:@"AXApplication"])) {
      make(out);
      return true;
    }

    if (hasText || hasMetadata || !childNodes.empty()) {
      make(out);
      return true;
    }
    return false;
  }

  // MARK: - Window Processing

  NSMutableDictionary *processWindow(id window) {
    NSString *title = axString(window, (__bridge NSString *)kAXTitleAttribute) ?: @"";
    bool focused = false;
    if (!axBool(window, (__bridge NSString *)kAXFocusedAttribute, &focused)) focused = false;
    NSString *subrole = TrimOpt(axString(window, (__bridge NSString *)kAXSubroleAttribute));
    NSString *description = TrimOpt(axString(window, (__bridge NSString *)kAXDescriptionAttribute));
    NSString *identifier = TrimOpt(axString(window, (__bridge NSString *)kAXIdentifierAttribute));

    NSMutableArray *elements = [NSMutableArray array];
    for (id child in axChildren(window)) {
      Node n;
      if (traverseElement(child, 2, &n)) {
        NSDictionary *d = n.toDict();
        if (d) [elements addObject:d];
      }
    }

    if (title.length == 0 && elements.count == 0) return nil;

    NSMutableDictionary *windowDict = [@{@"title" : title} mutableCopy];
    if (subrole && subrole.length > 0) windowDict[@"subrole"] = subrole;
    if (description && description.length > 0) windowDict[@"description"] = description;
    if (identifier && identifier.length > 0) windowDict[@"identifier"] = identifier;
    if (focused) windowDict[@"focused"] = @YES;
    if (elements.count > 0) windowDict[@"elements"] = elements;
    return windowDict;
  }

  // MARK: - App Processing

  NSDictionary *focusedUIElementDict(id appRef) {
    id el = axValue(appRef, (__bridge NSString *)kAXFocusedUIElementAttribute);
    if (el == nil || !src_.isElement(el)) return nil;

    NSString *role = axString(el, (__bridge NSString *)kAXRoleAttribute) ?: @"";
    if (role.length == 0) return nil;
    NSString *subrole = axString(el, (__bridge NSString *)kAXSubroleAttribute);
    bool isSecure =
        [role isEqualToString:@"AXTextField"] && [subrole isEqualToString:@"AXSecureTextField"];

    NSSet *placeholderTexts = config_.raw ? [NSSet set] : confirmedPlaceholderTexts(el, role);
    NSString *standardPlaceholder = normalizedAXText(axString(el, @"AXPlaceholderValue"));
    NSString *value = @"";
    if (isSecure) {
      value = @"[REDACTED]";
    } else {
      NSString *rawValue = TrimOpt(axString(el, (__bridge NSString *)kAXValueAttribute));
      if (rawValue && rawValue.length > 0 &&
          (config_.raw || ![placeholderTexts containsObject:rawValue])) {
        value = CharacterCount(rawValue) > (NSUInteger)config_.maxValueLength
                    ? [CharacterPrefix(rawValue, (NSUInteger)config_.maxValueLength)
                          stringByAppendingString:@"..."]
                    : rawValue;
      }
    }
    NSString *title = Trim(axString(el, (__bridge NSString *)kAXTitleAttribute) ?: @"");
    NSString *desc = Trim(axString(el, (__bridge NSString *)kAXDescriptionAttribute) ?: @"");
    if (!config_.raw && [placeholderTexts containsObject:title]) title = @"";
    if (!config_.raw && [placeholderTexts containsObject:desc]) desc = @"";

    NSSet *attrs = [NSSet setWithArray:axAttributeNames(el)];
    bool isEditable = [EditableTextRoles() containsObject:role] ||
                      [attrs containsObject:@"AXSelectedTextRange"];
    bool hasSelection = [attrs containsObject:@"AXSelectedTextRange"];

    NSMutableDictionary *dict = [@{@"role" : role} mutableCopy];
    if (subrole && subrole.length > 0) dict[@"subrole"] = subrole;
    if (standardPlaceholder.length > 0) dict[@"AXPlaceholderValue"] = standardPlaceholder;
    if (title.length > 0) dict[@"title"] = title;
    if (desc.length > 0) dict[@"description"] = desc;
    if (value.length > 0) {
      dict[@"value"] = value;
      dict[@"value_length"] = @((NSInteger)CharacterCount(value));
    }
    dict[@"is_editable"] = isEditable ? @YES : @NO;
    if (hasSelection) dict[@"has_selection"] = @YES;
    return dict;
  }

  NSDictionary *processApp(pid_t pid, NSString *name, NSString *bundleID, bool isFrontmost) {
    id appRef = src_.applicationElement(pid);
    if (appRef == nil) return nil;

    if (config_.forceAppAccessibility) src_.setManualAccessibility(appRef);

    id focusedElement = axValue(appRef, (__bridge NSString *)kAXFocusedWindowAttribute);
    if (focusedElement != nil && !src_.isElement(focusedElement)) focusedElement = nil;

    // Children read on a background queue with a timeout, as in the helper.
    __block id childrenRef = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    AXSource *src = &src_;
    id app = appRef;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      id value = src->copyValue(app, (__bridge NSString *)kAXChildrenAttribute);
      childrenRef = value;
      dispatch_semaphore_signal(semaphore);
    });
    bool timedOut =
        dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW,
                                                         (int64_t)(config_.timeout * NSEC_PER_SEC))) != 0;

    NSMutableArray *windowDicts = [NSMutableArray array];

    NSArray *children = nil;
    if (!timedOut && [childrenRef isKindOfClass:[NSArray class]]) {
      children = childrenRef;
      for (id c in children) {
        if (!src_.isElement(c)) {
          children = nil;
          break;
        }
      }
    }

    if (children) {
      bool foundFocused = false;
      for (id child in children) {
        NSString *role = axString(child, (__bridge NSString *)kAXRoleAttribute);
        if (![role isEqualToString:@"AXWindow"]) continue;
        bool isFocusedWindow = focusedElement != nil && src_.elementsEqual(child, focusedElement);
        if (config_.focusedWindowOnly && !isFocusedWindow) continue;
        NSMutableDictionary *dict = processWindow(child);
        if (dict) {
          if (isFocusedWindow) {
            dict[@"focused"] = @YES;
            foundFocused = true;
          }
          [windowDicts addObject:dict];
        }
      }
      if (config_.focusedWindowOnly && !foundFocused && windowDicts.count == 0) {
        for (id child in children) {
          NSString *role = axString(child, (__bridge NSString *)kAXRoleAttribute);
          if (![role isEqualToString:@"AXWindow"]) continue;
          NSMutableDictionary *dict = processWindow(child);
          if (dict) {
            [windowDicts addObject:dict];
            break;
          }
        }
      }
    }

    if (windowDicts.count == 0) return nil;

    NSMutableDictionary *appDict = [@{
      @"pid" : @((int32_t)pid),
      @"name" : name,
      @"is_frontmost" : isFrontmost ? @YES : @NO,
    } mutableCopy];
    if (bundleID) appDict[@"bundle_id"] = bundleID;
    appDict[@"windows"] = windowDicts;
    NSDictionary *fe = focusedUIElementDict(appRef);
    if (fe) appDict[@"focused_element"] = fe;
    return appDict;
  }

 private:
  AXSource &src_;
  const AXConfig &config_;
};

// MARK: - Live source (AXUIElement + NSWorkspace)

class LiveSource final : public AXSource {
 public:
  id copyValue(id element, NSString *attribute) override {
    CFTypeRef ref = nullptr;
    AXError err = AXUIElementCopyAttributeValue((__bridge AXUIElementRef)element,
                                                (__bridge CFStringRef)attribute, &ref);
    if (err != kAXErrorSuccess || ref == nullptr) {
      if (ref) CFRelease(ref);
      return nil;
    }
    return CFBridgingRelease(ref);
  }
  NSArray *attributeNames(id element) override {
    CFArrayRef names = nullptr;
    AXError err = AXUIElementCopyAttributeNames((__bridge AXUIElementRef)element, &names);
    if (err != kAXErrorSuccess || names == nullptr) {
      if (names) CFRelease(names);
      return nil;
    }
    return CFBridgingRelease(names);
  }
  void setManualAccessibility(id appElement) override {
    AXUIElementSetAttributeValue((__bridge AXUIElementRef)appElement,
                                 CFSTR("AXManualAccessibility"), kCFBooleanTrue);
  }
  id applicationElement(pid_t pid) override {
    return CFBridgingRelease(AXUIElementCreateApplication(pid));
  }
  bool isElement(id object) override {
    return object != nil && CFGetTypeID((__bridge CFTypeRef)object) == AXUIElementGetTypeID();
  }
  bool elementsEqual(id a, id b) override {
    return CFEqual((__bridge CFTypeRef)a, (__bridge CFTypeRef)b);
  }
  LiveSource() {
    for (NSRunningApplication *app in [NSWorkspace sharedWorkspace].runningApplications) {
      apps_.push_back(Convert(app));
    }
    NSRunningApplication *front = [NSWorkspace sharedWorkspace].frontmostApplication;
    if (front) {
      haveFront_ = true;
      front_ = Convert(front);
    }
  }
  std::vector<RunningApp> runningApps() override { return apps_; }
  bool frontmostApp(RunningApp *out) override {
    if (!haveFront_) return false;
    *out = front_;
    return true;
  }
  NSDate *now() override { return [NSDate date]; }

 private:
  static RunningApp Convert(NSRunningApplication *app) {
    RunningApp r;
    r.pid = app.processIdentifier;
    r.localizedName = app.localizedName;
    r.bundleId = app.bundleIdentifier;
    r.executableName = app.executableURL.lastPathComponent;
    r.regular = app.activationPolicy == NSApplicationActivationPolicyRegular;
    return r;
  }

  std::vector<RunningApp> apps_;
  bool haveFront_ = false;
  RunningApp front_;
};

}  // namespace
}  // namespace lens

@interface LensFixtureElement : NSObject
@property(nonatomic, strong) NSMutableDictionary<NSString *, id> *attrs;
@end
@implementation LensFixtureElement
@end

namespace lens {

// MARK: - Fixture source

namespace {

class FixtureSource final : public AXSource {
 public:
  bool load(NSData *data, NSString **error) {
    NSError *err = nil;
    id doc = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
    if (![doc isKindOfClass:[NSDictionary class]]) {
      *error = err ? err.localizedDescription : @"fixture root must be an object";
      return false;
    }
    NSString *ts = doc[@"timestamp"];
    NSISO8601DateFormatter *f = [[NSISO8601DateFormatter alloc] init];
    f.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    now_ = [ts isKindOfClass:[NSString class]] ? [f dateFromString:ts] : nil;
    if (!now_) {
      *error = @"fixture.timestamp must be an RFC 3339 UTC string";
      return false;
    }
    NSNumber *front = doc[@"frontmostPid"];
    frontmostPid_ = [front isKindOfClass:[NSNumber class]] ? front.intValue : -1;
    ids_ = [NSMutableDictionary dictionary];
    pending_ = [NSMutableArray array];
    NSArray *apps = doc[@"apps"];
    if (![apps isKindOfClass:[NSArray class]]) {
      *error = @"fixture.apps must be an array";
      return false;
    }
    for (NSDictionary *a in apps) {
      RunningApp r;
      r.pid = [a[@"pid"] intValue];
      r.localizedName = Str(a[@"localizedName"]);
      r.bundleId = Str(a[@"bundleId"]);
      r.executableName = Str(a[@"executable"]);
      r.regular = [a[@"regular"] boolValue];
      apps_.push_back(r);
      if (a[@"element"]) {
        LensFixtureElement *el = Build(a[@"element"]);
        if (!el) {
          *error = [NSString stringWithFormat:@"app %d: bad element", r.pid];
          return false;
        }
        elements_[r.pid] = el;
      }
    }
    // Resolve {"$ref": id} placeholders now that every node exists.
    for (NSArray *slot in pending_) {
      NSMutableDictionary *attrs = slot[0];
      NSString *key = slot[1];
      NSString *ref = slot[2];
      id target = ids_[ref];
      if (!target) {
        *error = [NSString stringWithFormat:@"unresolved $ref %@", ref];
        return false;
      }
      attrs[key] = target;
    }
    return true;
  }

  id copyValue(id element, NSString *attribute) override {
    return ((LensFixtureElement *)element).attrs[attribute];
  }
  NSArray *attributeNames(id element) override {
    return ((LensFixtureElement *)element).attrs.allKeys;
  }
  void setManualAccessibility(id) override {}
  id applicationElement(pid_t pid) override {
    auto it = elements_.find(pid);
    return it == elements_.end() ? nil : it->second;
  }
  bool isElement(id object) override { return [object isKindOfClass:[LensFixtureElement class]]; }
  bool elementsEqual(id a, id b) override { return a == b; }
  std::vector<RunningApp> runningApps() override { return apps_; }
  bool frontmostApp(RunningApp *out) override {
    for (const auto &a : apps_) {
      if (a.pid == frontmostPid_) {
        *out = a;
        return true;
      }
    }
    return false;
  }
  NSDate *now() override { return now_; }

 private:
  static NSString *Str(id v) { return [v isKindOfClass:[NSString class]] ? v : nil; }

  static bool IsNode(id v) {
    return [v isKindOfClass:[NSDictionary class]] && [v[@"attrs"] isKindOfClass:[NSDictionary class]];
  }

  LensFixtureElement *Build(NSDictionary *node) {
    if (!IsNode(node)) return nil;
    LensFixtureElement *el = [[LensFixtureElement alloc] init];
    el.attrs = [NSMutableDictionary dictionary];
    if ([node[@"id"] isKindOfClass:[NSString class]]) ids_[node[@"id"]] = el;
    NSDictionary *attrs = node[@"attrs"];
    for (NSString *key in attrs) {
      id v = attrs[key];
      if ([v isKindOfClass:[NSDictionary class]] && [v[@"$ref"] isKindOfClass:[NSString class]]) {
        [pending_ addObject:@[ el.attrs, key, v[@"$ref"] ]];
        el.attrs[key] = [NSNull null];
      } else if (IsNode(v)) {
        LensFixtureElement *child = Build(v);
        if (!child) return nil;
        el.attrs[key] = child;
      } else if ([v isKindOfClass:[NSArray class]] && [(NSArray *)v count] > 0 &&
                 IsNode([(NSArray *)v firstObject])) {
        NSMutableArray *kids = [NSMutableArray array];
        for (id k in (NSArray *)v) {
          LensFixtureElement *child = Build(k);
          if (!child) return nil;
          [kids addObject:child];
        }
        el.attrs[key] = kids;
      } else {
        el.attrs[key] = v;
      }
    }
    return el;
  }

  NSDate *now_ = nil;
  pid_t frontmostPid_ = -1;
  std::vector<RunningApp> apps_;
  std::map<pid_t, LensFixtureElement *> elements_;
  NSMutableDictionary<NSString *, LensFixtureElement *> *ids_ = nil;
  NSMutableArray *pending_ = nil;
};

}  // namespace

// MARK: - Main (selection + serialization, as in the helper's main())

AXTreeResult CaptureAXTree(AXSource &source, const AXConfig &config) {
  AXTreeResult result;
  Walker walker(source, config);
  std::vector<RunningApp> runningApps = source.runningApps();
  RunningApp frontmost;
  bool haveFrontmost = source.frontmostApp(&frontmost);
  pid_t frontmostPID = haveFrontmost ? frontmost.pid : -1;

  NSMutableArray *appDicts = [NSMutableArray array];

  if (config.appName) {
    NSString *targetLower = [config.appName lowercaseString];
    const RunningApp *match = nullptr;
    for (const auto &app : runningApps) {
      NSString *localized = [(app.localizedName ?: @"") lowercaseString];
      NSString *process = [(app.executableName ?: @"") lowercaseString];
      NSString *bundle = [(app.bundleId ?: @"") lowercaseString];
      if ([localized isEqualToString:targetLower] || [process isEqualToString:targetLower] ||
          [bundle isEqualToString:targetLower] ||
          [bundle hasSuffix:[@"." stringByAppendingString:targetLower]]) {
        match = &app;
        break;
      }
    }
    if (!match) {
      result.status = AXTreeStatus::appNotFound;
      return result;
    }
    NSDictionary *dict = walker.processApp(match->pid, match->localizedName ?: @"Unknown",
                                           match->bundleId, match->pid == frontmostPID);
    if (dict) [appDicts addObject:dict];
  } else if (config.allVisible) {
    for (const auto &app : runningApps) {
      if (!app.regular) continue;
      NSDictionary *dict = walker.processApp(app.pid, app.localizedName ?: @"Unknown", app.bundleId,
                                             app.pid == frontmostPID);
      if (dict) [appDicts addObject:dict];
    }
  } else {
    if (!haveFrontmost) {
      result.status = AXTreeStatus::noFrontmost;
      return result;
    }
    NSDictionary *dict = walker.processApp(frontmost.pid, frontmost.localizedName ?: @"Unknown",
                                           frontmost.bundleId, true);
    if (dict) [appDicts addObject:dict];
  }

  NSISO8601DateFormatter *iso = [[NSISO8601DateFormatter alloc] init];
  iso.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  NSDictionary *output = @{@"timestamp" : [iso stringFromDate:source.now()], @"apps" : appDicts};

  NSError *err = nil;
  NSData *data = [NSJSONSerialization
      dataWithJSONObject:output
                 options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                   error:&err];
  NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
  if (!json) {
    result.status = AXTreeStatus::serializeFailed;
    return result;
  }
  result.json = json;
  return result;
}

std::unique_ptr<AXSource> MakeLiveSource() { return std::make_unique<LiveSource>(); }

std::unique_ptr<AXSource> MakeFixtureSource(NSData *json, NSString **error) {
  auto src = std::make_unique<FixtureSource>();
  NSString *err = nil;
  if (!src->load(json, &err)) {
    if (error) *error = err;
    return nullptr;
  }
  return src;
}

}  // namespace lens
