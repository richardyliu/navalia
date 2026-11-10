import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from './Modal'
import { doneToast } from './Toaster'
import type { CorrectResult } from '../../../shared/types'
import { api, errorMessage } from '../lib/api'
import { tr } from '../lib/i18n'

export function CorrectDialog({
  label,
  onClose
}: {
  label?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [result, setResult] = useState<CorrectResult | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.correct(text.trim()),
    onSuccess: async (data) => {
      setResult(data)
      doneToast(tr('Correction applied', '已应用纠正'))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['graph'] }),
        queryClient.invalidateQueries({ queryKey: ['evidence'] }),
        queryClient.invalidateQueries({ queryKey: ['search-memory'] }),
        queryClient.invalidateQueries({ queryKey: ['patterns'] })
      ])
    }
  })

  return (
    <Modal
      title={tr('Correct memory', '纠正记忆')}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {tr('Close', '关闭')}
          </button>
          <button
            className="btn primary"
            onClick={() => mutation.mutate()}
            disabled={!text.trim() || mutation.isPending}
          >
            {mutation.isPending ? tr('Applying…', '应用中…') : tr('Apply correction', '应用纠正')}
          </button>
        </>
      }
    >
      {label ? <p className="muted small">{tr(`About: ${label}`, `针对：${label}`)}</p> : null}
      <p className="muted small">
        {tr(
          'Describe what is wrong in plain language. Runtime traces it back to the source facts, keeps the receipt, and records this correction; it may call the LLM.',
          '用自然语言说明哪里错了。Runtime 会回溯到来源事实、保留回执，并记录这次纠正；可能调用 LLM。'
        )}
      </p>
      <textarea
        className="textarea"
        rows={5}
        placeholder={tr('e.g. Peach is my coworker, not me.', '例如：Peach 是我的同事，不是我。')}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {mutation.isError ? <div className="banner bad compact">{errorMessage(mutation.error)}</div> : null}
      {result ? (
        <div className={`banner ${result.ok ? 'ok' : 'warn'} compact`}>
          {tr('Result: ', '结果：')}kind={result.kind} · applied={String(result.applied)}
          {result.reason ? ` · ${result.reason}` : ''}
        </div>
      ) : null}
    </Modal>
  )
}
