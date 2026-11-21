import type { DaemonConnection } from '@ted/daemon/launch'
import type { Banner } from '@ted/protocol'
import { useState } from 'react'
import { type BannerMenuItem, BannerStack, MenuButton } from './components/BannerStack.tsx'
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { useConnection } from './data.ts'
import { ted } from './ted.ts'

const keepsStoppingProblem = 'daemon-keeps-stopping'

export function keepsStoppingBanner(connection: DaemonConnection): Banner[] {
  if (connection.state !== 'stopped') return []
  return [
    {
      id: `${keepsStoppingProblem}:app`,
      problem: keepsStoppingProblem,
      severity: 'stops-work',
      text: 'Ted’s background process keeps stopping',
      action: { label: 'Restart' },
      raisedAt: connection.crashes.at(-1) ?? new Date().toISOString(),
    },
  ]
}

export const keepsStoppingMenu = (banner: Banner): BannerMenuItem[] | undefined =>
  banner.problem === keepsStoppingProblem
    ? [
        {
          label: 'Restart Ted in the background',
          onSelect: () => ted.restartDaemon().catch((error: unknown) => console.error(error)),
        },
        {
          label: 'Copy report',
          onSelect: () => ted.copyCrashReport().catch((error: unknown) => console.error(error)),
        },
      ]
    : undefined

export function ConnectionNotice() {
  const { connection } = useConnection()
  if (connection.state === 'reconnecting') return <ReconnectingBar />
  return connection.state === 'stopped' ? <StoppedConnectionNotice connection={connection} /> : null
}

export function StoppedConnectionNotice({ connection }: { connection: DaemonConnection }) {
  const [dismissedAt, setDismissedAt] = useState<string>()
  const [banner] = keepsStoppingBanner(connection)
  if (!banner) return null
  const items = keepsStoppingMenu(banner)
  if (dismissedAt === banner.raisedAt && items) {
    return (
      <section aria-label="Background process">
        <MenuButton label="Restart" items={items} />
      </section>
    )
  }
  return (
    <BannerStack
      label="Problems"
      banners={[banner]}
      onAction={() => undefined}
      onDismiss={() => setDismissedAt(banner.raisedAt)}
      menu={keepsStoppingMenu}
    />
  )
}
