import type { MachineSettings } from '@ted/protocol'
import { type EditorChoice, editorNames } from '@ted/protocol/shell'
import { useEffect, useState } from 'react'
import { customCommandHelp, useFoundEditors } from '../components/EditorPicker.tsx'
import { Loading } from '../components/Loading.tsx'
import { readableError, ted } from '../ted.ts'
import { Select, SettingRow } from './controls.tsx'
import styles from './editor.module.css'

type EditorValue = EditorChoice | 'none'

export function EditorRow({ settings }: { settings: MachineSettings }) {
  const { editors, problem: listProblem } = useFoundEditors()
  const [command, setCommand] = useState(settings.editorCommand)
  const [problem, setProblem] = useState<string>()
  useEffect(() => setCommand(settings.editorCommand), [settings.editorCommand])

  const current = settings.editor
  const options: { value: EditorValue; label: string }[] = [
    ...(current === null ? [{ value: 'none' as const, label: 'Choose on first use' }] : []),
    ...(editors ?? []).map((editor) => ({ value: editor.id, label: editor.name })),
    ...(current !== null && current !== 'custom' && !editors?.some((e) => e.id === current)
      ? [
          {
            value: current,
            label: editors ? `${editorNames[current]} (not found)` : editorNames[current],
          },
        ]
      : []),
    { value: 'custom', label: 'Custom command' },
  ]

  const save = (changes: Partial<MachineSettings>) => {
    setProblem(undefined)
    ted.updateSettings(changes).catch((error: unknown) => setProblem(readableError(error)))
  }

  const detail =
    problem ??
    listProblem ??
    (editors === undefined ? <Loading compact label="Finding editors…" /> : undefined)

  return (
    <>
      <SettingRow
        setting="app.general.editor.editor"
        labelFor="editor"
        {...(detail !== undefined && { detail })}
      >
        <Select
          id="editor"
          value={current ?? 'none'}
          options={options}
          width={200}
          onChange={(value) => {
            if (value !== 'none') save({ editor: value })
          }}
        />
      </SettingRow>
      {current === 'custom' && (
        <SettingRow title="Custom command" labelFor="editor-command" detail={customCommandHelp}>
          <input
            id="editor-command"
            className={styles.field}
            type="text"
            spellCheck={false}
            placeholder="my-editor --line {line} {path}"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onBlur={() => {
              if (command !== settings.editorCommand) save({ editorCommand: command })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </SettingRow>
      )}
    </>
  )
}
