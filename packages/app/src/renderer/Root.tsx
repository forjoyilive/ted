import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import { ConnectionNotice } from './ConnectionNotice.tsx'
import { useDataStatus } from './data.ts'
import { DataScreen } from './views/DataScreen.tsx'

export function Root() {
  const status = useDataStatus()
  const [generation, setGeneration] = useState(0)
  const [opened, setOpened] = useState(false)
  const state = status?.state

  useEffect(() => {
    if (state === 'ready') setOpened(true)
    else if (state !== undefined && state !== 'opening') setGeneration((n) => n + 1)
  }, [state])

  if (status?.state === 'ready' || (status?.state === 'opening' && opened)) {
    return <App key={generation} />
  }
  return (
    <>
      <ConnectionNotice />
      {status && status.state !== 'opening' && <DataScreen status={status} />}
    </>
  )
}
