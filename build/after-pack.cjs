// electron-builder afterPack hook (runs before fuses are flipped and the bundle is re-signed).
// Trims the Electron default Info.plist to Lens's real permission surface (CAP-10:
// Accessibility + Screen Recording; S1-FULL C12 adds the microphone for opt-in Meetings, whose
// Lens-specific NSMicrophoneUsageDescription comes from package.json build.mac.extendInfo and is
// therefore NOT removed here) and drops the blanket ATS opt-out.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const REMOVE = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  // Lens only talks to 127.0.0.1; NSAllowsLocalNetworking + the localhost exceptions stay.
  'NSAppTransportSecurity:NSAllowsArbitraryLoads'
]

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const plist = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist')
  for (const key of REMOVE) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'pipe' })
    } catch (error) {
      // "Does Not Exist" is fine (a future Electron may drop the key); anything else is not.
      if (!/Does Not Exist/.test(String(error.stderr ?? error.message))) throw error
    }
  }
}
