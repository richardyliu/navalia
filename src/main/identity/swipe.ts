import fs from 'node:fs'
import path from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { LensError } from '../../shared/types'
import { tr } from '../../shared/i18n'
import { CARD_FILE_EXT, verifyCardText, type SignedCard } from './card'
import { encodeQrText, qrToSvg } from './qr'
import { qrPayloadText, type SwipeQr } from './swipe-schema'
import type { CardVerifyView, IssuerStatus } from './api'
import { ipcRunner } from '../ipc-result'

export const SWIPE_CHANNELS = {
  qr: 'lens:swipe:qr',
  export: 'lens:swipe:export',
  importFile: 'lens:swipe:import'
} as const

export const MAX_IMPORT_BYTES = 2_000_000

const Rect = z.object({
  x: z.number().int().min(0).max(20_000),
  y: z.number().int().min(0).max(20_000),
  width: z.number().int().min(1).max(8_000),
  height: z.number().int().min(1).max(8_000)
}).strict()
const ExportArgs = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card') }).strict(),
  z.object({ kind: z.literal('qr') }).strict(),
  z.object({ kind: z.literal('png'), rect: Rect }).strict()
])
const NoArgs = z.undefined()

export interface SwipeDeps {
  latestCard: () => SignedCard | null
  issuerOf: (fingerprint: string) => IssuerStatus
  /** Electron dialog.showSaveDialog / showOpenDialog, injected for tests. */
  saveDialog: (opts: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  openDialog: (opts: { filters: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  /** Capture a region of the calling window as PNG bytes (webContents.capturePage). */
  capture: (event: IpcMainInvokeEvent, rect: z.infer<typeof Rect>) => Promise<Buffer>
  downloadsDir: () => string
}

function toLensError(error: unknown): LensError {
  if (error instanceof z.ZodError) return { code: 'unknown', message: tr(`Invalid arguments: ${error.issues.map((i) => i.message).join('; ')}`, `参数不合法：${error.issues.map((i) => i.message).join('; ')}`) }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

const run = ipcRunner(toLensError)

export function swipeQr(card: SignedCard): SwipeQr {
  const payload = qrPayloadText(card)
  const qr = encodeQrText(payload, 'M')
  return { payload, svg: qrToSvg(qr), version: qr.version, ecc: qr.ecc }
}

/** Export files are public by design (shared with others), so they are written 0644. */
function writePublic(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o644 })
  fs.chmodSync(file, 0o644)
}

export function registerSwipeIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: SwipeDeps): void {
  function requireCard(): SignedCard {
    const card = deps.latestCard()
    if (!card) throw new Error(tr('No Personal Card yet. Create one first.', '还没有个人卡片，请先创建'))
    return card
  }

  ipcMain.handle(SWIPE_CHANNELS.qr, (_e, raw: unknown) =>
    run(() => {
      NoArgs.parse(raw)
      const card = deps.latestCard()
      return card ? swipeQr(card) : null
    })
  )

  ipcMain.handle(SWIPE_CHANNELS.export, (event, raw: unknown) =>
    run(async () => {
      const args = ExportArgs.parse(raw)
      const card = requireCard()
      const base = path.join(deps.downloadsDir(), card.card.card_id)
      if (args.kind === 'card') {
        const file = await deps.saveDialog({ defaultPath: `${base}${CARD_FILE_EXT}`, filters: [{ name: 'Navalia Card', extensions: ['navaliacard'] }] })
        if (!file) return { saved: null }
        writePublic(file, `${JSON.stringify(card, null, 2)}\n`)
        return { saved: file }
      }
      if (args.kind === 'qr') {
        const file = await deps.saveDialog({ defaultPath: `${base}-qr.svg`, filters: [{ name: 'SVG', extensions: ['svg'] }] })
        if (!file) return { saved: null }
        writePublic(file, swipeQr(card).svg)
        return { saved: file }
      }
      const png = await deps.capture(event, args.rect)
      const file = await deps.saveDialog({ defaultPath: `${base}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] })
      if (!file) return { saved: null }
      writePublic(file, png)
      return { saved: file }
    })
  )

  ipcMain.handle(SWIPE_CHANNELS.importFile, (_e, raw: unknown) =>
    run<(CardVerifyView & { file: string }) | null>(async () => {
      NoArgs.parse(raw)
      const file = await deps.openDialog({ filters: [{ name: 'Navalia Card', extensions: ['navaliacard', 'persomecard', 'json'] }] })
      if (!file) return null
      const size = fs.statSync(file).size
      if (size > MAX_IMPORT_BYTES) throw new Error(tr('File is too large to be a card', '文件太大，不像是一张卡片'))
      const result = verifyCardText(fs.readFileSync(file, 'utf8'))
      return result.valid
        ? { valid: true, card: result.card, issuer: deps.issuerOf(result.card.card.issuer.fingerprint), file }
        : { valid: false, reason: result.reason, detail: result.detail, file }
    })
  )
}
