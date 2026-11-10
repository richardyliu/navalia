// Blank window with its own bundle id (dev.navalia.e2e.focus) that activates
// itself on launch. The capture E2E launches one instance per step and counts
// frames whose bundle_id matches, so other apps on the desktop do not interfere.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow?
  func applicationDidFinishLaunching(_ notification: Notification) {
    let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 360, height: 160),
                     styleMask: [.titled], backing: .buffered, defer: false)
    w.title = "Lens E2E focus target"
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window = w
    print("FOCUS_TARGET_READY \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--activate", args.count > 1, let pid = Int32(args[1]) {
      // Hand activation to another app (macOS 14 cooperative activation): this process is
      // active right after launch, so it may activate `pid` on its behalf.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
        var ok = false
        if let target = NSRunningApplication(processIdentifier: pid) {
          if #available(macOS 14.0, *) {
            ok = target.activate(from: NSRunningApplication.current, options: [.activateAllWindows])
          } else {
            ok = target.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
          }
        }
        print("ACTIVATE \(pid) \(ok)")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { NSApp.terminate(nil) }
      }
      return
    }
    let seconds = Double(args.first ?? "6") ?? 6
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
