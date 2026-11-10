import { useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CheckStatus,
  ConfirmChallenge,
  DestructiveRunResult,
  DoctorResult,
  NextStep,
  RecoveryActionId,
  RecoveryApi,
  RecoveryCheck,
  RecoveryReport
} from '../../../main/recovery/api'
import { api, errorMessage, unwrap } from '../lib/api'
import { useNav } from '../lib/nav'
import { copiedToast } from '../components/Toaster'
import { intlLocale, tr } from '../lib/i18n'

// OG-06 Recovery: aggregated runtime/data health with one executable next step per failing check.
// All checks and commands run in main; this page only sends fixed action ids.
const recovery = (): RecoveryApi['recovery'] => (window.lens as unknown as RecoveryApi).recovery

const STATUS_LABEL: Record<CheckStatus, string> = {
  get ok() {
    return tr('OK', '正常')
  },
  get warn() {
    return tr('Attention', '注意')
  },
  get fail() {
    return tr('Failing', '故障')
  },
  get unknown() {
    return tr('Unknown', '未知')
  }
}
const STATUS_CHIP: Record<CheckStatus, string> = { ok: 'ok', warn: 'warn', fail: 'bad', unknown: 'subtle' }

const preStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflow: 'auto',
  fontSize: 'var(--fs-sm)',
  margin: 0,
  padding: 10,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg, rgba(0,0,0,0.04))'
}

export function Recovery() {
  const qc = useQueryClient()
  const { go } = useNav()
  const report = useQuery<RecoveryReport>({
    queryKey: ['recovery-health'],
    queryFn: () => unwrap(recovery().health()),
    staleTime: 5_000
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const [challenge, setChallenge] = useState<ConfirmChallenge | null>(null)
  const [typed, setTyped] = useState('')
  const [rebuild, setRebuild] = useState<DestructiveRunResult | null>(null)

  async function act<T>(label: string, fn: () => Promise<T>, done?: (v: T) => void): Promise<void> {
    setBusy(label)
    setNotice(null)
    try {
      const v = await fn()
      done?.(v)
    } catch (error) {
      setNotice({ kind: 'bad', text: tr(`${label} failed: ${errorMessage(error)}`, `${label}失败：${errorMessage(error)}`) })
    } finally {
      setBusy(null)
    }
  }

  const setReport = (r: RecoveryReport): void => {
    qc.setQueryData(['recovery-health'], r)
    void qc.invalidateQueries({ queryKey: ['discover'] })
  }

  async function run(action: RecoveryActionId): Promise<void> {
    switch (action) {
      case 'start-runtime':
        return act(tr('Start Runtime', '启动 Runtime'), () => unwrap(recovery().startRuntime()), (r) => {
          setReport(r)
          setNotice({ kind: 'ok', text: tr('Runtime started', 'Runtime 已启动') })
        })
      case 'restart-runtime':
        return act(tr('Restart Runtime', '重启 Runtime'), () => unwrap(recovery().restartRuntime()), (r) => {
          setReport(r)
          setNotice({ kind: 'ok', text: tr('Runtime restarted', 'Runtime 已重启') })
        })
      case 'run-doctor':
        return act(tr('Run doctor', '运行 doctor'), () => unwrap(recovery().doctor()), setDoctor)
      case 'open-logs':
        return act(tr('Open logs folder', '打开日志目录'), () => api.open('logs'))
      case 'copy-diagnostics':
        return act(tr('Copy diagnostics', '复制诊断'), () => unwrap(recovery().diagnostics(true)), () =>
          setNotice({ kind: 'ok', text: tr('Diagnostics copied (token and keys hidden)', '诊断已复制（token 与密钥已隐藏）') })
        )
      case 'goto-capture':
        go('capture')
        return
      case 'goto-connections':
        go('connections')
        return
      case 'rebuild-captures-index':
        return act(tr('Request confirmation', '发起确认'), () => unwrap(recovery().confirmIssue('rebuild-captures-index')), (c) => {
          setChallenge(c)
          setTyped('')
          setRebuild(null)
        })
    }
  }

  async function confirmRebuild(): Promise<void> {
    if (!challenge) return
    const c = challenge
    setChallenge(null)
    await act(tr('Rebuild capture index', '重建采集索引'), () => unwrap(recovery().confirmRun(c.action, c.nonce, typed)), (r) => {
      setRebuild(r)
      void report.refetch()
    })
    setTyped('')
  }

  const data = report.data
  const failing = data?.checks.filter((c) => c.status !== 'ok') ?? []

  return (
    <div className="page recovery-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Recovery</div>
          <h2>{tr('Recovery', '恢复')}</h2>
          <p className="muted">
            {tr(
              'Self-checks and recovery for runtime and data problems. All checks run read-only in the main process; the token and keys are never shown.',
              '运行时与数据故障的自检和恢复。所有检查在主进程只读执行；token 与密钥不会显示。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost small" disabled={report.isFetching || Boolean(busy)} onClick={() => void report.refetch()}>
            {report.isFetching ? tr('Checking…', '检查中…') : tr('Check again', '重新检查')}
          </button>
          <button className="btn ghost small" disabled={Boolean(busy)} onClick={() => void run('run-doctor')}>
            {tr('Run doctor', '运行 doctor')}
          </button>
          <button className="btn ghost small" disabled={Boolean(busy)} onClick={() => void run('open-logs')}>
            {tr('Open logs folder', '打开日志目录')}
          </button>
          <button className="btn ghost small" disabled={Boolean(busy)} onClick={() => void run('copy-diagnostics')}>
            {tr('Copy diagnostics', '复制诊断')}
          </button>
        </div>
      </header>

      {report.isError ? <div className="banner bad compact">{errorMessage(report.error)}</div> : null}
      {busy ? <div className="banner compact">{tr(`${busy}…`, `正在${busy}…`)}</div> : null}
      {notice ? <div className={`banner compact ${notice.kind}`}>{notice.text}</div> : null}

      {data ? (
        <div className={`banner compact ${data.overall === 'ok' ? 'ok' : data.overall === 'fail' ? 'bad' : 'warn'}`}>
          {tr('Overall:', '总体：')} {STATUS_LABEL[data.overall]}
          {failing.length ? tr(` (${failing.length} need attention)`, `（${failing.length} 项需要处理）`) : ''} · Runtime {data.runtime.root} · 127.0.0.1:{data.runtime.port}
          {data.runtime.version ? ` · v${data.runtime.version}` : ''}
        </div>
      ) : null}

      {challenge ? (
        <section className="card recovery-confirm">
          <div className="card-head">
            <h3>{tr('Confirm: rebuild capture index', '确认：重建采集索引')}</h3>
            <span className="chip warn">{tr('Needs a second confirmation', '需二次确认')}</span>
          </div>
          <p className="small">{challenge.warning}</p>
          <p className="small">
            {tr('Type', '请输入')} <strong className="mono">{challenge.phrase}</strong>{' '}
            {tr(
              `to confirm (valid until ${new Date(challenge.expiresAt).toLocaleTimeString(intlLocale())}, single use).`,
              `以确认（${new Date(challenge.expiresAt).toLocaleTimeString(intlLocale())} 前有效，仅可使用一次）。`
            )}
          </p>
          <div className="card-foot wrap">
            <input
              className="input recovery-confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={challenge.phrase}
              autoFocus
            />
            <button className="btn primary small" disabled={!typed.trim() || Boolean(busy)} onClick={() => void confirmRebuild()}>
              {tr('Confirm and run', '确认执行')}
            </button>
            <button className="btn ghost small" onClick={() => setChallenge(null)}>
              {tr('Cancel', '取消')}
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h3>{tr('Health checks', '健康检查')}</h3>
        </div>
        {data ? (
          <ul className="recovery-checks" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.checks.map((c) => (
              <CheckRow key={c.id} check={c} busy={Boolean(busy)} onAction={(a) => void run(a)} />
            ))}
          </ul>
        ) : (
          <p className="muted">{report.isLoading ? tr('Checking…', '检查中…') : tr('No results yet', '暂无结果')}</p>
        )}
      </section>

      {doctor ? (
        <section className="card recovery-doctor">
          <div className="card-head">
            <h3>persome doctor</h3>
            <span className={`chip ${doctor.timedOut || doctor.summary.fail ? 'bad' : doctor.summary.warn ? 'warn' : 'ok'}`}>
              {doctor.timedOut ? tr('Timed out', '超时') : `✓${doctor.summary.ok} ✗${doctor.summary.fail} ⚠${doctor.summary.warn}`}
            </span>
          </div>
          <p className="muted small">
            {tr(
              `Exit code ${doctor.exitCode ?? 'none'} · took ${(doctor.durationMs / 1000).toFixed(1)} s${doctor.truncated ? ' · output too long, truncated' : ''} · token / keys hidden`,
              `退出码 ${doctor.exitCode ?? '无'} · 用时 ${(doctor.durationMs / 1000).toFixed(1)} 秒${doctor.truncated ? ' · 输出过长已截断' : ''} · 已隐藏 token / 密钥`
            )}
          </p>
          <pre style={preStyle}>{doctor.output || tr('(no output)', '（无输出）')}</pre>
        </section>
      ) : null}

      {rebuild ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Capture index rebuild result', '重建采集索引结果')}</h3>
            <span className={`chip ${rebuild.ok ? 'ok' : 'bad'}`}>{rebuild.ok ? tr('Done', '完成') : rebuild.timedOut ? tr('Timed out', '超时') : tr('Failed', '失败')}</span>
          </div>
          <p className="muted small">
            {tr(
              `Exit code ${rebuild.exitCode ?? 'none'}${rebuild.truncated ? ' · output too long, showing only start and end' : ''} · Runtime ${rebuild.runtimeRestarted ? 'restarted' : 'could not be restarted; click "Start Runtime"'}`,
              `退出码 ${rebuild.exitCode ?? '无'}${rebuild.truncated ? ' · 输出过长，只显示开头和结尾' : ''} · Runtime ${rebuild.runtimeRestarted ? '已重新启动' : '未能重新启动，请点「启动 Runtime」'}`
            )}
          </p>
          <pre style={preStyle}>{rebuild.output || tr('(no output)', '（无输出）')}</pre>
        </section>
      ) : null}

      {data ? (
        <section className="card">
          <div className="card-head">
            <h3>{tr('Manual steps', '需手动执行')}</h3>
            <span className="chip subtle">{tr('Navalia will not run these for you', 'Navalia 不会替你执行')}</span>
          </div>
          <p className="muted small">
            {tr(
              'These operations are lossy or have no safe Runtime/Navalia interface, so only the exact steps are given.',
              '以下操作有损或没有安全的 Runtime/Navalia 接口，只给出确切步骤。'
            )}
          </p>
          {data.manual.map((m) => (
            <details key={m.id} className="recovery-manual" style={{ marginTop: 8 }}>
              <summary>
                <strong>{m.title}</strong>
              </summary>
              <p className="small muted">{m.why}</p>
              <pre style={preStyle}>{m.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}</pre>
              <button className="btn ghost small" onClick={() => void act(tr('Copy steps', '复制步骤'), () => api.copy(m.steps.join('\n')))}>
                {tr('Copy steps', '复制步骤')}
              </button>
            </details>
          ))}
        </section>
      ) : null}
    </div>
  )
}

function CheckRow({ check, busy, onAction }: { check: RecoveryCheck; busy: boolean; onAction: (a: RecoveryActionId) => void }) {
  return (
    <li className={`recovery-check status-${check.status}`} style={{ padding: '10px 0', borderTop: '1px solid var(--line, rgba(0,0,0,0.08))' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className={`chip ${STATUS_CHIP[check.status]}`}>{STATUS_LABEL[check.status]}</span>
        <strong>{check.label}</strong>
        <span className="muted small mono" style={{ overflowWrap: 'anywhere' }}>
          {check.detail}
        </span>
      </div>
      {check.next.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {check.next.map((n, i) => (
            <NextButton key={i} step={n} busy={busy} onAction={onAction} />
          ))}
        </div>
      ) : null}
    </li>
  )
}

function NextButton({ step, busy, onAction }: { step: NextStep; busy: boolean; onAction: (a: RecoveryActionId) => void }) {
  if (step.kind === 'action') {
    return (
      <button className="btn small recovery-action" data-action={step.action} disabled={busy} onClick={() => onAction(step.action)}>
        {step.label}
      </button>
    )
  }
  const text = step.command ?? step.steps.join('\n')
  return (
    <details className="recovery-manual-step">
      <summary className="small">{tr(`Manual: ${step.title}`, `手动：${step.title}`)}</summary>
      <pre style={preStyle}>{step.steps.join('\n')}</pre>
      <button className="btn ghost small" onClick={() => void api.copy(text).then(() => copiedToast(tr('command', '命令')))}>
        {tr('Copy command', '复制命令')}
      </button>
    </details>
  )
}
