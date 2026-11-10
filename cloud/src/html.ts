// Minimal server-rendered pages for subscribe / confirm / unsubscribe. No JavaScript, no
// external resources; the only inline style block is allowed by its sha256 hash in the CSP.
// Every dynamic value goes through esc().

import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'

export function esc(s: string): string {
  return s.replace(/[&<>"'`=]/g, (c) => `&#${c.charCodeAt(0)};`)
}

const STYLE =
  'body{font-family:-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#222;background:#fff}' +
  'h1{font-size:1.3rem}code{word-break:break-all}input[type=email]{width:100%;padding:.4rem;font-size:1rem;box-sizing:border-box}' +
  'button{margin-top:.8rem;padding:.4rem 1.2rem;font-size:1rem}.muted{color:#666;font-size:.9rem}'

const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64')

export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`

/** `body` must already be escaped HTML. */
export function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body><h1>${esc(title)}</h1>${body}</body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'content-security-policy': PAGE_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY'
  })
  res.end(html)
}

export function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
}

export function shortFingerprint(fp: string): string {
  return `${fp.slice(0, 8)}…${fp.slice(-8)}`
}
