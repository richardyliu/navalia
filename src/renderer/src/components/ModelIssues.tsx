import type { ModelIssuesView } from '../lib/modelIssues'
import { tr } from '../lib/i18n'

/** MOD-13: literal Runtime reason codes next to their Chinese explanation. Renders nothing when there is nothing to say. */
export function ModelIssues({ view }: { view: ModelIssuesView }) {
  if (view.codes.length === 0 && view.stages.length === 0 && !view.showCliOnlyNote) return null
  return (
    <div className="model-issues" data-testid="model-issues">
      {view.codes.length > 0 ? (
        <ul className="issue-list" data-testid="model-issue-codes">
          {view.codes.map((item) => (
            <li key={`code-${item.code}`}>
              <code className="mono">{item.code}</code> <span>{item.explanation}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.stages.length > 0 ? (
        <ul className="issue-list" data-testid="model-degraded-stages">
          {view.stages.map((item) => (
            <li key={`stage-${item.code}`}>
              <code className="mono">{item.code}</code> <span>{item.explanation}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.showCliOnlyNote ? (
        <p className="muted small" data-testid="model-issues-cli-only">
          {tr(
            'Runtime REST did not return per-layer reason codes; only the terminal command ',
            'Runtime REST 未返回逐层原因码；当前只有终端'
          )}
          {tr('', ' ')}
          <code>persome model status</code>
          {tr(' prints them. Navalia does not infer these codes itself.', ' 会打印。Navalia 不自行推算这些代码。')}
        </p>
      ) : null}
    </div>
  )
}
