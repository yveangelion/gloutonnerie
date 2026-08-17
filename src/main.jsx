// Entry point: mounts the App component (src/App.jsx) into the <div id="root"> from
// index.html. StrictMode only affects development (double-renders/effects to surface
// non-idempotent side effects) — no effect in production.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
