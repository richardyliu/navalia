import { tr } from '../../lib/i18n'
import type { HetAssessorInfo, HetAssessorStatus, HetPeriodCounts, HetSummary, HetTaskDto, HetWaitingKey } from '../../../../main/het/api'

/** Pure UI label helpers (unit-tested in tests/het/labels.test.ts). */

export type HetRangeId = 'today' | 'week' | 'month'
export const RANGE_LABEL: Record<HetRangeId, string> = {
  get today() {
    return tr('Today', '今日')
  },
  get week() {
    return tr('This week', '本周')
  },
  get month() {
    return tr('This month', '本月')
  }
}

export function reasonText(key: HetWaitingKey, transport?: string): string {
  switch (key) {
    case 'unsettled':
      return tr('Session still running; assessed 30 minutes after it ends', '会话仍在进行，结束 30 分钟后进入评估')
    case 'failed':
      return tr('Assessment failed repeatedly; retries stopped', '多次评估失败，已停止重试')
    case 'queued':
      return transport === 'disabled'
        ? tr('Queued; the assessor is off (LLM calls not authorized), so no model will be called', '排队中；评估器未启用（未授权 LLM 调用），不会调用模型')
        : tr('Queued for the next assessment', '排队中，等待下一次评估')
    case 'assessor_disabled':
      return tr('Assessor off: recorded, counted as 0 minutes, no model called', '评估器未启用：已记录，计 0 分钟，未调用任何模型')
    case 'no_transport':
      return tr('This build has no assessor transport: counted as 0 minutes, no model called', '本构建没有可用的 assessor transport：计 0 分钟，未调用任何模型')
    case 'budget_unavailable':
      return tr("Budget unavailable (Runtime [agent_funding] off / today's quota used up / Runtime not found): counted as 0 minutes", '预算不可用（Runtime [agent_funding] 未开启 / 今日额度用完 / 找不到 Runtime）：计 0 分钟')
    case 'quota':
      return tr('LLM quota used up; retries automatically when the quota resets', 'LLM 额度已用尽，额度恢复后自动重试')
    case 'offline':
      return tr('Offline; will retry later', '离线，稍后重试')
    case 'invalid':
      return tr('Invalid model output (rejected); will retry later', '模型返回不合法（已拒绝），稍后重试')
    default:
      return tr('Assessment error; will retry later', '评估出错，稍后重试')
  }
}

/** Stat-card + queue labels, always scoped to the selected range and to whole-range counts. */
export function scopeLabels(range: HetRangeId, counts: HetPeriodCounts | undefined) {
  const r = RANGE_LABEL[range]
  const waiting = counts ? counts.needs_assessment + counts.unsettled + counts.failed : null
  return {
    pendingCardLabel: tr(`Awaiting assessment · ${r}`, `${r}等待评估`),
    pendingCardValue: counts ? counts.needs_assessment : null,
    pendingCardDetail: counts
      ? tr(
          `Counted as 0 minutes until assessed${counts.unsettled ? `; ${counts.unsettled} more in progress` : ''}`,
          `计 0 分钟，评估后才计入${counts.unsettled ? `；另有 ${counts.unsettled} 个进行中` : ''}`
        )
      : tr('Loading…', '读取中…'),
    failedCardLabel: tr(`Assessment failed · ${r}`, `${r}评估失败`),
    queueTitle: waiting === null ? tr(`Not counted · ${r}`, `${r}未计入`) : tr(`Not counted · ${r} (${waiting})`, `${r}未计入（${waiting}）`)
  }
}

export function assessorLabel(transport: string | undefined): { value: string; tone: 'warn' | 'muted' } {
  if (!transport) return { value: '—', tone: 'muted' }
  if (transport === 'disabled') return { value: tr('Off (LLM calls not authorized)', '未启用（未授权 LLM 调用）'), tone: 'warn' }
  if (transport === 'fixture') return { value: tr('Test fixture (not an LLM)', '测试 fixture（非 LLM）'), tone: 'warn' }
  if (transport === 'agent_funding') return { value: 'Runtime CLI（agent_funding）', tone: 'muted' }
  return { value: transport, tone: 'muted' }
}

/** Reason buckets in a stable display order. */
export function reasonRows(counts: HetPeriodCounts | undefined, transport?: string): Array<{ key: HetWaitingKey; n: number; text: string }> {
  if (!counts) return []
  const order: HetWaitingKey[] = ['unsettled', 'queued', 'assessor_disabled', 'no_transport', 'budget_unavailable', 'quota', 'offline', 'invalid', 'error', 'failed']
  return order
    .filter((k) => (counts.waiting_by_reason[k] ?? 0) > 0)
    .map((k) => ({ key: k, n: counts.waiting_by_reason[k]!, text: reasonText(k, transport) }))
}

// ── S1-02: assessor honesty view-models ────────────────────────────────────────────

/** True when the assessor can actually produce minutes right now. */
export function assessorRunning(a: HetAssessorStatus | undefined): boolean {
  return a?.state === 'ready' || a?.state === 'fixture'
}

/**
 * Page-level banner explaining why nothing is being measured. Null when the assessor runs.
 * `waiting` = needs_assessment count in the selected range.
 */
export function assessorBanner(a: HetAssessorStatus | undefined, waiting: number | null): { tone: 'warn' | 'bad'; text: string } | null {
  if (!a || assessorRunning(a)) return null
  const n =
    waiting === null
      ? ''
      : tr(
          ` ${waiting} tasks in this range await assessment (needs_assessment), counted as 0 minutes.`,
          `当前范围内 ${waiting} 个任务等待评估（needs_assessment），计 0 分钟。`
        )
  switch (a.state) {
    case 'disabled':
      return { tone: 'warn', text: tr(`Assessor off, 0 minutes: tasks are recorded but not counted in the total.${n}`, `评估器未启用，0 分钟：任务被记录，但不计入总数。${n}`) }
    case 'no_transport':
      return { tone: 'warn', text: tr(`This build has no assessor transport: no model will be called, 0 minutes.${n}`, `本构建没有可用的 assessor transport：不会调用模型，0 分钟。${n}`) }
    default:
      return { tone: 'bad', text: tr(`Budget unavailable (${budgetReasonText(a.reason)}): no model call this round, 0 minutes.${n}`, `预算不可用（${budgetReasonText(a.reason)}）：本轮不调用模型，0 分钟。${n}`) }
  }
}

/** X3: human copy for the budget-probe reason codes set in main/index.ts + service.ts. */
export function budgetReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'not_enabled':
      return tr("Runtime's [agent_funding] is off", 'Runtime 的 [agent_funding] 未开启')
    case 'exhausted':
      return tr("Runtime's daily call quota is used up; it resets tomorrow", 'Runtime 今日调用额度已用完，明天自动恢复')
    case 'runtime_python_missing':
      return tr("Persome Runtime's Python was not found", '没有找到 Persome Runtime 的 Python')
    case 'no_budget_probe':
    case 'not_probed':
      return tr('Not checked yet; checked on the next scan', '尚未检查，下一次扫描时检查')
    case 'probe_error':
      return tr('Failed to read the budget', '读取预算失败')
    default:
      return reason ?? tr('Unknown reason', '未知原因')
  }
}

/**
 * Total stat card. When the assessor is not running and nothing was ever assessed in range,
 * show 「未测量」 instead of a 0 that looks like a measurement.
 */
export function totalCard(
  a: HetAssessorStatus | undefined,
  totalTenths: number,
  counted: number,
  formatted: string,
  anchorVersion?: number | null
): { value: string; detail: string; tone: 'ok' | 'muted' | 'warn' } {
  if (a && !assessorRunning(a)) {
    if (counted === 0)
      return { value: tr('Unmeasured', '未测量'), detail: tr('Assessor not running: 0 minutes counted, which is not a measurement', '评估器未运行：0 分钟计入，这不是测量结果'), tone: 'warn' }
    return {
      value: tr(`Est. ${formatted}`, `估计 ${formatted}`),
      detail: tr(
        `${counted} previously assessed tasks; the assessor is not running now, so new tasks count as 0 minutes. ${estimateNote(anchorVersion)}`,
        `${counted} 个此前已评估的任务；评估器当前未运行，新任务计 0 分钟。${estimateNote(anchorVersion)}`
      ),
      tone: 'warn'
    }
  }
  if (counted === 0)
    return {
      value: formatted,
      detail: tr(`0 assessed tasks; only AI work that finished assessment counts. ${estimateNote(anchorVersion)}`, `0 个已评估任务；只计完成评估的 AI 工作。${estimateNote(anchorVersion)}`),
      tone: totalTenths > 0 ? 'ok' : 'muted'
    }
  return {
    value: tr(`Est. ${formatted}`, `估计 ${formatted}`),
    detail: tr(`${counted} assessed tasks; only AI work that finished assessment counts. ${estimateNote(anchorVersion)}`, `${counted} 个已评估任务；只计完成评估的 AI 工作。${estimateNote(anchorVersion)}`),
    tone: totalTenths > 0 ? 'ok' : 'muted'
  }
}

/** X3 / R4-1: minutes are an estimate from anchors, not performance and not time saved. */
export function estimateNote(anchorVersion?: number | null): string {
  return tr(
    `Estimate (anchors v${anchorVersion ?? '?'}): not performance, not time saved.`,
    `估计值（anchors v${anchorVersion ?? '?'}）：不是绩效、不是节省时间。`
  )
}

/** Copy for the assessorEnabled toggle. */
export function assessorToggleText(a: HetAssessorStatus | undefined): { label: string; explain: string; note: string | null } {
  const explain = tr(
    "Off by default. When on, Navalia assesses finished AI tasks through Persome Runtime's [agent_funding] (the CLI you configured, e.g. Claude Code): at most one capped model call per task, capped per day and per round, using Runtime's daily call quota. The model only returns kind / size / complexity / adoption evidence; minutes are derived deterministically from the anchor table. When off, tasks are still recorded but count as 0 minutes.",
    '默认关闭。开启后，Navalia 通过 Persome Runtime 的 [agent_funding]（你配置的 CLI，例如 Claude Code）对已结束的 AI 任务做评估：每个任务至多一次有上限的模型调用，按日/按轮封顶，并占用 Runtime 的每日调用额度。模型只给出类型/规模/复杂度/采纳证据，分钟由锚点表确定性换算。关闭时任务照常记录，但计 0 分钟。'
  )
  const label = tr('Allow assessment', '允许评估')
  if (!a) return { label, explain, note: null }
  if (a.state === 'fixture')
    return { label, explain, note: tr('This dev build uses the test fixture assessor (not an LLM); this switch does not affect it.', '开发构建正在使用测试 fixture 评估器（非 LLM），此开关不影响它。') }
  if (a.enabled && !a.transport_present)
    return {
      label,
      explain,
      note: tr(
        'On, but this build has no assessor transport: no model will be called; tasks keep waiting for assessment and count as 0 minutes.',
        '已开启，但本构建没有可用的 assessor transport：不会调用任何模型，任务继续等待评估、计 0 分钟。'
      )
    }
  if (a.enabled && a.state === 'budget_unavailable')
    return { label, explain, note: tr(`On, but the budget is unavailable (${budgetReasonText(a.reason)}).`, `已开启，但预算不可用（${budgetReasonText(a.reason)}）。`) }
  return { label, explain, note: null }
}

/** OG-08 / D17: undo is offered only when the task carries a user correction. */
export function undoCorrectionLabel(t: Pick<HetTaskDto, 'correction'>): { show: boolean; text: string; title: string } {
  return {
    show: t.correction !== null,
    text: tr('Undo correction', '撤销修正'),
    title: t.correction
      ? tr(`Undo "${t.correction}" and recompute from the assessment and anchors`, `撤销「${t.correction}」，按评估结果与 anchors 重新计算`)
      : ''
  }
}

/**
 * OG-08 / HET-08: the retry control. Shown when tasks failed or the last update failed.
 * Retry re-queues failed tasks and runs one scan under the same gate and caps; with the
 * assessor off it makes no model call, so the hint says so instead of promising minutes.
 */
export function retryControl(
  s: Pick<HetSummary, 'failed' | 'state'> | undefined,
  gate: Pick<HetAssessorStatus, 'state'> | undefined
): { show: boolean; text: string; hint: string } {
  const show = !!s && (s.failed > 0 || s.state === 'updateFailed')
  const ready = gate?.state === 'ready' || gate?.state === 'fixture'
  return {
    show,
    text: tr('Retry failed tasks', '重试失败任务'),
    hint: ready
      ? tr('Put failed tasks back in the queue and scan once now (subject to per-scan / daily caps).', '把评估失败的任务放回队列并立即扫描一次（受每次 / 每日上限约束）。')
      : tr(
          'Put failed tasks back in the queue and rescan; the assessor is not ready, so no model will be called and they still count as 0 minutes.',
          '把评估失败的任务放回队列并重新扫描；评估器未就绪，不会调用模型，仍计 0 分钟。'
        )
  }
}

/**
 * X3 (R4-1) settings panel copy. One state line per gate state (spec wording), plus facts shown
 * only when the switch is on: client / model, Runtime daily budget, HET caps, anchors version.
 */
export function assessorPanelLines(i: HetAssessorInfo | undefined): {
  state: string
  stateTone: 'ok' | 'warn' | 'bad'
  facts: Array<{ label: string; value: string }>
} {
  if (!i) return { state: tr('Reading assessor status…', '读取评估器状态…'), stateTone: 'warn', facts: [] }
  let state: string
  let stateTone: 'ok' | 'warn' | 'bad' = 'warn'
  switch (i.state) {
    case 'disabled':
      state = tr('Assessor off, 0 minutes', '评估器未启用，0 分钟')
      break
    case 'no_transport':
      state = tr('This build has no assessor transport', '本构建没有可用的 assessor transport')
      break
    case 'budget_unavailable':
      state = tr(`Budget unavailable (${budgetReasonText(i.reason)})`, `预算不可用（${budgetReasonText(i.reason)}）`)
      stateTone = 'bad'
      break
    case 'fixture':
      state = tr('Test fixture assessor (not an LLM, dev builds only)', '测试 fixture 评估器（非 LLM，仅开发构建）')
      break
    default:
      state = tr(
        `Assessor available: minutes are estimates (anchors v${i.anchor_version ?? '?'}), not performance and not time saved`,
        `评估器可用：分钟为估计值（anchors v${i.anchor_version ?? '?'}），不是绩效、不是节省时间`
      )
      stateTone = 'ok'
  }
  const b = i.budget
  const facts = [
    {
      label: tr('Sent to', '发送给'),
      value: tr(
        `CLI provider configured in Persome Runtime: ${i.client || 'not configured'}`,
        `Persome Runtime 配置的 CLI 提供方：${i.client || '未配置'}`
      )
    },
    { label: tr('Model', '模型'), value: i.model ? i.model : tr("Provider subscription's default model", '提供方订阅默认模型') },
    {
      label: tr('Runtime daily quota', 'Runtime 每日额度'),
      value: !b
        ? tr('Unavailable', '读取不到')
        : !b.enabled
          ? tr('[agent_funding] is off', '[agent_funding] 未开启')
          : tr(
              `${b.used} / ${b.limit} used today, ${b.remaining} left${b.exhausted ? ' (used up)' : ''}`,
              `今日已用 ${b.used} / ${b.limit}，剩余 ${b.remaining}${b.exhausted ? '（已用完）' : ''}`
            )
    },
    {
      label: tr('HET caps', 'HET 上限'),
      value: tr(
        `${i.calls_today} / ${i.per_day_cap} calls today, ≤ ${i.per_tick_cap} per scan; failures are not retried`,
        `今日 ${i.calls_today} / ${i.per_day_cap} 次，每次扫描 ≤ ${i.per_tick_cap} 次；失败不重试`
      )
    },
    { label: tr('Anchor version', '锚点版本'), value: i.anchor_version === null ? '—' : `v${i.anchor_version}` }
  ]
  return { state, stateTone, facts }
}
