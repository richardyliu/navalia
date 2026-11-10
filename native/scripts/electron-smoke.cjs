// Loads navalia-native.node inside the Electron main process and exercises
// every export that does not need a user grant. Prints one JSON report line.
//   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron native/scripts/electron-smoke.cjs
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, node: process.versions.node, arch: process.arch }
  try {
    const native = require(path.join(__dirname, '..', 'build', 'Release', 'navalia-native.node'))
    report.exports = Object.keys(native).sort()
    report.permissions = native.permissions()
    const front = native.frontmost()
    report.frontmost = front && { hasPid: typeof front.pid === 'number', bundleId: front.bundleId }
    try {
      const json = await native.axTree({ focusedWindowOnly: true, maxDepth: 100, timeout: 3 })
      const parsed = JSON.parse(json)
      report.axTree = { ok: true, apps: parsed.apps.length }
    } catch (e) {
      report.axTree = { ok: false, code: e.code }
    }
    const shot = await native.screenshot({ maxWidth: 640 })
    report.screenshot = shot ? { bytes: shot.data.length, width: shot.width, backend: shot.backend } : null
    const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ax', 'native-notes.input.json'), 'utf8')
    const expected = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ax', 'native-notes.default.expected.json'), 'utf8')
    report.fixtureByteEqual = native._axTreeFromFixture(fixture) + '\n' === expected
    report.observe = native.observe(() => {})
    native.stopObserving()
    report.ok = true
  } catch (e) {
    report.ok = false
    report.error = String(e && e.stack || e)
  }
  console.log('LENS_NATIVE_SMOKE ' + JSON.stringify(report))
  app.quit()
})
