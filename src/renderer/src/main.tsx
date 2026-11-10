import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { QuickBox } from './components/quickbox/QuickBox'
import { QUICKBOX_HASH } from '../../main/shell/api'
import { LocaleBoundary, loadInitialLocale } from './lib/i18n'
import './styles/app.css'

// Never let a dropped file navigate the window (it would load with the preload API).
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 5_000
    }
  }
})

void loadInitialLocale().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <LocaleBoundary>
          {/* OG-04: the Quick Box window loads the same document with #quickbox. */}
          {window.location.hash === QUICKBOX_HASH ? <QuickBox /> : <App />}
        </LocaleBoundary>
      </QueryClientProvider>
    </React.StrictMode>
  )
})
