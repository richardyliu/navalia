// Fixture-backed stand-ins for the AX C API, used only to compile the OSS
// mac-ax-helper.swift into a test oracle. build-oracle.sh rebinds the helper's
// AXUIElement* calls to these symbols; the helper's filtering, traversal and
// serialization code is compiled unmodified.
import ApplicationServices
import Foundation

final class FakeEl: NSObject {
    var attrs: [String: AnyObject] = [:]
}

@discardableResult
func FakeAXUIElementCopyAttributeValue(
    _ element: FakeEl, _ attribute: CFString, _ value: UnsafeMutablePointer<CFTypeRef?>
) -> AXError {
    guard let v = element.attrs[attribute as String] else { return .attributeUnsupported }
    value.pointee = v
    return .success
}

@discardableResult
func FakeAXUIElementCopyAttributeNames(
    _ element: FakeEl, _ names: UnsafeMutablePointer<CFArray?>
) -> AXError {
    names.pointee = Array(element.attrs.keys) as CFArray
    return .success
}

@discardableResult
func FakeAXUIElementSetAttributeValue(
    _ element: FakeEl, _ attribute: CFString, _ value: CFTypeRef
) -> AXError {
    return .success
}

var fakeApplicationElements: [pid_t: FakeEl] = [:]

func FakeAXUIElementCreateApplication(_ pid: pid_t) -> FakeEl {
    return fakeApplicationElements[pid] ?? FakeEl()
}

func FakeCFEqual(_ a: FakeEl, _ b: FakeEl) -> Bool {
    return a === b
}
