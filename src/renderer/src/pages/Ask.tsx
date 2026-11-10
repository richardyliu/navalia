// S2-03 「问」page. Owned by the onboard-ask agent.
// Static prompt cards only: Lens copies text to the clipboard and links to Connections.
// No LLM call and no network request is made from this page (DECISIONS-ROUND2 X7).
// S1-R3-09: OCR status from Runtime /health (WeChat warning when OCR is not on) and
// 「把回答保存到记忆」 (preview + native confirm in main → MCP remember).
import { useState } from 'react'
import '../components/ask/ask.css'
import { ASK_PROMPTS, askServerNote, copyText, type AskPrompt } from '../components/ask/prompts'
import { requiredScopes } from '../components/ask/askView'
import { ocrStatusView } from '../components/ask/ocrStatus'
import { OcrStatusPanel, useOcrDiagnostics } from '../components/ask/OcrStatusPanel'
import { SaveAnswerCard } from '../components/ask/SaveAnswerCard'
import { useNav } from '../lib/nav'
import { tr } from '../lib/i18n'

function AskCard({ card, wechatWarning }: { card: AskPrompt; wechatWarning: string | null }) {
  const { go } = useNav()
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)

  async function copy(): Promise<void> {
    const r = await window.lens.app.copy(copyText(card))
    setCopied(r.ok && r.data ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), 2000)
  }

  return (
    <article className="card ask-card" data-testid={`ask-card-${card.id}`}>
      <div>
        <h3>{card.title}</h3>
        <p className="muted small">{card.summary}</p>
      </div>
      {card.id === 'wechat-groups' && wechatWarning ? (
        <div className="banner warn compact" data-testid="ask-wechat-ocr-warning">
          {wechatWarning}
        </div>
      ) : null}
      <pre className="ask-prompt">{card.prompt}</pre>
      <div className="ask-tools">
        <span className="tiny muted">{tr('Expected tools:', '期望工具：')}</span>
        {card.tools.map((t) => (
          <span key={t} className="chip mono">
            {t}
          </span>
        ))}
      </div>
      {card.limits.length > 0 ? (
        <ul className="ask-limits">
          {card.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <p className="tiny muted">
        {tr(
          `A scoped grant needs: ${requiredScopes(card).join(', ')} (default full access is unaffected)`,
          `限定 scope 的授权需要：${requiredScopes(card).join('、')}（默认完全访问不受影响）`
        )}
      </p>
      <div className="ask-actions">
        <button className="btn small primary" data-testid={`ask-copy-${card.id}`} onClick={() => void copy()}>
          {tr('Copy', '复制')}
        </button>
        <button className="btn small ghost" onClick={() => go('connections')}>
          {tr('Connect an Agent in Connections', '去 Connections 连接 Agent')}
        </button>
        {card.id === 'wechat-groups' ? (
          <button className="btn small ghost" onClick={() => go('capture')}>
            {tr('View capture diagnostics (OCR)', '查看采集诊断（OCR）')}
          </button>
        ) : null}
        {copied === 'ok' ? <span className="tiny tone-ok">{tr('Copied', '已复制')}</span> : null}
        {copied === 'fail' ? <span className="tiny tone-bad">{tr('Copy failed', '复制失败')}</span> : null}
      </div>
      <p className="tiny muted" data-testid="ask-llm-note">
        {card.note}
      </p>
    </article>
  )
}

export function Ask() {
  const diag = useOcrDiagnostics()
  // Until /health answers, treat OCR as unconfirmed so WeChat never looks like it works.
  const ocr = ocrStatusView(diag.data?.runtimeOcr ?? null, diag.data?.config.ocr ?? null)
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Ask</div>
          <h2>{tr('Ask', '问')}</h2>
          <p className="muted">
            {tr(
              'Copy a prompt below into Claude Code / Codex / Cursor and run it. The Agent reads your personal database through local MCP and answers with sources.',
              '把下面的 prompt 复制到 Claude Code / Codex / Cursor 里运行。Agent 通过本机 MCP 读取你的个人数据库并给出带来源的回答。'
            )}
          </p>
        </div>
      </header>
      <div className="banner compact">{askServerNote()}</div>
      <OcrStatusPanel diag={diag.data} failed={diag.isError} testId="ask-ocr-status" />
      <div className="ask-grid">
        {ASK_PROMPTS.map((card) => (
          <AskCard key={card.id} card={card} wechatWarning={ocr.wechatWarning} />
        ))}
      </div>
      <SaveAnswerCard />
    </div>
  )
}
