import { useEffect, useState } from 'react'
import { App, type AppStart } from './App.tsx'
import { ConnectionNotice } from './ConnectionNotice.tsx'
import { LoadingError, LoadingScreen } from './components/Loading.tsx'
import { useDataStatusState, useSettingsState } from './data.ts'
import { useTimeSettings } from './TimeSettings.ts'
import { DataScreen } from './views/DataScreen.tsx'
import { Onboarding } from './views/Onboarding.tsx'

function Opened() {
  const resource = useSettingsState()
  const settings = resource.settings
  useTimeSettings(settings)
  const [start, setStart] = useState<AppStart>()
  if (!settings)
    return resource.error ? (
      <LoadingError error={resource.error} retry={resource.retry} />
    ) : (
      <LoadingScreen />
    )
  if (!settings.firstLaunchDone) {
    return <Onboarding settings={settings} onFinish={setStart} />
  }
  return <App start={start} />
}

export function Root() {
  const resource = useDataStatusState()
  const status = resource.status
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
      {resource.error ? (
        <LoadingError error={resource.error} retry={resource.retry} />
      ) : status && status.state !== 'opening' ? (
        <DataScreen status={status} />
      ) : (
        <LoadingScreen />
      )}
    </>
  )
}
