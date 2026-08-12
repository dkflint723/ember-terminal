import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

const host = document.getElementById('root')
if (!host) throw new Error('Root element missing from index.html')

/**
 * Deliberately not wrapped in StrictMode: terminal controllers own native pty
 * sessions, and StrictMode's double-invoked effects would spawn two shells per
 * pane in development.
 */
createRoot(host).render(<App />)
