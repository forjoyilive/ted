import type { LayerKind } from '@ted/protocol'
import type { FactorySettingsView } from '@ted/protocol/factory-settings'
import { accessHolderLabel } from '@ted/protocol/sandbox-access'
import { type SandboxAccess, socketOf } from '@ted/protocol/sandbox-groups'
import {
  type SandboxOpening,
  type SandboxSummary,
  sandboxOpenings,
  sandboxSummary,
} from '@ted/protocol/sandbox-openings'
import { type ReactNode, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { useSettings } from '../data.ts'
import { settingsAccessHolders } from '../factory-settings.ts'
import { readableError, ted } from '../ted.ts'
import base from './FactorySettings.module.css'
import { SectionHeading } from './FactorySettingsSections.tsx'
import styles from './SandboxSection.module.css'

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'

export function SandboxSection({
  view,
  onOpenPermissions,
  onOpenRepos,
  onOpenChecks,
  onOpenProviders,
}: {
  view: Pick<
    FactorySettingsView,
    | 'factoryId'
    | 'permissions'
    | 'sandboxSockets'
    | 'sandboxSocketsFrom'
    | 'electronApps'
    | 'repos'
    | 'checks'
  >
  onOpenPermissions: () => void
  onOpenRepos: () => void
  onOpenChecks: () => void
  onOpenProviders: () => void
}) {
  const settings = useSettings()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const openings = sandboxOpenings({
    permissions: settings?.factoryPermissions[view.factoryId] ?? view.permissions,
    appsOutsideSandbox: settings?.appsOutsideSandbox[view.factoryId] ?? [],
    piUnsandboxedAllowed: settings?.piUnsandboxedAllowed ?? false,
    sockets: view.sandboxSockets,
    ...(view.sandboxSocketsFrom && { socketsFrom: view.sandboxSocketsFrom }),
    electronApps: view.electronApps,
    access: settingsAccessHolders(view),
  })

  const stopAllowing = async (repo: string, app: string) => {
    setBusy(app)
    setError(undefined)
    try {
      const current = await ted.getSettings()
      const kept = (current.appsOutsideSandbox[view.factoryId] ?? []).filter(
        (a) => a.repo !== repo || a.app !== app,
      )
      const { [view.factoryId]: _, ...others } = current.appsOutsideSandbox
      await ted.updateSettings({
        appsOutsideSandbox: kept.length > 0 ? { ...others, [view.factoryId]: kept } : others,
      })
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const action = (opening: SandboxOpening): ReactNode => {
    switch (opening.kind) {
      case 'bypass':
        return (
          <Button size="small" onClick={onOpenPermissions}>
            Open Permission mode
          </Button>
        )
      case 'app-outside':
        return (
          <Button
            size="small"
            disabled={busy !== undefined}
            onClick={() => void stopAllowing(opening.repo, opening.app)}
          >
            Stop allowing
          </Button>
        )
      case 'pi-unsandboxed':
        return (
          <Button size="small" onClick={onOpenProviders}>
            Open Providers
          </Button>
        )
      case 'electron-app':
        return (
          <Button size="small" onClick={onOpenRepos}>
            Open Repos
          </Button>
        )
      case 'access-group':
        return (
          <Button size="small" onClick={opening.holder === 'check' ? onOpenChecks : onOpenRepos}>
            {opening.holder === 'check' ? 'Open Checks' : 'Open Repos'}
          </Button>
        )
      case 'socket':
        return null
    }
  }

  const summary = sandboxSummary(openings)
  return (
    <section className={`${base.section} ${base.compactSection}`} aria-labelledby="sandbox">
      <SectionHeading
        id="sandbox"
        setting="factory.sandbox"
        title="Sandbox"
        where="both"
        help="Everything that widens Ted’s sandbox for this Factory, or runs something outside it."
      />
      <p className={base.caption}>
        Checks, Apps and worktree setup run in Ted’s sandbox. These settings widen it or let
        something run outside it.
      </p>
      <SummaryLine summary={summary} />
      {error && (
        <p role="alert" className={base.fieldError}>
          {error}
        </p>
      )}
      {openings.length > 0 && (
        <ul className={styles.list} aria-label="Sandbox openings">
          {openings.map((opening) => {
            const row = describe(opening)
            return (
              <li key={rowKey(opening)} className={styles.row}>
                <div className={styles.text}>
                  <div className={styles.name}>
                    <span>{row.name}</span>
                    {opening.unsandboxed ? (
                      <span className={styles.unsandboxedTag}>Unsandboxed</span>
                    ) : (
                      <span className={styles.widensTag}>Widens sandbox</span>
                    )}
                    {opening.kind === 'pi-unsandboxed' && (
                      <span className={base.machineChip}>Every Auto Factory</span>
                    )}
                  </div>
                  <p className={styles.what}>{row.what}</p>
                  <p className={styles.where}>{row.where}</p>
                </div>
                <div className={styles.action}>{action(opening)}</div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function SummaryLine({ summary }: { summary: SandboxSummary }) {
  switch (summary.kind) {
    case 'closed':
      return (
        <p className={`${styles.summary} ${styles.closed}`} data-summary="closed">
          <strong>Nothing widens the sandbox.</strong>
          <span>Every check, App and setup command runs with the base sandbox.</span>
        </p>
      )
    case 'widened':
      return (
        <p className={`${styles.summary} ${styles.widened}`} data-summary="widened">
          <strong>Nothing runs outside the sandbox.</strong>
          <span>
            {summary.count === 1
              ? '1 setting widens what sandboxed commands can reach.'
              : `${summary.count} settings widen what sandboxed commands can reach.`}
          </span>
        </p>
      )
    case 'unsandboxed':
      return (
        <p className={`${styles.summary} ${styles.unsandboxed}`} data-summary="unsandboxed">
          <strong>
            {summary.count === 1
              ? '1 thing runs outside the sandbox.'
              : `${summary.count} things run outside the sandbox.`}
          </strong>
          <span>Listed first below.</span>
        </p>
      )
  }
}

function rowKey(opening: SandboxOpening): string {
  switch (opening.kind) {
    case 'app-outside':
      return `app-outside:${opening.repo}:${opening.app}`
    case 'socket':
      return `socket:${opening.socket}`
    case 'electron-app':
      return `electron:${opening.repo}:${opening.app}`
    case 'access-group':
      return `access:${opening.holder}:${opening.repo ?? ''}:${opening.name}:${opening.group}`
    default:
      return opening.kind
  }
}

interface OpeningText {
  name: ReactNode
  what: string
  where: ReactNode
}

function describe(opening: SandboxOpening): OpeningText {
  switch (opening.kind) {
    case 'bypass':
      return {
        name: 'Bypass',
        what: 'Agents act without asking, and agent-started checks and Apps run outside the sandbox.',
        where: `Permission mode, saved on ${machine} for this Factory.`,
      }
    case 'app-outside':
      return {
        name: `App “${opening.app}” runs outside the sandbox`,
        what: 'When you start it with ▶, it runs as you: it can read and change any file and use the network.',
        where: `Approved on ${machine} when you chose to always run it outside the sandbox. Ted asks again if its command changes.`,
      }
    case 'pi-unsandboxed':
      return {
        name: 'Pi may run without a sandbox',
        what: 'If Ted’s sandbox stops working, Pi runs every command without asking.',
        where: `Settings → Providers → Pi, saved on ${machine}. Applies to every Auto Factory.`,
      }
    case 'socket':
      return {
        name: (
          <>
            Socket <code className={styles.code}>{opening.socket}</code> at{' '}
            <code className={styles.code}>{opening.path}</code>
          </>
        ),
        what: `Apps, Checks and worktree setup that list socket:${opening.socket} in sandbox_access can connect to it and use whatever listens on it.`,
        where: <SocketSource from={opening.from} />,
      }
    case 'electron-app':
      return {
        name: `Electron App “${opening.app}”`,
        what: 'It gets the electron access group: its sandbox can reach launchservicesd and the window server, which Electron needs to start and open a window.',
        where: (
          <>
            From <code className={styles.code}>electron: true</code> on the App in the{' '}
            {opening.repo} repo’s entry in <code className={styles.code}>.ted/workflow.yaml</code>.
            Remove it in a Task to turn it off.
          </>
        ),
      }
    case 'access-group':
      return {
        name: (
          <>
            {accessHolderLabel({
              kind: opening.holder,
              ...(opening.repo !== undefined && { repo: opening.repo }),
              name: opening.name,
            })}{' '}
            has <code className={styles.code}>{opening.group}</code>
          </>
        ),
        what: accessWhat(opening.group),
        where: (
          <>
            From <code className={styles.code}>sandbox_access</code> in{' '}
            <code className={styles.code}>.ted/workflow.yaml</code>. Remove it in{' '}
            {opening.holder === 'check' ? 'Checks' : 'Repos'} and save to turn it off.
          </>
        ),
      }
  }
}

function accessWhat(group: SandboxAccess): string {
  if (group === 'ios-xcode')
    return 'Its commands can write where Xcode, SwiftPM, actool and ibtool keep temp files. These folders are shared with your other apps on this Mac.'
  if (group === 'electron')
    return 'Its commands can reach launchservicesd and the window server, so Electron can start and open windows.'
  const socket = socketOf(group)
  if (socket !== undefined)
    return `Its commands can connect to the socket your Library names ${socket}.`
  return 'Its commands get this extra sandbox access.'
}

function SocketSource({ from }: { from: LayerKind }) {
  const key = <code className={styles.code}>sandbox_sockets</code>
  return (
    <>
      Named in {key} in {from === 'library' ? 'the Library’s' : 'Ted’s default'}{' '}
      <code className={styles.code}>workflow.yaml</code> on {machine}
      {from === 'library' ? '. Remove it in Settings → Library to turn it off.' : '.'}
    </>
  )
}
