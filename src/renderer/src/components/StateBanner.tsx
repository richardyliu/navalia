import type { RuntimeLocationInfo } from '../../../shared/types'
import { errorMessage } from '../lib/api'
import { tr } from '../lib/i18n'

export function StateBanner({
  error,
  info,
  onStart,
  starting
}: {
  error: unknown
  info?: RuntimeLocationInfo
  onStart: () => void
  starting: boolean
}) {
  const message = errorMessage(error)

  if (!info?.rootExists) {
    return (
      <div className="banner bad">
        <div>
          <strong>{tr('Local Runtime not found', '没有找到本地 Runtime')}</strong>
          <p>
            {tr('Expected directory: ', '预期目录：')}
            <code>{info?.root ?? '~/.persome'}</code>
            {tr('. Install the open-source Runtime first:', '。请先安装开源 Runtime：')}
            <code> git clone https://github.com/Intuition-Lab/personal-model</code>
            {tr(', then run ', ' 后运行 ')}
            <code>bash install.sh --no-client-config</code>
            {tr('.', '。')}
          </p>
        </div>
      </div>
    )
  }

  if (!info?.tokenPresent) {
    return (
      <div className="banner warn">
        <div>
          <strong>{tr('Runtime has no token yet', 'Runtime 还没初始化 token')}</strong>
          <p>
            {tr('Run ', '运行 ')}
            <code>persome start</code>
            {tr(' to create the token and local API. Current directory: ', ' 生成 token 与本地 API。当前目录：')}
            <code>{info?.root}</code>
          </p>
        </div>
        <button className="btn primary" onClick={onStart} disabled={starting}>
          {starting ? tr('Starting…', '启动中…') : tr('Start Runtime', '启动 Runtime')}
        </button>
      </div>
    )
  }

  return (
    <div className="banner warn">
      <div>
        <strong>{tr('Cannot reach Runtime', '连不上 Runtime')}</strong>
        <p>
          {message}
          {tr('. Check that ', '。确认 ')}
          <code>persome status</code>
          {tr(' is healthy, or start it with the button on the right.', ' 正常，或点右侧按钮启动。')}
        </p>
      </div>
      <button className="btn primary" onClick={onStart} disabled={starting}>
        {starting ? tr('Starting…', '启动中…') : tr('Start Runtime', '启动 Runtime')}
      </button>
    </div>
  )
}
