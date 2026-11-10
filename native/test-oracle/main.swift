// Oracle entry point: loads a fixture (LENS_AX_FIXTURE), then performs the same
// app selection and output serialization as the helper's main(), calling the
// helper's own processApp(). Flags are parsed by the helper's parseArgs().
import Foundation

struct FixtureApp {
    let pid: pid_t
    let localizedName: String?
    let bundleId: String?
    let executable: String?
    let regular: Bool
}

var idTable: [String: FakeEl] = [:]
var pendingRefs: [(FakeEl, String, String)] = []

func isNode(_ v: Any) -> Bool {
    guard let d = v as? [String: Any] else { return false }
    return d["attrs"] is [String: Any]
}

func build(_ node: [String: Any]) -> FakeEl {
    let el = FakeEl()
    if let id = node["id"] as? String { idTable[id] = el }
    let attrs = node["attrs"] as! [String: Any]
    for (key, v) in attrs {
        if let d = v as? [String: Any], let ref = d["$ref"] as? String {
            pendingRefs.append((el, key, ref))
        } else if isNode(v) {
            el.attrs[key] = build(v as! [String: Any])
        } else if let arr = v as? [Any], let first = arr.first, isNode(first) {
            el.attrs[key] = arr.map { build($0 as! [String: Any]) } as NSArray
        } else {
            el.attrs[key] = v as AnyObject
        }
    }
    return el
}

guard let fixturePath = ProcessInfo.processInfo.environment["LENS_AX_FIXTURE"] else {
    fputs("LENS_AX_FIXTURE not set\n", stderr)
    exit(1)
}
let fixtureData = try! Data(contentsOf: URL(fileURLWithPath: fixturePath))
let doc = try! JSONSerialization.jsonObject(with: fixtureData) as! [String: Any]

var fixtureApps: [FixtureApp] = []
for a in doc["apps"] as! [[String: Any]] {
    let app = FixtureApp(
        pid: pid_t((a["pid"] as! NSNumber).int32Value),
        localizedName: a["localizedName"] as? String,
        bundleId: a["bundleId"] as? String,
        executable: a["executable"] as? String,
        regular: (a["regular"] as? Bool) ?? false
    )
    fixtureApps.append(app)
    if let element = a["element"] as? [String: Any] {
        fakeApplicationElements[app.pid] = build(element)
    }
}
for (el, key, ref) in pendingRefs {
    guard let target = idTable[ref] else {
        fputs("unresolved $ref \(ref)\n", stderr)
        exit(1)
    }
    el.attrs[key] = target
}

let parser = ISO8601DateFormatter()
parser.formatOptions = [.withInternetDateTime]
let fixtureNow = parser.date(from: doc["timestamp"] as! String)!
let frontmostPID: pid_t = (doc["frontmostPid"] as? NSNumber).map { pid_t($0.int32Value) } ?? -1
let frontmostApp = fixtureApps.first { $0.pid == frontmostPID }

let config = parseArgs()
var appDicts: [[String: Any]] = []

if let targetName = config.appName {
    let targetLower = targetName.lowercased()
    guard let app = fixtureApps.first(where: { runApp in
        let localized = (runApp.localizedName ?? "").lowercased()
        let process = (runApp.executable ?? "").lowercased()
        let bundle = (runApp.bundleId ?? "").lowercased()
        return localized == targetLower
            || process == targetLower
            || bundle == targetLower
            || bundle.hasSuffix(".\(targetLower)")
    }) else {
        fputs("No running app matching '\(targetName)' found.\n", stderr)
        exit(1)
    }
    if let dict = processApp(
        pid: app.pid, name: app.localizedName ?? "Unknown", bundleID: app.bundleId,
        isFrontmost: app.pid == frontmostPID, config: config)
    {
        appDicts.append(dict)
    }
} else if config.allVisible {
    for app in fixtureApps {
        guard app.regular else { continue }
        if let dict = processApp(
            pid: app.pid, name: app.localizedName ?? "Unknown", bundleID: app.bundleId,
            isFrontmost: app.pid == frontmostPID, config: config)
        {
            appDicts.append(dict)
        }
    }
} else {
    guard let app = frontmostApp else {
        fputs("No frontmost application found.\n", stderr)
        exit(1)
    }
    if let dict = processApp(
        pid: app.pid, name: app.localizedName ?? "Unknown", bundleID: app.bundleId,
        isFrontmost: true, config: config)
    {
        appDicts.append(dict)
    }
}

// Output block identical to the helper's main(), with the fixture clock.
let iso8601Formatter = ISO8601DateFormatter()
iso8601Formatter.formatOptions = [.withInternetDateTime]
let output: [String: Any] = [
    "timestamp": iso8601Formatter.string(from: fixtureNow),
    "apps": appDicts,
]
guard let jsonData = try? JSONSerialization.data(
    withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
else {
    fputs("Failed to serialize JSON output.\n", stderr)
    exit(1)
}
if let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
}
