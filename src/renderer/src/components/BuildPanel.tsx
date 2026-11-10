import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, errorMessage } from '../lib/api'
import { useBudget, useBuildStatus } from '../lib/queries'
import { copiedToast } from './Toaster'
import { tr } from '../lib/i18n'

export function BuildPanel() {
  const queryClient = useQueryClient()
  const budget = useBudget()
  const status = useBuildStatus()
  const [started, setStarted] = useState(false)

  const start = useMutation({
    mutationFn: api.buildStart,
    onSuccess: async () => {
      setStarted(true)
      await queryClient.invalidateQueries({ queryKey: ['build-status'] })
    }
  })
  const cancel = useMutation({ mutationFn: api.buildCancel })

  useEffect(() => {
    if (!started) return
    if (status.data && !status.data.running) {
      setStarted(false)
      void queryClient.invalidateQueries({ queryKey: ['graph'] })
      void queryClient.invalidateQueries({ queryKey: ['status'] })
      void queryClient.invalidateQueries({ queryKey: ['patterns'] })
    }
  }, [started, status.data, queryClient])

  const running = status.data?.running ?? false
  const exhausted = budget.data?.exhausted ?? false
  const lines = status.data?.lines ?? []

  return (
    <div className="build-panel">
      <div className="card-foot wrap">
        <button
          className="btn primary small"
          onClick={() => start.mutate()}
          disabled={running || exhausted || start.isPending}
          title={exhausted ? tr('LLM quota used up; build again tomorrow', 'LLM 额度已用尽，明天再构建') : tr('Run persome model build', '运行 persome model build')}
        >
          {running ? tr('Building…', '构建中…') : exhausted ? tr('Quota used up', '额度用尽') : tr('Build model', '构建模型')}
        </button>
        {running ? (
          <button className="btn ghost small" onClick={() => cancel.mutate()}>
            {tr('Cancel', '取消')}
          </button>
        ) : null}
        <button
          className="btn ghost small"
          onClick={() => void api.copy('persome model build').then(() => copiedToast(tr('command', '命令')))}
        >
          {tr('Copy command', '复制命令')}
        </button>
        {status.data?.finishedAt ? (
          <span className={`chip ${status.data.exitCode === 0 ? 'ok' : 'warn'}`}>
            {status.data.exitCode === 0
              ? tr('Last run succeeded', '上次成功')
              : tr(`Exit code ${status.data.exitCode ?? '—'}`, `退出码 ${status.data.exitCode ?? '—'}`)}
          </span>
        ) : null}
      </div>

      {start.isError ? <div className="banner bad compact">{errorMessage(start.error)}</div> : null}
      {cancel.isError ? <div className="banner bad compact">{errorMessage(cancel.error)}</div> : null}
      {status.data?.error ? <div className="banner bad compact">{status.data.error}</div> : null}

      {running || lines.length ? (
        <pre className="build-log">{lines.slice(-12).join('\n') || tr('Waiting for output…', '等待输出…')}</pre>
      ) : null}
    </div>
  )
}
