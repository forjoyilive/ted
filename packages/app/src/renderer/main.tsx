import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/tokens.css'
import './styles/base.css'
import { createRoot } from 'react-dom/client'
import { ConnectionContext, useConnectionState } from './data.ts'
import { Root } from './Root.tsx'
import { WorkerWindow } from './WorkerWindow.tsx'

function Connected() {
  return (
    <ConnectionContext value={useConnectionState()}>
      <Root />
    </ConnectionContext>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  new URLSearchParams(location.search).has('worker') ? <WorkerWindow /> : <Connected />,
)
