import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, safeStorage, session, shell, systemPreferences, type WebContents } from 'electron'
import { registerCaptureIpc } from './capture/ipc'
import { createCaptureService } from './capture/service'
import { callMcpTool, closeMcp, readBudget, registerIpc } from './ipc'
import { registerI18nIpc } from './i18n/ipc'
import { createAskSaveService, registerAskSaveIpc } from './mcp/save-answer'
import { knownRuntimeSecrets } from './mcp/known-secrets'
import {
  APP_INDEX_URL,
  handleAppProtocol,
  installIpcSenderGuard,
  installSessionPermissionHandlers,
  isAppUrl,
  nativeConfirm,
  setQuickBoxSenderCheck,
  refuseDebugSwitchesWhenPackaged,
  stripTestOverridesWhenPackaged,
  registerAppScheme,
  safeOpenExternal
} from './security'
import { registerIdentityIpc } from './identity/ipc'
import { registerSwipeIpc } from './identity/swipe'
import { createKeyManager } from './identity/keys'
import { createSafeStorageBox } from './identity/secret-box'
import { STORE_ROOT_ENV, ensureStore, resolveStoreRoot, storePaths } from './store/paths'
import { findLegacySource, legacyAppRunning, legacyStoreRoot, legacyUserDataDir, migrateLegacyStore } from './store/rename-migration'
import { locate } from './runtime/paths'
import { readLocalToken, readScreenshotKey } from './runtime/token'
import { RuntimeClient } from './runtime/client'
import { setupBrokerPlane } from './broker/main'
import { PersomeMcp } from './mcp/client'
import { registerHetIpc } from './het/ipc'
import { createHetService } from './het/service'
import { createAgentFundingTransport } from './het/agentFundingTransport'
import { createHetRestRouter } from './het/rest'
import os from 'node:os'
import type { S1Deps } from './s1/deps'
import { registerWorkflowsIpc } from './workflows/ipc'
import { registerImportIpc } from './import/ipc'
import { registerLibraryIpc } from './library/ipc'
import { registerPeersIpc } from './peers/ipc'
import { registerOnboardingIpc } from './onboarding/ipc'
import { registerBackupIpc } from './backup/ipc'
import { registerConnectorsIpc } from './connectors/ipc'
import { registerCloudIpc } from './cloud/ipc'
import { registerChatIpc } from './cloud/chat-ipc'
import { registerSubsIpc } from './cloud/subs-ipc'
import { registerMomentsIpc } from './cloud/moments-ipc'
import { registerMeetingsIpc } from './cloud/meetings-ipc'
import { createMicArm } from './cloud/meetings-mic-gate'
import { setupPerformance } from './performance/main'
import { createProactiveEventBus } from './proactive/events'
import { registerRewindIpc } from './rewind/ipc'
import { registerRecoveryIpc } from './recovery/ipc'
import { setupPrivacyPlane } from './privacy/main'
import { setupShell } from './shell/main'
import { isQuickBoxWindow } from './shell/quickbox'
import { trackWindowBackgrounds, windowBackground } from './shell/theme'
import { setupProactive } from './proactive/main'
import { tr } from '../shared/i18n'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

function createWindow(): BrowserWindow {
  trackWindowBackgrounds()
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Navalia',
    backgroundColor: windowBackground(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Only the app document itself; a dropped or linked local file must never load (it would get the preload).
    if (isAppUrl(url)) return
    event.preventDefault()
  })

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void window.loadURL(APP_INDEX_URL)
  }

  const screenshotPath = process.env.LENS_SCREENSHOT
  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // Packaged builds only capture the first page: scripted navigation/clicks are dev-only.
          const page = app.isPackaged ? undefined : process.env.LENS_SCREENSHOT_PAGE
          // Screenshot page -> nav id. Selected by data-page, so adding nav items never shifts indices.
          const NAV_FOR_PAGE: Record<string, string> = {
            model: 'model', evidence: 'model', 'correct-open': 'model',
            search: 'search', 'search-query': 'search', 'remember-open': 'search',
            playbook: 'playbook', 'playbook-open': 'playbook',
            capture: 'capture', 'capture-frames': 'capture',
            card: 'card', 'card-create': 'card', 'card-back': 'card', 'card-reset-open': 'card',
            swipe: 'swipe', 'swipe-export': 'swipe', 'swipe-import': 'swipe', 'swipe-drop': 'swipe',
            het: 'het', 'het-evidence': 'het',
            connections: 'connections', 'connections-connect': 'connections', 'connections-log-open': 'connections',
            'connections-ext-open': 'connections', 'connections-clear-open': 'connections',
            settings: 'settings',
            chat: 'chat',
            subscriptions: 'subscriptions',
            meetings: 'meetings',
            performance: 'performance'
          }
          const navId = page ? NAV_FOR_PAGE[page] : undefined
          if (navId) {
            const clicked = await window.webContents.executeJavaScript(
              `(() => { const b = document.querySelector('.nav-item[data-page="${navId}"]'); if (!b) return 'missing'; b.click(); return b.textContent; })()`
            )
            console.log('[lens] screenshot nav:', navId, clicked)
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
          if (page === 'capture-frames') {
            await window.webContents.executeJavaScript(
              `document.querySelector('.capture-frames, .capture-per-app')?.scrollIntoView({ block: 'start' })`
            )
            await new Promise((resolve) => setTimeout(resolve, 600))
          }
          if (page === 'connections-connect') {
            await window.webContents.executeJavaScript(`document.querySelector('.conn-connect')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
          if (page === 'connections-log-open') {
            await window.webContents.executeJavaScript(`document.querySelector('.conn-day-head')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 500))
            await window.webContents.executeJavaScript(`document.querySelector('.conn-row')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 500))
            await window.webContents.executeJavaScript(`document.querySelector('.conn-logcard')?.scrollIntoView()`)
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          if (page === 'connections-ext-open') {
            await window.webContents.executeJavaScript(`document.querySelector('.conn-logcard')?.previousElementSibling?.querySelector('.card-foot button')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 700))
          }
          if (page === 'connections-clear-open') {
            await window.webContents.executeJavaScript(`document.querySelector('.conn-clear')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 700))
          }
          if (page === 'swipe-export') {
            for (const sel of ['.swipe-export-card', '.swipe-export-png', '.swipe-export-qr']) {
              await window.webContents.executeJavaScript(`document.querySelector('${sel}')?.click()`)
              await new Promise((resolve) => setTimeout(resolve, 1200))
            }
            await window.webContents.executeJavaScript(`window.scrollTo(0, 0); document.querySelector('.main')?.scrollTo(0, 0)`)
            await new Promise((resolve) => setTimeout(resolve, 400))
          }
          if (page === 'swipe-import' || page === 'swipe-drop') {
            const qrText = process.env.LENS_SCREENSHOT_QR_TEXT ?? ''
            if (page === 'swipe-import') {
              await window.webContents.executeJavaScript(`document.querySelector('.swipe-open')?.click()`)
            } else {
              // Synthetic drop on the element: proves the window-level guard does not swallow it.
              const text = fs.readFileSync(process.env.LENS_SCREENSHOT_IMPORT_FILE ?? '', 'utf8')
              const got = await window.webContents.executeJavaScript(`(() => {
                const el = document.querySelector('.swipe-drop'); if (!el) return 'no-drop-zone';
                const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'dropped.navaliacard'));
                const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
                el.dispatchEvent(ev); return 'dispatched defaultPrevented=' + ev.defaultPrevented })()`)
              console.log('[lens] swipe drop:', got)
            }
            await new Promise((resolve) => setTimeout(resolve, 1500))
            if (qrText) {
              await window.webContents.executeJavaScript(`(() => { const t = document.querySelector('.swipe-qr-input textarea'); if (!t) return;
                const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                set.call(t, ${JSON.stringify(qrText)}); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
            await window.webContents.executeJavaScript(`document.querySelector('.swipe-import')?.scrollIntoView()`)
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          if (page === 'card-create') {
            await window.webContents.executeJavaScript(`document.querySelector('.pcard-create')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 4000))
          }
          if (page === 'card-back') {
            await window.webContents.executeJavaScript(`document.querySelector('.pcard-flip')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 1200))
          }
          if (page === 'card-reset-open') {
            await window.webContents.executeJavaScript(`document.querySelector('.pcard-reset')?.click()`)
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
          if (page === 'het' || page === 'het-evidence') {
            // The first HET tick over real transcripts can take ~10 s.
            await new Promise((resolve) => setTimeout(resolve, Number(process.env.LENS_SCREENSHOT_WAIT_MS ?? 15000)))
            const range = await window.webContents.executeJavaScript(
              `(() => { const b = document.querySelectorAll('.het-page .seg-btn')[2]; if (!b) return 'missing'; b.click(); return b.textContent; })()`
            )
            console.log('[lens] het range:', range)
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
          if (page === 'het-evidence') {
            const opened = await window.webContents.executeJavaScript(
              `(() => { const r = document.querySelectorAll('.het-row')[1]; if (!r) return 'missing'; r.click(); return 'clicked'; })()`
            )
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const rows = await window.webContents.executeJavaScript(`document.querySelectorAll('.het-evidence-list li').length`)
            console.log('[lens] het evidence:', opened, rows)
          }
          if (page === 'start') {
            await window.webContents.executeJavaScript(
              `document.querySelector('.banner button.btn.primary')?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 8000))
          }
          if (page === 'search-query') {
            await window.webContents.executeJavaScript(
              `document.querySelectorAll('.seg-btn')[0]?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 500))
            const submitted = await window.webContents.executeJavaScript(
              `(() => {
                const input = document.querySelector('.search-input');
                if (!input) return 'no-input';
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, 'Navalia');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector('.search-row .btn.primary')?.click();
                return 'submitted';
              })()`
            )
            console.log('[lens] search submit:', submitted)
            await new Promise((resolve) => setTimeout(resolve, 2500))
          }
          if (page === 'remember-open') {
            await window.webContents.executeJavaScript(
              `document.querySelector('.page-actions button')?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
          if (page === 'correct-open') {
            await window.webContents.executeJavaScript(
              `document.querySelector('tbody tr')?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 1200))
            await window.webContents.executeJavaScript(
              `document.querySelector('.drawer-head-actions .btn')?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
          if (page === 'evidence') {
            await window.webContents.executeJavaScript(
              `document.querySelector('tbody tr')?.click()`
            )
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
          const image = await window.webContents.capturePage()
          fs.writeFileSync(screenshotPath, image.toPNG())
          console.log(`[lens] screenshot written to ${screenshotPath}`)
        } catch (error) {
          console.error('[lens] screenshot failed', error)
        } finally {
          app.quit()
        }
      }, 3500)
    })
  }

  return window
}

/**
 * First launch after a rename (Grapple, or the older Persome Lens → Navalia): move the old Lens
 * Store over and re-seal its safeStorage secrets under the new Keychain key. False → the app is
 * quitting (old app still running, or the migration failed and must be retried on the next launch).
 */
function runRenameMigration(): boolean {
  if (process.env[STORE_ROOT_ENV]?.trim()) return true // explicit store (tests / dev): never migrate
  const newRoot = resolveStoreRoot()
  if (fs.existsSync(newRoot)) return true
  const source = findLegacySource()
  if (!source) return true
  const legacyRoot = legacyStoreRoot(source)
  const old = source.label
  const stop = (message: string, detail: string): false => {
    dialog.showMessageBoxSync({ type: 'warning', message, detail, buttons: [tr('Quit', '退出')] })
    app.quit()
    return false
  }
  if (legacyAppRunning(legacyUserDataDir(source))) {
    return stop(
      tr(`Quit ${old} first`, `请先退出 ${old}`),
      tr(
        `On first launch Navalia moves over the ${old} data. Moving it while the old app is still running gives an incomplete database. Quit ${old} (menu bar → Quit), then open Navalia again.`,
        `Navalia 第一次启动要把 ${old} 的数据搬过来。旧版还在运行时搬会得到不完整的数据库。退出 ${old}（菜单栏 → 退出）后再打开 Navalia。`
      )
    )
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return stop(
      tr('System encryption (safeStorage) is unavailable', '系统加密（safeStorage）不可用'),
      tr(`Can't safely migrate the ${old} identity key. Open Navalia again later.`, `无法安全地迁移 ${old} 的身份密钥。请稍后重新打开 Navalia。`)
    )
  }
  const result = migrateLegacyStore({
    source,
    legacyRoot,
    newRoot,
    readLegacyPassword: () => {
      try {
        // macOS asks once whether Navalia may read the old “<name> Safe Storage” item.
        return execFileSync('/usr/bin/security', ['find-generic-password', '-s', source.keychainService, '-a', source.keychainAccount, '-w'], {
          encoding: 'utf8',
          timeout: 120_000
        }).replace(/\n$/, '')
      } catch {
        return null
      }
    },
    encryptString: (plain) => safeStorage.encryptString(plain)
  })
  if (result.status === 'failed') {
    console.error('[navalia] rename migration failed:', result.reason)
    const detail =
      result.reason === 'keychain_denied'
        ? tr(
            `Navalia needs to read the old “${source.keychainService}” keychain item to move the identity key. Next time you open Navalia, click "Allow" in the system prompt. The old data was not changed.`,
            `需要读取钥匙串里旧的 “${source.keychainService}” 才能把身份密钥搬过来。下次打开 Navalia 时请在系统弹窗里点「允许」。旧数据没有被改动。`
          )
        : tr(
            `Migration did not finish. The old data was not changed; it will retry on next launch. (${result.reason})`,
            `迁移没有完成，旧数据没有被改动，下次打开会重试。（${result.reason}）`
          )
    return stop(tr(`Couldn't migrate the ${old} data`, `没能迁移 ${old} 的数据`), detail)
  }
  if (result.status === 'migrated') console.log(`[navalia] migrated ${old} store; resealed ${result.resealed.length} file(s)`)
  return true
}

refuseDebugSwitchesWhenPackaged()
stripTestOverridesWhenPackaged()
registerAppScheme()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // OG-04: skip the Quick Box panel; reveal a main window hidden by "keep resident".
    const [window] = BrowserWindow.getAllWindows().filter((w) => !isQuickBoxWindow(w))
    if (window) {
      if (window.isMinimized()) window.restore()
      if (!window.isVisible()) window.show()
      window.focus()
    }
  })

  app.whenReady().then(() => {
    app.setName('Navalia')
    if (!runRenameMigration()) return
    handleAppProtocol()
    // OG1: deny web permissions (clipboard read, media, display capture, devices) before any window loads.
    // S1-FULL C12: one arming state shared by the permission handlers and the meetings service.
    const meetingMicArm = createMicArm()
    installSessionPermissionHandlers(session.defaultSession, { micArmed: () => meetingMicArm.isArmed() })
    installIpcSenderGuard()
    // OG8: Quick Box senders are limited to their own channel allowlist.
    setQuickBoxSenderCheck((event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return Boolean(win && isQuickBoxWindow(win))
    })
    registerIpc({
      // S1-R3-SEC M2: RememberDialog and Quick Box both go through this main-owned confirm.
      confirmRemember: (summary, sender) =>
        nativeConfirm(sender as WebContents | null, {
          message: tr('Save this to Persome memory?', '把这条内容写入 Persome 记忆？'),
          detail: tr(
            `${summary.chars} chars, ${summary.redactions} likely-sensitive item(s) redacted${summary.tags ? `, tags: ${summary.tags}` : ''}. Once saved, other connected Agents can read it too. Will save (redacted):\n\n${summary.excerpt}`,
            `${summary.chars} 字，已隐藏 ${summary.redactions} 处疑似敏感信息${summary.tags ? `，标签：${summary.tags}` : ''}。写入后其他连接的 Agent 也能读到。将写入（脱敏后）：\n\n${summary.excerpt}`
          ),
          confirmLabel: tr('Save', '写入')
        }),
      knownSecrets: () => knownRuntimeSecrets(locate().root)
    })
    // S1-R3-09 「把回答保存到记忆」: preview redacts in main; save needs a main-owned native confirm.
    registerAskSaveIpc(
      ipcMain,
      createAskSaveService({
        callTool: callMcpTool,
        confirm: (summary, sender) =>
          nativeConfirm(sender as WebContents | null, {
            message: tr('Save this answer to Persome memory?', '把这条回答保存到 Persome 记忆？'),
            detail: tr(
              `${summary.chars} chars, ${summary.redactions} likely-sensitive item(s) redacted. Once saved, other connected Agents can read it too. Beginning:\n\n${summary.excerpt}`,
              `${summary.chars} 字，已隐藏 ${summary.redactions} 处疑似敏感信息。保存后其他连接的 Agent 也能读到。开头：\n\n${summary.excerpt}`
            ),
            confirmLabel: tr('Save', '保存')
          }),
        // S1-R3-SEC L6: every Runtime env secret value, not only the local token.
        knownSecrets: () => knownRuntimeSecrets(locate().root)
      })
    )

    // Identity Plane: must run after `ready`, safeStorage is unavailable before then.
    const lensStore = ensureStore(storePaths(resolveStoreRoot()))
    // UI language: load `<LensStore>/locale.json` before any window or tray text is built.
    registerI18nIpc(ipcMain, lensStore.root)
    const keyBox = createSafeStorageBox(safeStorage)
    const identityKeys = createKeyManager(lensStore, keyBox)
    const identityService = registerIdentityIpc(ipcMain, {
      paths: lensStore,
      keys: identityKeys,
      box: keyBox,
      getShareCard: () => {
        const loc = locate()
        return new RuntimeClient(loc.port, readLocalToken(loc.root)).shareCard()
      },
      getGraph: () => {
        const loc = locate()
        return new RuntimeClient(loc.port, readLocalToken(loc.root)).modelGraph()
      },
      // Runtime 2026-11-05.3 owner-alias review. Confirm / reject are user decisions: a main-owned
      // native dialog parented to the sender's window (Cancel default) must say yes first.
      ownerAliases: {
        client: () => {
          const loc = locate()
          return new RuntimeClient(loc.port, readLocalToken(loc.root))
        },
        confirmDecision: (decision, alias, sender) =>
          nativeConfirm(sender as WebContents | null, {
            message:
              decision === 'confirm'
                ? tr(`Confirm “${alias.slice(0, 160)}” is your own name or account?`, `确认“${alias.slice(0, 160)}”是你自己的名字或账号？`)
                : tr(`Confirm “${alias.slice(0, 160)}” is not you?`, `确认“${alias.slice(0, 160)}”不是你？`),
            detail:
              decision === 'confirm'
                ? tr(
                    'Persome will then treat this name as you (resolved to self). You can undo it later with persome alias reject.',
                    '确认后 Persome 会把这个名字当作你本人（解析到 self）。之后可以用 persome alias reject 撤回。'
                  )
                : tr(
                    'On-screen evidence will no longer suggest it as your alias. You can change it back later with persome alias confirm.',
                    '拒绝后屏幕上的证据不会再把它提议为你的别名。之后可以用 persome alias confirm 改回。'
                  ),
            confirmLabel: decision === 'confirm' ? tr("It's me", '是我') : tr('Not me', '不是我')
          })
      },
      // Security review #9: the destructive confirmation is a native dialog owned by main.
      confirmReset: async () => {
        const opts = {
          type: 'warning' as const,
          buttons: [tr('Cancel', '取消'), tr('Reset identity', '重置身份')],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: tr('Reset identity?', '重置身份？'),
          detail: tr(
            'This generates a new Ed25519 key and deletes the current private key. Cards already sent will show as “signed by an old key”. This cannot be undone.',
            '会生成新的 Ed25519 密钥并删除当前私钥。已发出的卡片会显示为“旧密钥签名”。此操作不能撤销。'
          )
        }
        const win = BrowserWindow.getFocusedWindow()
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
        return response === 1
      }
    })
    app.on('will-quit', () => identityKeys.lock())

    // Swipe export / import. Dialogs live in main. Screenshot runs (LENS_SCREENSHOT set) may
    // pre-answer the dialogs via LENS_SCREENSHOT_SAVE_DIR / LENS_SCREENSHOT_IMPORT_FILE.
    // Dev/test only: never let env vars bypass a user dialog in a packaged build.
    const dialogHooks = Boolean(process.env.LENS_SCREENSHOT) && !app.isPackaged
    const shotSaveDir = dialogHooks ? process.env.LENS_SCREENSHOT_SAVE_DIR : undefined
    const shotImport = dialogHooks ? process.env.LENS_SCREENSHOT_IMPORT_FILE : undefined
    registerSwipeIpc(ipcMain, {
      latestCard: () => identityService.latest()?.signed ?? null,
      issuerOf: (fp) => identityService.issuerOf(fp),
      saveDialog: async (opts) => {
        if (shotSaveDir) return path.join(shotSaveDir, path.basename(opts.defaultPath))
        const win = BrowserWindow.getFocusedWindow()
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        return r.canceled || !r.filePath ? null : r.filePath
      },
      openDialog: async (opts) => {
        if (shotImport) return shotImport
        const win = BrowserWindow.getFocusedWindow()
        const o = { ...opts, properties: ['openFile' as const] }
        const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o)
        return r.canceled ? null : (r.filePaths[0] ?? null)
      },
      capture: async (event, rect) => (await event.sender.capturePage(rect)).toPNG(),
      downloadsDir: () => app.getPath('downloads')
    })

    // Broker (127.0.0.1:8750) + Connections + Access log. All Runtime reads stay in main.
    let brokerMcp: PersomeMcp | null = null
    const brokerTool = async (name: string, args: Record<string, unknown>) => {
      const loc = locate()
      if (!loc.bin) throw new Error('persome binary not found')
      if (!brokerMcp || brokerMcp.key !== `${loc.bin}|${loc.root}`) {
        brokerMcp?.close()
        brokerMcp = new PersomeMcp(loc.bin, loc.root)
      }
      return brokerMcp.callTool(name, args)
    }
    const brokerPlane = setupBrokerPlane(ipcMain, {
      port: !app.isPackaged && process.env.LENS_BROKER_PORT ? Number(process.env.LENS_BROKER_PORT) : undefined,
      paths: lensStore,
      latestCard: () => identityService.latest()?.signed ?? null,
      // Full access (user decision 2026-11-04): every OSS tool, one stdio call each, no retries.
      ossTool: (name, args) => brokerTool(name, args),
      runtimeRoot: () => locate().root,
      // Read fresh per call; main only, never logged, never sent over IPC.
      screenshotKey: () => readScreenshotKey(locate().root),
      budget: () => readBudget(),
      copyToClipboard: (text) => clipboard.writeText(text),
      // OG-08: HET REST (/het/*) on this loopback server; `het` is created below (lazy getter).
      rest: [createHetRestRouter({ service: () => het })]
    })
    app.on('will-quit', () => {
      brokerMcp?.close()
      void brokerPlane.stop()
    })
    // OG-05 Rewind: same reader + key source as the Broker; decrypts one screenshot per view, in main only.
    registerRewindIpc(ipcMain, { runtimeRoot: () => locate().root, screenshotKey: () => readScreenshotKey(locate().root) })

    // Capture Plane: inert unless Runtime config has [capture] source = "ingest".
    const capture = createCaptureService({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      storeRoot: lensStore.root,
      locate: () => {
        const loc = locate()
        return { root: loc.root, port: loc.port }
      },
      getToken: (root) => readLocalToken(root),
      lockSource: powerMonitor,
      selfPid: process.pid,
      allowNativeEnvOverride: !app.isPackaged
    })
    registerCaptureIpc(ipcMain, capture, {
      dialog,
      openExternal: (url) => shell.openExternal(url),
      // Used only to scrub the token from the diagnostics text inside main; never returned.
      knownSecrets: (root) => knownRuntimeSecrets(root)
    })
    // OG-06 Recovery: aggregated health + runtime start/restart/doctor; destructive ops behind main-issued nonce.
    registerRecoveryIpc(ipcMain, {
      locate,
      storeRoot: lensStore.root,
      captureStatus: () => capture.status(),
      brokerStatus: () => brokerPlane.status(),
      copyToClipboard: (text) => clipboard.writeText(text),
      appVersion: () => app.getVersion()
    })
    const captureStatus = capture.status()
    console.info(
      '[capture]',
      captureStatus.started ? `started${captureStatus.degraded ? ' (degraded)' : ''}` : `inactive: ${captureStatus.reason}`
    )
    app.on('will-quit', () => capture.stop())

    // OG-04 menu bar Tray / global shortcut / Quick Box: every toggle opt-in (default off), local only.
    const desktopShell = setupShell({ storeRoot: lensStore.root, createMainWindow: createWindow, capture })

    // Performance Plane (HET): ledger in the Lens Store; tick on startup + every 5 min.
    // X3 (DECISIONS-ROUND4 R4-1): the assessor transport is the Runtime's own `[agent_funding]`
    // path (`<root>/venv/bin/python` + fixed script → persome.writer.agent_cli.complete), so it
    // shares the Runtime's fcntl-locked daily_call_limit. It runs only when ALL hold: the user
    // turned on 「允许评估」 (het-settings.json assessorEnabled, default false), the venv python
    // exists, and readBudget() says enabled && !exhausted. HET perTick/perDay caps apply on top.
    // Never spawns claude/codex directly; never uses the cloud chat endpoint.
    const hetTransport = createAgentFundingTransport({
      runtimeRoot: () => locate().root,
      log: (msg) => console.log(msg)
    })
    const het = createHetService({
      dbFile: lensStore.hetDb,
      settingsFile: path.join(lensStore.root, 'het-settings.json'),
      transport: hetTransport,
      budget: () => {
        if (!hetTransport.available()) return { available: false, reason: 'runtime_python_missing' }
        const b = readBudget()
        return b.enabled && !b.exhausted ? { available: true } : { available: false, reason: !b.enabled ? 'not_enabled' : 'exhausted' }
      },
      assessorMeta: () => {
        const b = readBudget()
        const m = hetTransport.meta()
        return {
          client: m.client ?? (b.client || null),
          model: m.model,
          runtimePythonPresent: hetTransport.available(),
          budget: { enabled: b.enabled, used: b.used, limit: b.limit, remaining: b.remaining, exhausted: b.exhausted, date: b.date, reset_at: b.resetAt }
        }
      },
      // Fixture minutes only into an explicit temp store, never the real default Lens Store (security review S1 #7b).
      allowFakeAssessor: !app.isPackaged && Boolean(process.env.LENS_STORE_ROOT?.trim()),
      log: (msg) => console.log(msg)
    })
    registerHetIpc(ipcMain, {
      service: het,
      // X3: turning ON 「发送摘要给 assessor」 needs this main-owned native confirm.
      confirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts),
      chooseExportPath: async (defaultName) => {
        const e2eSaveDir = !app.isPackaged ? process.env.LENS_E2E_SAVE_DIR?.trim() : undefined
        if (e2eSaveDir) return path.join(e2eSaveDir, path.basename(defaultName))
        const opts = {
          title: 'Export Weekly Review',
          defaultPath: path.join(app.getPath('documents'), defaultName),
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        }
        const parent = BrowserWindow.getFocusedWindow()
        const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
        return r.canceled || !r.filePath ? null : r.filePath
      }
    })
    het.start()
    let hetStopped = false
    app.on('before-quit', (event) => {
      if (hetStopped) return
      event.preventDefault()
      hetStopped = true
      // Defer: a microtask app.quit() re-enters the native quit that emitted before-quit and is lost (R3).
      void Promise.race([het.stop(), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() =>
        setImmediate(() => app.quit())
      )
    })

    // S1 features (Workflow/Skills, history import, Library/brief). Lead-owned wiring; each
    // feature registers its own `lens:<feature>:*` channels with zod validation.
    const s1Deps: S1Deps = {
      // S1-R3-SEC L5: connectors commit / backup restore also need a main-owned native confirm.
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts),
      storeRoot: lensStore.root,
      runtimeRoot: () => locate().root,
      persomeBin: () => locate().bin ?? null,
      runtime: () => {
        const loc = locate()
        return new RuntimeClient(loc.port, readLocalToken(loc.root))
      },
      ossTool: (name, args) => brokerTool(name, args),
      // Unpackaged test builds may point transcript discovery at a fixture home.
      homeDir: () => (!app.isPackaged && process.env.LENS_IMPORT_HOME?.trim()) || os.homedir(),
      saveDialog: async (opts) => {
        const e2eSaveDir = !app.isPackaged ? process.env.LENS_E2E_SAVE_DIR?.trim() : undefined
        if (e2eSaveDir) return path.join(e2eSaveDir, path.basename(opts.defaultPath))
        const parent = BrowserWindow.getFocusedWindow()
        const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
        return r.canceled || !r.filePath ? null : r.filePath
      },
      openDialog: async (opts) => {
        // E2E (unpackaged only): a fixture file instead of the native dialog.
        const e2eOpenFile = !app.isPackaged ? process.env.LENS_E2E_OPEN_FILE?.trim() : undefined
        if (e2eOpenFile) return e2eOpenFile
        const o = { ...opts, properties: ['openFile' as const] }
        const parent = BrowserWindow.getFocusedWindow()
        const r = parent ? await dialog.showOpenDialog(parent, o) : await dialog.showOpenDialog(o)
        return r.canceled ? null : (r.filePaths[0] ?? null)
      },
      // S1-10: same KeyManager that signs Cards; used read-only to sign .navaliaskill exports.
      identityKeys,
      // S2: directory picker (backup / restore / subscription folder).
      openDirectoryDialog: async (opts) => {
        const e2eDir = !app.isPackaged ? process.env.LENS_E2E_PICK_DIR?.trim() : undefined
        if (e2eDir) return e2eDir
        const props: Array<'openDirectory' | 'createDirectory'> = ['openDirectory']
        if (opts.createDirectory) props.push('createDirectory')
        const o = { title: opts.title, properties: props }
        const parent = BrowserWindow.getFocusedWindow()
        const r = parent ? await dialog.showOpenDialog(parent, o) : await dialog.showOpenDialog(o)
        return r.canceled ? null : (r.filePaths[0] ?? null)
      }
    }
    registerImportIpc(ipcMain, s1Deps)
    registerLibraryIpc(ipcMain, s1Deps)
    // S1-R4-06 X2: the opt-in subscription scan timer (off by default) is cleared on quit.
    const peersService = registerPeersIpc(ipcMain, s1Deps)
    app.on('will-quit', () => peersService.scheduler.stop())
    registerOnboardingIpc(ipcMain, s1Deps)
    registerBackupIpc(ipcMain, s1Deps)
    // S1-FULL C19: IMAP credentials are stored as SecretBox ciphertext (same safeStorage box as the identity key).
    registerConnectorsIpc(ipcMain, s1Deps, { secretBox: keyBox })
    // S1-FULL C2: opt-in cloud client (default OFF; zero network while OFF). Token encrypted with the
    // identity key box; signing goes through KeyManager (the private key never leaves keys.ts).
    const cloudService = registerCloudIpc(ipcMain, {
      storeRoot: lensStore.root,
      box: keyBox,
      sign: (msg) => identityKeys.sign(msg),
      getPublicIdentity: () => identityKeys.getPublicIdentity(),
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts),
      // Gate fix 3: http://127.0.0.1 / localhost servers only in unpackaged (dev) builds.
      allowInsecureLoopback: !app.isPackaged
    })
    // S1-FULL C15: workflows get the cloud service for opt-in session extraction (task workflow_extract).
    registerWorkflowsIpc(ipcMain, s1Deps, { cloud: cloudService, knownSecrets: () => knownRuntimeSecrets(locate().root) })
    // S1-FULL C3–C7 Lens Chat: context preview from the local Runtime, streaming via the cloud client,
    // conversations in <LensStore>/chat (0600), 「记住这条」 via MCP remember after a native confirm.
    registerChatIpc(ipcMain, {
      storeRoot: lensStore.root,
      cloud: cloudService,
      ossTool: s1Deps.ossTool,
      runtime: s1Deps.runtime,
      knownSecrets: () => knownRuntimeSecrets(locate().root),
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts)
    })
    // S1-FULL C8/C10: cloud cards + weekly-letter subscriptions (signed in main; friends' cards/letters verified offline).
    registerSubsIpc(ipcMain, {
      storeRoot: lensStore.root,
      cloud: cloudService,
      getPublicIdentity: () => identityKeys.getPublicIdentity(),
      sign: (msg) => identityKeys.sign(msg),
      ossTool: s1Deps.ossTool,
      knownSecrets: () => knownRuntimeSecrets(locate().root),
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts)
    })
    // S1-FULL C17: typed event bus for event-based proactive triggers (publishers: meetings, moments).
    const proactiveBus = createProactiveEventBus()
    // S1-FULL C16 「表现」: owner-only counts + user projects. het.db is read-only here.
    const performance = setupPerformance(ipcMain, {
      storeRoot: lensStore.root,
      hetDbFile: lensStore.hetDb,
      homeDir: s1Deps.homeDir,
      ossTool: s1Deps.ossTool,
      openDirectoryDialog: s1Deps.openDirectoryDialog
    })
    // S1-FULL C18: shared moments (two-party signed; server relays; verified offline on every read).
    registerMomentsIpc(ipcMain, {
      storeRoot: lensStore.root,
      cloud: cloudService,
      getPublicIdentity: () => identityKeys.getPublicIdentity(),
      sign: (msg) => identityKeys.sign(msg),
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts),
      onMomentAccepted: (id, items) => void proactiveBus.publish({ type: 'peers.moment_accepted', id, items })
    })
    // S1-FULL C12–C14 Meetings: consent + native confirm + mic access, chunk upload, transcript, import via persome CLI.
    const meetingsService = registerMeetingsIpc(ipcMain, {
      storeRoot: lensStore.root,
      cloud: cloudService,
      micArm: meetingMicArm,
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts),
      askForMediaAccess: async (media) => (process.platform === 'darwin' ? systemPreferences.askForMediaAccess(media) : true),
      runtimeRoot: () => locate().root,
      persomeBin: () => locate().bin ?? null,
      ossTool: s1Deps.ossTool,
      runtime: s1Deps.runtime,
      knownSecrets: () => knownRuntimeSecrets(locate().root),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onTranscriptReady: (id, items) => void proactiveBus.publish({ type: 'meeting.transcript_ready', id, items })
    })
    app.on('will-quit', () => meetingsService.dispose())
    // OG-09 Settings / Privacy: retention (read-only), delete via Runtime CLI + nonce, withdraw, updates BLOCKED.
    setupPrivacyPlane(ipcMain, {
      paths: lensStore,
      s1: s1Deps,
      brokerUrl: () => brokerPlane.status().url,
      appVersion: () => app.getVersion(),
      // OG3: delete / withdraw also need a native dialog answered in main, parented to the sender's window.
      nativeConfirm: (sender, opts) => nativeConfirm(sender as WebContents | null, opts)
    })

    desktopShell.attachMainWindow(createWindow())

    // S1-R4-05 X9 local notifications: opt-in (all off by default), no network, no LLM. The timer
    // exists only while the master switch is on; a click only opens a Lens page.
    const proactive = setupProactive(ipcMain, {
      storeRoot: lensStore.root,
      runtime: s1Deps.runtime,
      captureStatus: () => capture.status(),
      ossTool: s1Deps.ossTool,
      openPage: (page) => desktopShell.openPage(page),
      hasWindow: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !isQuickBoxWindow(w)),
      // S1-FULL C17: meetings / performance are QuickOpenPage ids now.
      openRoute: (page) => desktopShell.openPage(page),
      bus: proactiveBus,
      reservedAccelerators: () => {
        const st = desktopShell.state().settings
        return st.shortcutEnabled ? [st.shortcutAccelerator] : []
      },
      lastWeek: (now, tz) => performance.lastWeekSample(now, tz)
    })
    desktopShell.setExtraTrayMenu(
      () => proactive.trayItems().map((i) => (i.kind === 'action' ? { ...i, enabled: true } : i)),
      (id) => void proactive.trayAction(id)
    )

    // OG-04: creates a main window if none (Quick Box does not count), or shows a hidden one.
    app.on('activate', () => desktopShell.onActivate())
  })

  app.on('window-all-closed', () => {
    closeMcp()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => closeMcp())
}
