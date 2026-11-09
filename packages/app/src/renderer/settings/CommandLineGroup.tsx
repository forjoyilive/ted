import type { CommandLineStatus } from '@ted/protocol'
import { tedVersion } from '@ted/protocol/version'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { aboutLine, updateChip } from '../../updates.ts'
import { useUpdateStatus } from '../data.ts'
import { ted } from '../ted.ts'
import styles from './command-line.module.css'
import { Button, SettingRow, SettingsGroup } from './controls.tsx'
import settingsStyles from './settings.module.css'

const commandHelp = 'Lets you use ted in any terminal. Agents always have it in their Runs.'

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

function commandDetail(status: CommandLineStatus | undefined): ReactNode {
  if (status === undefined) return undefined
  switch (status.state) {
    case 'unavailable':
      return 'Only an installed copy of TED can install it.'
    case 'package':
      return 'Installed by your package.'
    case 'not-installed':
      return 'Not installed.'
    case 'taken':
      return `Another program is already at ${status.path}.`
    case 'installed':
      return `Installed at ${status.path}.`
  }
}

export function CommandLineGroup({ children }: { children?: ReactNode }) {
  const [status, setStatus] = useState<CommandLineStatus>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    void ted.getCommandLine().then(setStatus, (error: unknown) => setProblem(errorText(error)))
  }, [])

  const install = () => {
    setBusy(true)
    setProblem(undefined)
    ted
      .installCommandLine()
      .then(setStatus, (error: unknown) => setProblem(errorText(error)))
      .finally(() => setBusy(false))
  }

  const addToPath = status?.state === 'installed' ? status.addToPath : undefined
  const detail = problem ?? commandDetail(status)

  return (
    <SettingsGroup label="Editor and command line">
      {children}
      <SettingRow
        title="The ted command"
        help={commandHelp}
        {...(detail !== undefined && { detail })}
      >
        {status?.state === 'not-installed' && (
          <Button onClick={install} disabled={busy}>
            Install the ted command
          </Button>
        )}
      </SettingRow>
      {addToPath !== undefined && (
        <SettingRow
          title="Add ~/.local/bin to your PATH"
          detail={
            <>
              Your login shell doesn’t look there yet. Add this line to your shell’s profile:{' '}
              <code className={settingsStyles.mono}>{addToPath}</code>
            </>
          }
        >
          <Button onClick={() => void ted.copyText(addToPath)}>Copy</Button>
        </SettingRow>
      )}
    </SettingsGroup>
  )
}

function UpdateRow() {
  const status = useUpdateStatus()
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string>()
  const detail = problem ?? aboutLine(status)
  const busy = updateChip(status)?.busy === true

  const check = () => {
    setChecking(true)
    setProblem(undefined)
    ted
      .checkForUpdates()
      .catch((error: unknown) => setProblem(errorText(error)))
      .finally(() => setChecking(false))
  }

  return (
    <SettingRow
      title={`TED ${tedVersion}`}
      {...(status.state === 'ready' && { help: 'Restarting doesn’t stop Runs.' })}
      {...(detail !== undefined && { detail })}
    >
      {status.state !== 'unavailable' && (
        <Button onClick={check} disabled={checking || busy || status.state === 'checking'}>
          Check for updates
        </Button>
      )}
      {(status.state === 'ready' || busy) && (
        <Button
          primary
          disabled={busy}
          onClick={() =>
            void ted.restartToUpdate().catch((error: unknown) => setProblem(errorText(error)))
          }
        >
          Restart to update
        </Button>
      )}
    </SettingRow>
  )
}

export function AboutGroup() {
  const [licenses, setLicenses] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const view = () => {
    setProblem(undefined)
    ted.thirdPartyLicenses().then(setLicenses, (error: unknown) => setProblem(errorText(error)))
  }

  return (
    <SettingsGroup label="About and updates">
      <UpdateRow />
      <SettingRow
        title="Third-party licenses"
        help="The open-source code TED is built from, and the license for each part."
        {...(problem !== undefined && { detail: problem })}
      >
        <Button onClick={view}>View</Button>
      </SettingRow>
      {licenses !== undefined && (
        <LicensesDialog text={licenses} onClose={() => setLicenses(undefined)} />
      )}
    </SettingsGroup>
  )
}

function LicensesDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          Third-party licenses
        </h2>
        <Button onClick={onClose}>Close</Button>
      </header>
      <pre className={styles.text}>{text}</pre>
    </dialog>
  )
}
