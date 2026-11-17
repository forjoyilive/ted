import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/tokens.css'
import './styles/base.css'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { reportRenderError, watchCrashes } from './crash-reports.ts'
import { ConnectionContext, useConnectionState } from './data.ts'
import { recoverMessageDrafts } from './message-drafts.ts'
import { Root } from './Root.tsx'
import { watchTypedArrows } from './typed-arrows.ts'
import { WorkerWindow } from './WorkerWindow.tsx'

watchCrashes(window)
watchTypedArrows(document)

function Connected() {
  const connection = useConnectionState()
  useEffect(() => {
    if (connection.connection.state === 'connected') void recoverMessageDrafts()
  }, [connection])
  return (
    <ConnectionContext value={connection}>
      <Root />
    </ConnectionContext>
  )
}

createRoot(document.getElementById('root') as HTMLElement, {
  onUncaughtError: reportRenderError,
}).render(new URLSearchParams(location.search).has('worker') ? <WorkerWindow /> : <Connected />)
