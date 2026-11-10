// S2-01 onboarding: pure state machine + view-model helpers (no React, no window) so vitest can
// test them without a DOM. Onboarding.tsx stays a thin renderer over this.
import { ONBOARDING_STEPS, type OnboardingFinishInput, type OnboardingOutcome, type OnboardingStep } from '../../../../main/onboarding/api'
import type { AgentId, AgentState, ConnectionsOverview } from '../../../../main/broker/api'
import type { CaptureStatusView } from '../../../../main/capture/api'
import type { LibraryOverview } from '../../../../main/library/api'
import { libraryHeadline } from '../../../../main/library/aggregate'
import { tr } from '../../lib/i18n'

export { ONBOARDING_STEPS }
export type { OnboardingStep }

export const STEP_TITLES: Record<OnboardingStep, string> = {
  get welcome() { return tr('Welcome', '欢迎') },
  get permissions() { return tr('Permissions', '权限') },
  get connections() { return tr('Connect Agents', '连接 Agent') },
  get import() { return tr('Import & preview', '导入与预览') },
  get done() { return tr('Done', '完成') }
}

export interface FlowState {
  index: number
  /** Overlay hidden for this session after the user jumped to another page; not persisted. */
  minimized: boolean
  /** Set once finish was requested; the overlay then unmounts. */
  finished: OnboardingOutcome | null
}

export type FlowAction =
  | { type: 'next' }
  | { type: 'back' }
  /** Skip only the current step (same as next, but never past the last step). */
  | { type: 'skipStep' }
  /** Global “跳过引导”. */
  | { type: 'skipAll' }
  | { type: 'complete' }
  | { type: 'minimize' }
  | { type: 'restore' }

export const INITIAL_FLOW: FlowState = { index: 0, minimized: false, finished: null }

const LAST = ONBOARDING_STEPS.length - 1

export function currentStep(state: FlowState): OnboardingStep {
  return ONBOARDING_STEPS[Math.min(Math.max(state.index, 0), LAST)]
}

export function isLastStep(state: FlowState): boolean {
  return state.index >= LAST
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  if (state.finished) return state
  switch (action.type) {
    case 'next':
    case 'skipStep':
      return { ...state, index: Math.min(state.index + 1, LAST) }
    case 'back':
      return { ...state, index: Math.max(state.index - 1, 0) }
    case 'skipAll':
      return { ...state, finished: 'skipped' }
    case 'complete':
      return { ...state, index: LAST, finished: 'completed' }
    case 'minimize':
      return { ...state, minimized: true }
    case 'restore':
      return { ...state, minimized: false }
  }
}

/** Payload for `lens:onboarding:finish`; `lastStep` is the step the user was on. */
export function finishPayload(state: FlowState, outcome: OnboardingOutcome): OnboardingFinishInput {
  return { outcome, lastStep: currentStep(state) }
}

export function progressLabel(state: FlowState): string {
  return `${Math.min(state.index, LAST) + 1} / ${ONBOARDING_STEPS.length}`
}

// ---- view-model helpers -------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'subtle'

export interface PermissionRow {
  key: 'accessibility' | 'screenRecording'
  label: string
  value: string
  tone: Tone
}

/** Read-only permission rows from the capture status. Never prompts; null status = unknown. */
export function permissionRows(status: CaptureStatusView | null | undefined): PermissionRow[] {
  const row = (key: PermissionRow['key'], label: string, granted: boolean | undefined): PermissionRow =>
    granted === undefined
      ? { key, label, value: tr('Unknown (capture service not ready)', '未知（采集服务未就绪）'), tone: 'subtle' }
      : granted
        ? { key, label, value: tr('Granted', '已授权'), tone: 'ok' }
        : { key, label, value: tr('Not granted', '未授权'), tone: 'warn' }
  return [
    row('accessibility', tr('Accessibility', '辅助功能（Accessibility）'), status?.permissions.accessibility),
    row('screenRecording', tr('Screen Recording', '屏幕录制（Screen Recording）'), status?.permissions.screenRecording)
  ]
}

/** The three coding agents onboarding points at (Claude Desktop stays on the Connections page). */
export const ONBOARDING_AGENTS: AgentId[] = ['claude-code', 'codex', 'cursor']

const AGENT_FALLBACK_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

const STATE_LABEL: Record<AgentState, { label: string; tone: Tone }> = {
  connected: { get label() { return tr('Connected', '已连接') }, tone: 'ok' },
  available: { get label() { return tr('Installed, not connected', '已安装，未连接') }, tone: 'warn' },
  not_installed: { get label() { return tr('Not installed', '未安装') }, tone: 'subtle' },
  mismatch: { get label() { return tr('Config mismatch', '配置不一致') }, tone: 'bad' },
  partial: { get label() { return tr('Partly connected', '部分连接') }, tone: 'warn' }
}

export interface AgentRow {
  id: AgentId
  name: string
  label: string
  tone: Tone
}

export function agentRows(overview: ConnectionsOverview | null | undefined): AgentRow[] {
  return ONBOARDING_AGENTS.map((id) => {
    const agent = overview?.agents.find((a) => a.id === id)
    if (!agent) return { id, name: AGENT_FALLBACK_NAME[id] ?? id, label: tr('Status unknown', '状态未知'), tone: 'subtle' as Tone }
    const s = STATE_LABEL[agent.state] ?? { label: agent.state, tone: 'subtle' as Tone }
    return { id, name: agent.name, label: s.label, tone: s.tone }
  })
}

export function runtimeOfflineHeadline(): string {
  return tr("Runtime not connected; can't count yet", 'Runtime 未连接，暂时无法统计')
}

const OFFLINE_CODES = new Set(['unreachable', 'timeout', 'runtime_missing', 'token_unavailable', 'unauthorized'])

/** Done-step headline: real counts, or an honest message — never a made-up number. */
export function doneHeadline(
  overview: LibraryOverview | null | undefined,
  error: { code?: string | null; message?: string } | null | undefined
): { text: string; tone: Tone } {
  if (overview) return { text: libraryHeadline(overview.counts), tone: 'ok' }
  if (error) {
    if (!error.code || OFFLINE_CODES.has(error.code)) return { text: runtimeOfflineHeadline(), tone: 'warn' }
    const msg = error.message ?? tr('unknown error', '未知错误')
    return { text: tr(`Can't count yet: ${msg}`, `暂时无法统计：${msg}`), tone: 'warn' }
  }
  return { text: tr('Counting…', '正在统计…'), tone: 'subtle' }
}

// ---- C23: privacy copy + 资料库 preview -------------------------------------------------------

/**
 * Welcome-step privacy line. S1-FULL added opt-in cloud features (云端对话 / 会议转写 / 周信邮件订阅),
 * so the old unconditional "no account / no cloud / offline" line is no longer true. Tested in
 * tests/onboarding/c23-copy.test.ts: every offline claim in onboarding copy must say 「默认」.
 */
export function welcomePrivacyCopy(): string {
  return tr(
    'Your data stays on this Mac by default: by default it runs only locally, offline, with no account. Cloud features (Cloud chat, meeting transcription, Weekly letter email subscription) are optional and off by default; they connect to the server you configured only after you turn them on in their page.',
    '数据默认留在本机：默认只在本地运行、不联网、不需要账号。云端功能（云端对话、会议转写、周信邮件订阅）是可选的，默认关闭，只有你在对应页面开启后才会连接你配置的服务器。'
  )
}

export const PREVIEW_SAMPLE_LIMIT = 3
const PREVIEW_SAMPLE_MAX_CHARS = 40

export function libraryPreviewEmpty(): string {
  return tr(
    'Your Library is empty. No sample data here: once you start capture or import history and the Runtime builds the model, real projects, people, skills and memories will be listed.',
    '资料库现在是空的。这里不放示例数据：开始采集或导入历史、Runtime 构建模型之后，会列出真实的项目、人、技能和记忆。'
  )
}
export function libraryPreviewReady(): string {
  return tr(
    "Here's what your Library already holds, read directly from the local Runtime and Navalia (read-only).",
    '下面是你的资料库现在已有的内容，直接读自本机 Runtime 和 Navalia（只读）。'
  )
}
export function libraryPreviewLoading(): string {
  return tr('Reading Library…', '正在读取资料库…')
}

export type LibraryPreviewKey = 'projects' | 'people' | 'skills' | 'memories'

export interface LibraryPreviewRow {
  key: LibraryPreviewKey
  label: string
  /** Real count, or null when the source could not be read (never shown as 0). */
  count: number | null
  /** Up to PREVIEW_SAMPLE_LIMIT real titles / names; empty when there are none. */
  samples: string[]
  /** Honest per-row note (empty / unreadable), or null. */
  note: string | null
}

export interface LibraryPreview {
  state: 'loading' | 'offline' | 'error' | 'empty' | 'ready'
  headline: string
  tone: Tone
  rows: LibraryPreviewRow[]
}

function sampleText(s: string): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > PREVIEW_SAMPLE_MAX_CHARS ? `${t.slice(0, PREVIEW_SAMPLE_MAX_CHARS - 1)}…` : t
}

function samplesOf(values: string[]): string[] {
  return values.map(sampleText).filter(Boolean).slice(0, PREVIEW_SAMPLE_LIMIT)
}

/**
 * Onboarding 资料库 preview from the existing `library.overview()` read (Runtime `/model/graph` +
 * Lens Workflow catalog + behavior_patterns, all local). Pure: no I/O, no network, no fake samples.
 * - A section that failed shows count null + the reason, never 0.
 * - All readable counts 0 → `empty` with an honest message.
 */
export function libraryPreview(
  overview: LibraryOverview | null | undefined,
  error: { code?: string | null; message?: string } | null | undefined
): LibraryPreview {
  if (!overview) {
    if (error) {
      if (!error.code || OFFLINE_CODES.has(error.code)) {
        const head = runtimeOfflineHeadline()
        return {
          state: 'offline',
          headline: tr(`${head}: can't read the Library, so no numbers are shown here.`, `${head}：读不到资料库，所以这里不显示任何数字。`),
          tone: 'warn',
          rows: []
        }
      }
      const msg = error.message ?? tr('unknown error', '未知错误')
      return { state: 'error', headline: tr(`Can't read the Library right now: ${msg}`, `暂时读不到资料库：${msg}`), tone: 'warn', rows: [] }
    }
    return { state: 'loading', headline: libraryPreviewLoading(), tone: 'subtle', rows: [] }
  }

  const graphErr = overview.graphError
  const graphNote = graphErr ? tr(`Couldn't read the model: ${graphErr.message}`, `没有读到模型：${graphErr.message}`) : null
  const entityRow = (key: 'projects' | 'people', label: string, list: Array<{ name: string }>): LibraryPreviewRow =>
    graphErr
      ? { key, label, count: null, samples: [], note: graphNote }
      : { key, label, count: list.length, samples: samplesOf(list.map((e) => e.name)), note: list.length === 0 ? tr('None yet', '还没有') : null }

  const skillsUnreadable = overview.skills.length === 0 && Boolean(overview.workflowError) && Boolean(overview.skillsError)
  const skills: LibraryPreviewRow = skillsUnreadable
    ? (() => {
        const msg = overview.workflowError?.message ?? overview.skillsError?.message ?? tr('unknown error', '未知错误')
        return {
          key: 'skills' as const,
          label: tr('Skills / workflows', '技能 / 工作流'),
          count: null,
          samples: [],
          note: tr(`Couldn't read skills: ${msg}`, `没有读到技能：${msg}`)
        }
      })()
    : {
        key: 'skills',
        label: tr('Skills / workflows', '技能 / 工作流'),
        count: overview.skills.length,
        samples: samplesOf(overview.skills.map((s) => s.title)),
        note: overview.skills.length === 0 ? tr('None yet', '还没有') : null
      }

  const points = graphErr ? null : overview.portrait?.counts.points ?? null
  const memories: LibraryPreviewRow = {
    key: 'memories',
    label: tr('Memory points (model Points)', '记忆点（模型 Points）'),
    count: points,
    samples: [],
    note: graphErr
      ? graphNote
      : points === null
        ? tr("The Runtime didn't report this number", 'Runtime 没有报告这个数字')
        : points === 0
          ? tr('None yet', '还没有')
          : null
  }

  const rows = [
    entityRow('projects', tr('Projects', '项目'), overview.projects),
    entityRow('people', tr('People', '人'), overview.people),
    skills,
    memories
  ]
  const known = rows.filter((r) => r.count !== null)
  if (known.length === 0) {
    const msg = graphErr?.message ?? tr('unknown error', '未知错误')
    return { state: 'error', headline: tr(`Can't read the Library right now: ${msg}`, `暂时读不到资料库：${msg}`), tone: 'warn', rows }
  }
  if (known.every((r) => r.count === 0)) {
    if (known.length === rows.length) return { state: 'empty', headline: libraryPreviewEmpty(), tone: 'subtle', rows }
    // Part unreadable and the readable part empty: do not call the library empty.
    const why = rows.find((r) => r.count === null)?.note ?? tr('unknown error', '未知错误')
    return {
      state: 'error',
      headline: tr(`Only part of the Library could be read (and that part is empty). ${why}`, `只读到资料库的一部分（读到的部分还是空的）。${why}`),
      tone: 'warn',
      rows
    }
  }
  return { state: 'ready', headline: libraryPreviewReady(), tone: 'ok', rows }
}
