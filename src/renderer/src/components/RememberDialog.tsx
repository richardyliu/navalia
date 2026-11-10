import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from './Modal'
import { doneToast } from './Toaster'
import { api, errorMessage } from '../lib/api'
import { tr } from '../lib/i18n'

export function RememberDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [result, setResult] = useState<{ entry_id: string; file: string } | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.remember(content.trim(), tags.trim()),
    onSuccess: async (data) => {
      setResult({ entry_id: data.entry_id, file: data.file })
      doneToast(tr('Saved to memory', '已写入记忆'))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['search-memory'] }),
        queryClient.invalidateQueries({ queryKey: ['recent'] }),
        queryClient.invalidateQueries({ queryKey: ['graph'] })
      ])
    }
  })

  return (
    <Modal
      title={tr('Remember something', '记住一条')}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {tr('Close', '关闭')}
          </button>
          <button
            className="btn primary"
            onClick={() => mutation.mutate()}
            disabled={!content.trim() || mutation.isPending}
          >
            {mutation.isPending ? tr('Saving…', '写入中…') : tr('Save to memory', '写入记忆')}
          </button>
        </>
      }
    >
      <p className="muted small">
        {tr(
          'Writes to durable memory (tagged source:agent-run automatically). It is redacted first, and a system dialog shows exactly what will be written. No LLM, no quota used; the next build brings it into the model.',
          '写入持久记忆（自动加 source:agent-run 标签）。写入前会脱敏，并弹出系统确认框显示将写入的内容。不走 LLM，不消耗额度；下次 build 会进入模型。'
        )}
      </p>
      <textarea
        className="textarea"
        rows={5}
        placeholder={tr(
          'One self-contained fact, e.g. The user prefers local-first tools that keep data on this machine.',
          '一条自包含的事实，例如：用户偏好本地优先、数据不出本机的工具。'
        )}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <input
        className="input"
        placeholder={tr('Optional tags, comma separated, e.g. preference,privacy', '可选标签，逗号分隔，例如：preference,privacy')}
        value={tags}
        onChange={(event) => setTags(event.target.value)}
      />
      {mutation.isError ? <div className="banner bad compact">{errorMessage(mutation.error)}</div> : null}
      {result ? (
        <div className="banner ok compact">
          {tr('Saved to ', '已写入 ')}<code>{result.file}</code>{tr(', entry id ', '，entry id ')}<code>{result.entry_id}</code>{tr('.', '。')}
        </div>
      ) : null}
    </Modal>
  )
}
