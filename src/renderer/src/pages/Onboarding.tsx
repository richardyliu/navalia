// S2-01 first-run onboarding overlay. Owned by the onboard-ask agent.
// Mounted once by App above the shell; renders null when onboarding is not needed.
// Logic lives in components/onboarding/flow.ts (pure, tested); this file only renders.
import { useEffect, useReducer, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import '../components/onboarding/onboarding.css'
import type { OnboardingOutcome, OnboardingStatus } from '../../../main/onboarding/api'
import type { CaptureStatusView } from '../../../main/capture/api'
import type { ConnectionsOverview } from '../../../main/broker/api'
import type { LibraryOverview } from '../../../main/library/api'
import { ApiError, unwrap } from '../lib/api'
import { useNav, type Page } from '../lib/nav'
import {
  INITIAL_FLOW,
  ONBOARDING_STEPS,
  STEP_TITLES,
  agentRows,
  currentStep,
  doneHeadline,
  finishPayload,
  flowReducer,
  isLastStep,
  libraryPreview,
  permissionRows,
  progressLabel,
  welcomePrivacyCopy
} from '../components/onboarding/flow'
import { tr } from '../lib/i18n'

export function Onboarding() {
  const qc = useQueryClient()
  const status = useQuery<OnboardingStatus>({
    queryKey: ['onboarding', 'status'],
    queryFn: () => unwrap(window.lens.onboarding.status()),
    staleTime: Infinity,
    retry: false
  })
  const [flow, dispatch] = useReducer(flowReducer, INITIAL_FLOW)
  const [saveError, setSaveError] = useState<string | null>(null)
  const { go } = useNav()

  const visible = Boolean(status.data?.show) && !flow.finished
  const step = currentStep(flow)
  const active = visible && !flow.minimized

  // Status reads only happen while the overlay is up; nothing is polled once it is gone.
  const capture = useQuery<CaptureStatusView>({
    queryKey: ['onboarding', 'capture'],
    queryFn: () => unwrap(window.lens.capture.status()),
    enabled: active && step === 'permissions',
    retry: false
  })
  const connections = useQuery<ConnectionsOverview>({
    queryKey: ['onboarding', 'connections'],
    queryFn: () => unwrap(window.lens.connections.list()),
    enabled: active && step === 'connections',
    retry: false
  })
  const library = useQuery<LibraryOverview>({
    queryKey: ['onboarding', 'library'],
    queryFn: () => unwrap(window.lens.library.overview()),
    // C23: the import step previews the 资料库 from the same read; done reuses the cached result.
    enabled: active && (step === 'import' || step === 'done'),
    retry: false
  })

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dispatch({ type: 'minimize' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  if (!visible) return null

  async function finish(outcome: OnboardingOutcome, then?: Page): Promise<void> {
    const payload = finishPayload(flow, outcome)
    const r = await window.lens.onboarding.finish(payload)
    if (!r.ok) {
      // Do not trap the user: close for this session anyway and say the choice was not saved.
      setSaveError(r.error.message)
    }
    dispatch({ type: outcome === 'completed' ? 'complete' : 'skipAll' })
    void qc.invalidateQueries({ queryKey: ['onboarding', 'status'] })
    if (then) go(then)
  }

  /** Jump to a real page: the overlay minimises to a pill (not persisted), so nobody is trapped. */
  function visit(page: Page): void {
    dispatch({ type: 'minimize' })
    go(page)
  }

  if (flow.minimized) {
    return (
      <div className="onb-pill" data-testid="onboarding-pill">
        <span>{tr(`Onboarding · step ${progressLabel(flow)}`, `引导 · 第 ${progressLabel(flow)} 步`)}</span>
        <button className="btn small primary" data-testid="onboarding-restore" onClick={() => dispatch({ type: 'restore' })}>
          {tr('Resume onboarding', '继续引导')}
        </button>
        <button className="btn small ghost" data-testid="onboarding-skip-all" onClick={() => void finish('skipped')}>
          {tr('End onboarding', '结束引导')}
        </button>
        {saveError ? <span className="tiny bad">{tr(`Not saved: ${saveError}`, `未能保存：${saveError}`)}</span> : null}
      </div>
    )
  }

  const perms = permissionRows(capture.data)
  const agents = agentRows(connections.data)
  const libraryError = library.error
    ? { code: library.error instanceof ApiError ? library.error.code : null, message: library.error.message }
    : null
  const headline = doneHeadline(library.data, libraryError)
  const preview = libraryPreview(library.data, libraryError)

  return (
    <div className="onb-backdrop" data-testid="onboarding-overlay" role="dialog" aria-modal="true" aria-label={tr('First-run onboarding', '首次使用引导')}>
      <div className="onb-panel">
        <header className="onb-head">
          <ol className="onb-steps">
            {ONBOARDING_STEPS.map((s, i) => (
              <li key={s} className={i === flow.index ? 'active' : i < flow.index ? 'past' : ''}>
                {STEP_TITLES[s]}
              </li>
            ))}
          </ol>
          <button className="btn small ghost" data-testid="onboarding-skip-all" onClick={() => void finish('skipped')}>
            {tr('Skip onboarding', '跳过引导')}
          </button>
        </header>

        <section className="onb-body" data-testid="onboarding-step" data-step={step}>
          {step === 'welcome' ? (
            <>
              <div className="eyebrow">Navalia</div>
              <h1 className="onb-title">Step into your Personal Database</h1>
              <p className="onb-sub">{tr('You own your intelligence.', '你拥有自己的智能。')}</p>
              <p>
                {tr(
                  'Navalia organizes your work context on this Mac (screen capture, memory, model, workflows) and hands it to your own Agents over local MCP. ',
                  'Navalia 在这台 Mac 上整理你的工作上下文（屏幕采集、记忆、模型、工作流），并通过本地 MCP 交给你自己的 Agent 使用。'
                )}
                {welcomePrivacyCopy()}
              </p>
            </>
          ) : null}

          {step === 'permissions' ? (
            <>
              <h2>{tr('Permissions', '权限')}</h2>
              <p className="muted">
                {tr(
                  "Screen capture needs macOS Accessibility and Screen Recording permissions. This only shows their status and won't trigger a system prompt; grant permissions or exclude apps on the Capture page.",
                  '屏幕采集需要 macOS 的辅助功能与屏幕录制权限。这里只显示状态，不会弹出系统授权；到「采集」页按需授权或排除应用。'
                )}
              </p>
              <ul className="onb-list">
                {perms.map((p) => (
                  <li key={p.key}>
                    <span>{p.label}</span>
                    <span className={`chip ${p.tone}`}>{p.value}</span>
                  </li>
                ))}
              </ul>
              {capture.isError ? <p className="tiny muted">{tr(`Failed to read capture status: ${capture.error.message}`, `读取采集状态失败：${capture.error.message}`)}</p> : null}
              <button className="btn" data-testid="onboarding-go-capture" onClick={() => visit('capture')}>
                {tr('Go to Capture', '去「采集」页')}
              </button>
            </>
          ) : null}

          {step === 'connections' ? (
            <>
              <h2>{tr('Connect your Agents', '连接你的 Agent')}</h2>
              <p className="muted">
                {tr(
                  'On the Connections page, connect Claude Code / Codex / Cursor to the local Navalia Broker (127.0.0.1) so they can read your personal database over MCP. Every read is recorded in the Access log.',
                  '在「Connections」页把 Claude Code / Codex / Cursor 连接到本机的 Navalia Broker（127.0.0.1），它们就能通过 MCP 读取你的个人数据库。每次读取都记在 Access log。'
                )}
              </p>
              <ul className="onb-list">
                {agents.map((a) => (
                  <li key={a.id}>
                    <span>{a.name}</span>
                    <span className={`chip ${a.tone}`}>{a.label}</span>
                  </li>
                ))}
              </ul>
              {connections.isError ? <p className="tiny muted">{tr(`Failed to read connection status: ${connections.error.message}`, `读取连接状态失败：${connections.error.message}`)}</p> : null}
              <button className="btn" data-testid="onboarding-go-connections" onClick={() => visit('connections')}>
                {tr('Go to Connections', '去「Connections」页')}
              </button>
            </>
          ) : null}

          {step === 'import' ? (
            <>
              <h2>{tr('Import history & Library preview (optional)', '导入历史与资料库预览（可选）')}</h2>
              <p className="muted">
                {tr(
                  "You can import this Mac's Claude Code / Codex session history into the Runtime so the model learns from past work. You'll see a preview first, and no build runs by default. Navalia works fine without importing.",
                  '可以把本机的 Claude Code / Codex 会话历史导入 Runtime，让模型从过去的工作中学习。导入前会先预览，默认不触发构建。不导入也可以直接使用。'
                )}
              </p>
              <button className="btn" data-testid="onboarding-go-import" onClick={() => visit('import')}>
                {tr('Go to Import', '去「导入」页')}
              </button>

              <h3 className="onb-preview-title">{tr('Library preview', '资料库预览')}</h3>
              <p className={`onb-preview-headline tone-${preview.tone}`} data-testid="onboarding-library-preview" data-state={preview.state}>
                {preview.headline}
              </p>
              {preview.rows.length > 0 ? (
                <ul className="onb-list onb-preview">
                  {preview.rows.map((r) => (
                    <li key={r.key} data-testid={`onboarding-preview-${r.key}`}>
                      <span>
                        {r.label}
                        {r.samples.length > 0 ? <span className="tiny muted onb-samples">{tr(`e.g. ${r.samples.join(', ')}`, `例如：${r.samples.join('、')}`)}</span> : null}
                      </span>
                      <span className={`chip ${r.count === null ? 'warn' : r.count === 0 ? 'subtle' : 'ok'}`} title={r.note ?? undefined}>
                        {r.count === null ? tr('Unreadable', '读不到') : r.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="onb-actions-inline">
                <button className="btn small ghost" data-testid="onboarding-preview-refresh" disabled={library.isFetching} onClick={() => void library.refetch()}>
                  {tr('Reload', '重新读取')}
                </button>
                <button className="btn small ghost" data-testid="onboarding-go-library" onClick={() => visit('library')}>
                  {tr('Go to Library', '去「资料库」页')}
                </button>
              </div>
              <p className="muted tiny">
                {tr('Reads local data only and writes nothing. You can just click "Skip this step".', '只读本机数据，不写入任何东西；可以直接点「跳过此步」。')}
              </p>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <h2>{tr('All set', '准备好了')}</h2>
              <p className={`onb-headline tone-${headline.tone}`} data-testid="onboarding-headline">
                {headline.text}
              </p>
              <p className="muted tiny">
                {tr(
                  "Numbers come straight from the Runtime model; they're 0 until the Runtime has built a model.",
                  '数字直接来自 Runtime 模型；Runtime 还没构建过模型时会是 0。'
                )}
              </p>
              <div className="onb-actions-inline">
                <button className="btn primary" data-testid="onboarding-finish-today" onClick={() => void finish('completed', 'today')}>
                  {tr('Go to Today', '去今天')}
                </button>
                <button className="btn" data-testid="onboarding-finish-library" onClick={() => void finish('completed', 'library')}>
                  {tr('Go to Library', '去资料库')}
                </button>
              </div>
            </>
          ) : null}
          {saveError ? <p className="tiny bad">{tr(`Couldn't save onboarding state: ${saveError}`, `未能保存引导状态：${saveError}`)}</p> : null}
        </section>

        <footer className="onb-foot">
          <span className="tiny muted">{tr(`Step ${progressLabel(flow)} · Esc to minimize`, `第 ${progressLabel(flow)} 步 · Esc 暂时收起`)}</span>
          <div className="onb-foot-actions">
            {flow.index > 0 ? (
              <button className="btn small ghost" data-testid="onboarding-back" onClick={() => dispatch({ type: 'back' })}>
                {tr('Back', '上一步')}
              </button>
            ) : null}
            {isLastStep(flow) ? (
              <button className="btn small primary" data-testid="onboarding-finish" onClick={() => void finish('completed')}>
                {tr('Finish', '完成')}
              </button>
            ) : (
              <>
                <button className="btn small ghost" data-testid="onboarding-skip-step" onClick={() => dispatch({ type: 'skipStep' })}>
                  {tr('Skip this step', '跳过此步')}
                </button>
                <button className="btn small primary" data-testid="onboarding-next" onClick={() => dispatch({ type: 'next' })}>
                  {tr('Next', '下一步')}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
