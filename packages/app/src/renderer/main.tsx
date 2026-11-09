import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/tokens.css'
import './styles/base.css'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ConnectionContext, useConnectionState } from './data.ts'

function Root() {
  return (
    <ConnectionContext value={useConnectionState()}>
      <App />
    </ConnectionContext>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
