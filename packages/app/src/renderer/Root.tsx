import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import { useDataStatus } from './data.ts'
import { DataScreen } from './views/DataScreen.tsx'

export function Root() {
  const status = useDataStatus()
  const [generation, setGeneration] = useState(0)
  const state = status?.state

  useEffect(() => {
    if (state !== undefined && state !== 'ready') setGeneration((n) => n + 1)
  }, [state])

  if (!status || status.state === 'opening') return null
  if (status.state !== 'ready') return <DataScreen status={status} />
  return <App key={generation} />
}
