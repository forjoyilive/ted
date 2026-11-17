import type { EditorChoice, FoundEditor } from '@ted/protocol'
import { useEffect, useId, useState } from 'react'
import { type EditorPick, type PickEditorRequest, pickEditorEvent } from '../editor.ts'
import { readableError, ted } from '../ted.ts'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import styles from './EditorPicker.module.css'
import { Loading } from './Loading.tsx'

export const customCommandHelp =
  'Ted fills in {path}, {line} and {column} and starts the command without a shell. With no {path}, the path goes last.'

export function useFoundEditors(): { editors: FoundEditor[] | undefined; problem?: string } {
  const [state, setState] = useState<{ editors: FoundEditor[] | undefined; problem?: string }>({
    editors: undefined,
  })
  useEffect(() => {
    let current = true
    ted.listEditors().then(
      (editors) => current && setState({ editors }),
      (error: unknown) => current && setState({ editors: [], problem: readableError(error) }),
    )
    return () => {
      current = false
    }
  }, [])
  return state
}

export function EditorPickerHost() {
  const [request, setRequest] = useState<PickEditorRequest>()
  useEffect(() => {
    const onPick = (event: Event) => {
      event.preventDefault()
      setRequest(() => (event as CustomEvent<PickEditorRequest>).detail)
    }
    window.addEventListener(pickEditorEvent, onPick)
    return () => window.removeEventListener(pickEditorEvent, onPick)
  }, [])
  if (!request) return null
  const finish = (pick: EditorPick | undefined) => {
    setRequest(undefined)
    return request(pick)
  }
  return <EditorPicker onPick={finish} />
}

function EditorPicker({ onPick }: { onPick: (pick: EditorPick | undefined) => void }) {
  const { editors, problem } = useFoundEditors()
  const [choice, setChoice] = useState<EditorChoice>()
  const [command, setCommand] = useState('')
  const name = useId()
  const commandId = useId()
  const chosen = choice ?? editors?.[0]?.id ?? (editors ? 'custom' : undefined)
  const ready = chosen !== undefined && (chosen !== 'custom' || command.trim() !== '')

  return (
    <Dialog onClose={() => onPick(undefined)}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>
            Choose an editor
          </h2>
          <p className={styles.body}>
            Ted opens worktrees and files from diffs in it. You can change it later in Settings →
            General.
          </p>
          {editors === undefined ? (
            <p className={styles.body}>
              <Loading label="Looking for editors…" />
            </p>
          ) : (
            <fieldset className={styles.choices}>
              <legend className={styles.legend}>Editor</legend>
              {editors.length === 0 && (
                <p className={styles.note}>Ted didn’t find an editor on your PATH.</p>
              )}
              {editors.map((editor) => (
                <label key={editor.id} className={styles.radio} title={editor.path}>
                  <input
                    type="radio"
                    name={name}
                    checked={chosen === editor.id}
                    onChange={() => setChoice(editor.id)}
                  />
                  {editor.name}
                </label>
              ))}
              <label className={styles.radio}>
                <input
                  type="radio"
                  name={name}
                  checked={chosen === 'custom'}
                  onChange={() => setChoice('custom')}
                />
                Custom command
              </label>
              {chosen === 'custom' && (
                <div className={styles.custom}>
                  <input
                    id={commandId}
                    className={styles.command}
                    type="text"
                    aria-label="Custom command"
                    placeholder="my-editor --line {line} {path}"
                    spellCheck={false}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                  <p className={styles.note}>{customCommandHelp}</p>
                </div>
              )}
            </fieldset>
          )}
          {problem !== undefined && (
            <p className={styles.error} role="alert">
              {problem}
            </p>
          )}
          <div className={styles.buttons}>
            <Button onClick={() => onPick(undefined)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() =>
                chosen !== undefined &&
                onPick({ editor: chosen, editorCommand: chosen === 'custom' ? command.trim() : '' })
              }
            >
              Open
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
