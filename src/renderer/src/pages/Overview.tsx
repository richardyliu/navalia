import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BuildPanel } from '../components/BuildPanel'
import { ModelIssues } from '../components/ModelIssues'
import { StatCard } from '../components/StatCard'
import { StateBanner } from '../components/StateBanner'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, formatNumber, statusTone } from '../lib/format'
import { modelIssuesView } from '../lib/modelIssues'
import { useDiscover, useGraph, usePermissions, useStatus } from '../lib/queries'
import { tr } from '../lib/i18n'

export function Overview() {
  const queryClient = useQueryClient()
  const discover = useDiscover()
  const status = useStatus()
  const graph = useGraph(status.isSuccess)
  const permissions = usePermissions(status.isSuccess)
  const [actionError, setActionError] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: api.startRuntime,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['discover'] }),
        queryClient.invalidateQueries({ queryKey: ['status'] }),
        queryClient.invalidateQueries({ queryKey: ['graph'] })
      ])
    }
  })

  const build = graph.data?.model.build
  const stats = graph.data?.model.stats
  const root = graph.data?.model.root
  const issues = modelIssuesView(graph.data)

  async function openViewer(kind: 'viewer' | 'root' = 'viewer'): Promise<void> {
    try {
      await api.open(kind)
    } catch (error) {
      setActionError(errorMessage(error))
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h2>{tr('Local memory overview', '本地记忆总览')}</h2>
          <p className="muted">{tr('Reads only the local Runtime; no sign-in, no network.', '只读本地 Runtime，不登录、不联网。')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => void openViewer('viewer')}>
            {tr('Open official viewer', '打开官方查看器')}
          </button>
          <button className="btn ghost" onClick={() => void openViewer('root')}>
            {tr('Data folder', '数据目录')}
          </button>
        </div>
      </header>

      {status.isError ? (
        <StateBanner
          error={status.error}
          info={discover.data}
          onStart={() => start.mutate()}
          starting={start.isPending}
        />
      ) : null}

      {start.isError ? <div className="banner bad compact">{errorMessage(start.error)}</div> : null}
      {actionError ? <div className="banner bad compact">{actionError}</div> : null}

      <section className="grid stats">
        <StatCard
          label={tr('Capture', '采集')}
          value={status.data?.capture ?? '—'}
          detail={status.data?.daemon ?? ''}
          tone={statusTone(status.data?.capture)}
        />
        <StatCard
          label={tr('Last capture', '最后采集')}
          value={status.data?.last_capture ?? '—'}
          detail={status.data?.buffer ?? ''}
          tone={status.data ? 'ok' : 'muted'}
        />
        <StatCard
          label={tr('Memory', '记忆')}
          value={status.data?.memory ?? '—'}
          detail={status.data?.sessions ?? ''}
          tone={status.data ? 'ok' : 'muted'}
        />
        <StatCard
          label={tr('Model', '模型')}
          value={build ? build.status : '—'}
          detail={stats ? `${formatNumber(stats.points)} Points · ${formatNumber(stats.faces)} Faces` : ''}
          tone={statusTone(build?.status)}
        />
      </section>

      <section className="grid two">
        <div className="card">
          <div className="card-head">
            <h3>{tr('Model build', '模型构建')}</h3>
            <span className={`chip ${statusTone(build?.status)}`}>{build?.status ?? tr('unknown', '未知')}</span>
          </div>
          {build ? (
            <dl className="kv">
              <div>
                <dt>build id</dt>
                <dd className="mono">{build.build_id ?? '—'}</dd>
              </div>
              <div>
                <dt>{tr('Completed', '完成时间')}</dt>
                <dd>{formatDateTime(build.completed_at)}</dd>
              </div>
              <div>
                <dt>{tr('Geometry', '几何')}</dt>
                <dd>
                  {formatNumber(stats?.points)} Points · {formatNumber(stats?.evolution_lines)}{' '}
                  {tr('evolution lines', '演化线')} · {formatNumber(stats?.relation_lines)} {tr('relation lines', '关系线')}
                </dd>
              </div>
              <div>
                <dt>{tr('Layers', '层级')}</dt>
                <dd>
                  {formatNumber(stats?.faces)} Faces · {formatNumber(stats?.volumes)} Volumes ·{' '}
                  {stats?.roots ?? 0} Root
                </dd>
              </div>
              <div>
                <dt>Root</dt>
                <dd>{root ? root.signature.slice(0, 120) : tr('Not formed yet (model is empty)', '还没有形成（模型为空）')}</dd>
              </div>
              {build.degraded_stages?.length ? (
                <div>
                  <dt>{tr('Degraded stages', '降级阶段')}</dt>
                  <dd className="warn-text">{build.degraded_stages.join(', ')}</dd>
                </div>
              ) : null}
              {issues.codes.length > 0 || issues.stages.length > 0 || issues.showCliOnlyNote ? (
                <div>
                  <dt>{tr('Degraded reasons', '降级原因')}</dt>
                  <dd>
                    <ModelIssues view={issues} />
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="muted">
              {graph.isLoading
                ? tr('Loading model…', '正在读取模型…')
                : status.isError
                  ? tr('Runtime is not connected; cannot read model status.', 'Runtime 未连接，无法读取模型状态。')
                  : tr('No model data yet. Run a build in the terminal first.', '还没有模型数据。先在终端运行一次 build。')}
            </p>
          )}
          <BuildPanel />
        </div>

        <div className="card">
          <div className="card-head">
            <h3>{tr('Permissions and index', '权限与索引')}</h3>
          </div>
          <dl className="kv">
            <div>
              <dt>Accessibility</dt>
              <dd>
                <span className={`chip ${statusTone(permissions.data?.accessibility)}`}>
                  {permissions.data?.accessibility ?? '—'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Screen Recording</dt>
              <dd>
                <span className={`chip ${statusTone(permissions.data?.screen_recording)}`}>
                  {permissions.data?.screen_recording ?? '—'}
                </span>
              </dd>
            </div>
            <div>
              <dt>{tr('Index', '索引')}</dt>
              <dd>{typeof status.data?.index_health?.status === 'string' ? status.data.index_health.status : '—'}</dd>
            </div>
            <div>
              <dt>{tr('Timeline', '时间线')}</dt>
              <dd>{status.data?.timeline ?? '—'}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd className="mono small">
                {discover.data ? `${discover.data.root} · :${discover.data.port}` : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  )
}
