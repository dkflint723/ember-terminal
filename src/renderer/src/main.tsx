import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Boom } from './components/Boom'
import { Detonator } from './components/Detonator'
import './styles/global.css'

/*
 * What nothing else caught, sent to ember.log.
 *
 * The renderer's own console was the only place these went, and a packaged build
 * has none open — so a bug report's log described main alone. Only script errors:
 * a failed image load fires 'error' too, but on the element, and does not reach
 * this listener, which is not in the capture phase.
 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
/*
 * Two things that arrive here and are not faults.
 *
 * Monaco cancels work it has superseded — a suggestion typed past, a hover moved
 * off — by rejecting with an error it names `Canceled`, and leaves some of those
 * rejections unhandled by design; verify-ghost measured one per inline-suggestion
 * session. And a ResizeObserver whose callback changes layout gets the rest of its
 * notifications on the next frame, which the browser reports as an error although
 * the specification calls it the intended behaviour. Written down, either would put
 * a line in the log for ordinary use and fail every suite that types or resizes.
 */
function benign(value: unknown, message?: string): boolean {
  if (value instanceof Error && value.name === 'Canceled' && value.message === 'Canceled') return true
  return /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(
    message ?? (value instanceof Error ? value.message : '')
  )
}

window.addEventListener('error', (e) => {
  if (benign(e.error, e.message)) return
  window.ember.reportError(
    'error',
    e.error !== undefined && e.error !== null
      ? describe(e.error)
      : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`
  )
})
window.addEventListener('unhandledrejection', (e) => {
  if (benign(e.reason)) return
  window.ember.reportError('unhandled rejection', describe(e.reason))
})

const host = document.getElementById('root')
if (!host) throw new Error('Root element missing from index.html')

/**
 * Deliberately not wrapped in StrictMode: terminal controllers own native pty
 * sessions, and StrictMode's double-invoked effects would spawn two shells per
 * pane in development.
 */
createRoot(host).render(
  <Boom>
    <Detonator />
    <App />
  </Boom>
)
