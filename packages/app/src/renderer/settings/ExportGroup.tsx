import type { ExportFormat, Factory } from '@ted/protocol'
import { useEffect, useId, useState } from 'react'
import { useConnection } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { plural } from '../words.ts'
import { Button, Select, SettingRow, SettingsGroup } from './controls.tsx'
import styles from './export.module.css'

export function ExportGroup() {
  const { epoch } = useConnection()
  const id = useId()
  const [factories, setFactories] = useState<Factory[]>()
  const [selected, setSelected] = useState('')
  const [format, setFormat] = useState<ExportFormat>('json')
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    void epoch
    void retry
    let active = true
    setFactories(undefined)
    setError(undefined)
    void ted
      .listFactories()
      .then((rows) => {
        if (!active) return
        setFactories(rows)
        setSelected((value) => (rows.some((row) => row.id === value) ? value : (rows[0]?.id ?? '')))
      })
      .catch((failure: unknown) => {
        if (active) setError(readableError(failure))
      })
    return () => {
      active = false
    }
  }, [epoch, retry])

  const save = async () => {
    setBusy(true)
    setError(undefined)
    setMessage('')
    try {
      const result = await ted.exportFactory(selected, format)
      if (!result.canceled) setMessage(`Exported ${plural(result.tasks, 'Task')} to ${result.path}`)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.group}>
      <SettingsGroup setting="app.storage.export">
        {factories === undefined ? (
          <SettingRow title={error ? 'Couldn’t load Factories' : 'Loading Factories…'}>
            {error && <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button>}
          </SettingRow>
        ) : factories.length === 0 ? (
          <SettingRow title="Add a Factory to export its work." />
        ) : (
          <>
            <SettingRow title="Factory" labelFor={`${id}-factory`}>
              <Select
                id={`${id}-factory`}
                value={selected}
                disabled={busy}
                options={factories.map((factory) => ({ value: factory.id, label: factory.name }))}
                onChange={(value) => {
                  setSelected(value)
                  setMessage('')
                }}
              />
            </SettingRow>
            <SettingRow
              title="Format"
              labelFor={`${id}-format`}
              detail={
                format === 'json'
                  ? 'JSON keeps structured records for other tools.'
                  : 'Markdown is easy to read in a text editor.'
              }
            >
              <Select<ExportFormat>
                id={`${id}-format`}
                value={format}
                disabled={busy}
                options={[
                  { value: 'json', label: 'JSON' },
                  { value: 'markdown', label: 'Markdown' },
                ]}
                onChange={(value) => {
                  setFormat(value)
                  setMessage('')
                }}
              />
            </SettingRow>
            <SettingRow
              title="Tasks, Comments, briefs and Run metadata"
              detail="Includes Done and archived Tasks, answers and saved versions."
            >
              <Button disabled={busy || !selected} onClick={() => save()}>
                {busy ? 'Exporting…' : 'Export…'}
              </Button>
            </SettingRow>
          </>
        )}
      </SettingsGroup>
      <p className={styles.help}>
        Attachment names and references are included; attached files and Run chats are not. This
        export cannot be restored into TED. Known token-shaped secrets and URL credentials are
        redacted.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <p className={styles.message} role="status">
        {message}
      </p>
    </div>
  )
}
