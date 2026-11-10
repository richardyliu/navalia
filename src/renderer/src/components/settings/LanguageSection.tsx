import { useState } from 'react'
import { changeLocale, LOCALE_LABELS, LOCALES, tr, useLocale } from '../../lib/i18n'

/** UI language picker. Saved in `<LensStore>/locale.json`; applies immediately, no restart. */
export function LanguageSection() {
  const locale = useLocale()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="card" data-testid="language-section">
      <div className="card-head">
        <h3>{tr('Language', '语言')}</h3>
        <div className="segmented" role="radiogroup" aria-label={tr('Language', '语言')}>
          {LOCALES.map((l) => (
            <button
              key={l}
              role="radio"
              aria-checked={locale === l}
              lang={l === 'zh' ? 'zh-CN' : 'en'}
              className={`seg-btn ${locale === l ? 'active' : ''}`}
              disabled={busy}
              onClick={() => {
                if (l === locale) return
                setBusy(true)
                setError(null)
                void changeLocale(l)
                  .then((message) => setError(message))
                  .catch(() => setError(tr('Could not save language setting', '保存语言设置失败')))
                  .finally(() => setBusy(false))
              }}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        {tr(
          'Interface language. Your memories, notes and generated briefs keep their original language.',
          '界面语言。记忆、笔记和生成的简报保持原有语言。'
        )}
      </p>
      {error ? <div className="banner bad compact">{error}</div> : null}
    </div>
  )
}
