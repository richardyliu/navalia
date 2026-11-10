import net from 'node:net'
import tls from 'node:tls'
import { ImapError } from './protocol'
import { tr } from '../../../shared/i18n'

/**
 * C19 IMAP transport: implicit TLS only (IMAPS, default port 993). There is deliberately no plain
 * TCP path and no STARTTLS: a server that does not complete a TLS handshake with a certificate valid
 * for the host name (system trust store, TLS ≥ 1.2) is never sent a byte of IMAP.
 *
 * `ca` exists only so tests can trust a self-signed loopback certificate; certificate verification
 * itself is never disabled.
 */

export interface TlsTarget {
  host: string
  port: number
  timeoutMs: number
  /** Extra trusted CA (tests). Verification stays on. */
  ca?: string | Buffer
}

export type ImapConnect = (t: TlsTarget) => Promise<tls.TLSSocket>

export const connectImapTls: ImapConnect = (t) =>
  new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: t.host,
      port: t.port,
      servername: net.isIP(t.host) ? undefined : t.host,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(t.ca ? { ca: t.ca } : {})
    })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new ImapError('timeout', tr(`Connecting to ${t.host}:${t.port} timed out (TLS handshake did not finish).`, `连接 ${t.host}:${t.port} 超时（TLS 握手没有完成）。`)))
    }, t.timeoutMs)
    sock.once('secureConnect', () => {
      clearTimeout(timer)
      if (!sock.authorized) {
        sock.destroy()
        reject(new ImapError('tls', tr(`Invalid server certificate: ${String(sock.authorizationError ?? 'unknown reason')}`, `服务器证书无效：${String(sock.authorizationError ?? '未知原因')}`)))
        return
      }
      resolve(sock)
    })
    sock.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      sock.destroy()
      const code = e.code ?? ''
      const why =
        code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? tr('Server address not found', '找不到这个服务器地址')
          : code === 'ECONNREFUSED'
            ? tr('The server refused the connection (wrong port? IMAPS is usually 993)', '服务器拒绝连接（端口不对？IMAPS 通常是 993）')
            : /certificate|CERT|self.signed|unable to verify/i.test(`${code} ${e.message}`)
              ? tr(`The server certificate cannot be verified (${code || e.message})`, `服务器证书无法验证（${code || e.message}）`)
              : /wrong version number|packet length too long|unknown protocol|EPROTO/i.test(`${code} ${e.message}`)
                ? tr('The server is not using TLS (Navalia supports only encrypted connections on port 993, no plaintext or STARTTLS)', '对方没有使用 TLS（Navalia 只支持 993 端口的加密连接，不支持明文或 STARTTLS）')
                : tr(`TLS connection failed (${code || 'error'})`, `TLS 连接失败（${code || 'error'}）`)
      reject(new ImapError('tls', tr(`${why}.`, `${why}。`)))
    })
  })
