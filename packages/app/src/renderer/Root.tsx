import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import { ConnectionNotice } from './ConnectionNotice.tsx'
import { useDataStatus, useSettings } from './data.ts'
import { useTimeSettings } from './TimeSettings.ts'
import { DataScreen } from './views/DataScreen.tsx'
import { FirstLaunch } from './views/FirstLaunch.tsx'

function Opened() {
  const settings = useSettings()
  useTimeSettings(settings)
  const [addFactoryFirst, setAddFactoryFirst] = useState(false)
  if (!settings) return null
  if (!settings.firstLaunchDone) {
    return <FirstLaunch settings={settings} onFinish={setAddFactoryFirst} />
  }
  return <App addFactoryFirst={addFactoryFirst} />
}

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
    return <Opened key={generation} />
  }
  return (
    <>
      <ConnectionNotice />
      {status && status.state !== 'opening' && <DataScreen status={status} />}
    </>
  )
}
