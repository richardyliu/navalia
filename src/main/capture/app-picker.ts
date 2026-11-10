import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tr } from '../../shared/i18n'

export interface AppBundleInfo {
  path: string
  bundleId: string
  name: string
}

/**
 * Read CFBundleIdentifier / display name from `<app>/Contents/Info.plist`.
 * plutil handles both XML and binary plists and ships with macOS.
 */
export function readAppBundleInfo(appPath: string): AppBundleInfo {
  const resolved = path.resolve(appPath)
  if (!resolved.endsWith('.app') || !fs.statSync(resolved).isDirectory()) {
    throw new Error(tr('Choose a .app application', '请选择一个 .app 应用'))
  }
  const plist = path.join(resolved, 'Contents', 'Info.plist')
  if (!fs.existsSync(plist)) throw new Error(tr('This app has no Info.plist', '该应用缺少 Info.plist'))
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024
  })
  const info = JSON.parse(json) as Record<string, unknown>
  const bundleId = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier.trim() : ''
  if (!bundleId) throw new Error(tr('Info.plist has no CFBundleIdentifier', 'Info.plist 中没有 CFBundleIdentifier'))
  const pick = (k: string): string => (typeof info[k] === 'string' ? (info[k] as string).trim() : '')
  const name = pick('CFBundleDisplayName') || pick('CFBundleName') || path.basename(resolved, '.app')
  return { path: resolved, bundleId, name }
}

/** Minimal slice of Electron's dialog used by the picker (NSOpenPanel on macOS). */
export interface OpenDialog {
  showOpenDialog(options: {
    title?: string
    defaultPath?: string
    properties: Array<'openFile' | 'treatPackageAsDirectory'>
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ canceled: boolean; filePaths: string[] }>
}

export async function pickApp(dialog: OpenDialog): Promise<AppBundleInfo | null> {
  const result = await dialog.showOpenDialog({
    title: tr('Choose an app to exclude', '选择要排除的应用'),
    defaultPath: '/Applications',
    properties: ['openFile'],
    filters: [{ name: 'Applications', extensions: ['app'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readAppBundleInfo(result.filePaths[0])
}
