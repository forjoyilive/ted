import type {
  DiffLine,
  FactorySettingsChanges,
  FactorySettingsView,
  SaveSettingsResult,
  SettingsPreview,
  SettingsSaveMode,
} from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { readableError, ted } from '../ted.ts'
import styles from './FactorySettings.module.css'
import sections from './FactorySettingsSections.module.css'

export function SaveSettingsDialog({
  factoryId,
  factoryName,
  view,
  changes: given,
  onClose,
  onSaved,
}: {
  factoryId: string
  factoryName: string
  view: FactorySettingsView
  changes: FactorySettingsChanges
  onClose: () => void
  onSaved: (result: SaveSettingsResult) => void
}) {
  const [changes] = useState(given)
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [preview, setPreview] = useState<SettingsPreview>()
  const [mode, setMode] = useState<SettingsSaveMode>('merge')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [bypassConfirmed, setBypassConfirmed] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    let current = true
    ted.previewFactorySettings(factoryId, changes).then(
      (shown) => current && setPreview(shown),
      (failure: unknown) => current && setError(readableError(failure)),
    )
    return () => {
      current = false
    }
  }, [factoryId, changes])

  const account = view.github.login
    ? `the GitHub account TED uses (${view.github.login})`
    : 'the GitHub account TED uses'
  const blocked = !view.github.ready
    ? view.github.problem
    : preview && !preview.valid && preview.problems.length === 0
      ? 'Nothing changed in the file.'
      : undefined
  const needsBypass = preview?.turnsOnBypass === true && !bypassConfirmed
  const canSave = preview?.valid === true && view.github.ready && !busy && !needsBypass

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      onSaved(
        await ted.saveFactorySettings(factoryId, {
          changes,
          mode,
          version: view.version,
          ...(preview?.turnsOnBypass === true && { confirmBypass: bypassConfirmed }),
        }),
      )
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div className={styles.dialogBody}>
        <h2 id={headingId} className={styles.dialogHeading}>
          Save TED settings
        </h2>
        <p className={styles.dialogText}>
          TED commits these changes to a new branch of {view.repo} and opens the pull request
          “Update TED settings”, using {account}.
        </p>
        {!preview && error === undefined && <p className={styles.caption}>Preparing the diff…</p>}
        {preview?.files.map((file) => (
          <section key={file.path} className={styles.diff} aria-label={`Changes to ${file.path}`}>
            <div className={styles.diffHead}>
              <span className={styles.mono}>{file.path}</span>
              <span className={styles.spacer} />
              <span className={styles.diffCounts}>
                <span className={styles.removedCount}>−{file.removed}</span>{' '}
                <span className={styles.addedCount}>+{file.added}</span>
              </span>
            </div>
            <div className={styles.diffLines}>
              {keyedLines(file.lines).map(({ key, line }) => (
                <div
                  key={key}
                  className={
                    line.kind === 'added'
                      ? styles.addedLine
                      : line.kind === 'removed'
                        ? styles.removedLine
                        : line.kind === 'gap'
                          ? styles.gapLine
                          : styles.sameLine
                  }
                >
                  <span className={styles.diffMark} aria-hidden>
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                  </span>
                  <span className={styles.diffText}>
                    {line.kind === 'gap' ? `… ${line.text}` : line.text}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
        {preview && preview.problems.length > 0 && (
          <div className={styles.problems} role="alert">
            <p className={styles.problemsTitle}>TED won’t save this, because:</p>
            <ul>
              {preview.problems.map((problem) => (
                <li key={`${problem.line}:${problem.column}:${problem.message}`}>
                  {problem.line > 0 ? `Line ${problem.line}: ` : ''}
                  {problem.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview?.turnsOnBypass === true && (
          <div className={sections.confirmBypass} role="alert">
            <p>
              <strong>This save turns on Bypass.</strong> Every Run in {factoryName} will act
              without asking: it can run any command, change any file and use the network. Use it
              only when Runs happen in an isolated machine or VM.
            </p>
            <label>
              <input
                type="checkbox"
                checked={bypassConfirmed}
                disabled={busy}
                onChange={(event) => setBypassConfirmed(event.target.checked)}
              />
              Turn on Bypass for {factoryName}
            </label>
          </div>
        )}
        {preview?.sideEffects.map((effect) => (
          <p key={effect} className={styles.sideEffect}>
            <span aria-hidden>ⓘ</span> {effect}
          </p>
        ))}
        <fieldset className={styles.modes} disabled={busy}>
          <legend className={styles.visuallyHidden}>How to save</legend>
          <label className={styles.mode}>
            <input
              type="radio"
              name={`${headingId}-mode`}
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
            />
            Save and merge
            <Help>
              Merges the pull request right away, the same way TED merges Tasks. If{' '}
              {view.defaultBranch} needs a review or passing checks, it stays open.
            </Help>
          </label>
          <label className={styles.mode}>
            <input
              type="radio"
              name={`${headingId}-mode`}
              checked={mode === 'pull-request'}
              onChange={() => setMode('pull-request')}
            />
            Save as pull request
            <Help>Leaves the pull request open, to review and merge on GitHub.</Help>
          </label>
        </fieldset>
        {error !== undefined && (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className={styles.dialogFooter}>
        {blocked !== undefined && <span className={styles.blockedReason}>{blocked}</span>}
        <span className={styles.spacer} />
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Saving…' : mode === 'merge' ? 'Save and merge' : 'Save as pull request'}
        </Button>
      </footer>
    </dialog>
  )
}

function keyedLines(lines: readonly DiffLine[]): { key: string; line: DiffLine }[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const base = `${line.kind}:${line.text}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { key: `${base}:${n}`, line }
  })
}
