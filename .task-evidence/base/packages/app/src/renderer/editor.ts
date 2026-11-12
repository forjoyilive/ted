import type { EditorChoice } from '@ted/protocol'
import { ted } from './ted.ts'

export interface EditorTarget {
  taskId: string
  repo: string
  snapshot?: boolean
  file?: string
  line?: number
  column?: number
}

export interface EditorPick {
  editor: EditorChoice
  editorCommand: string
}

export const pickEditorEvent = 'ted:pick-editor'

export type PickEditorRequest = (pick: EditorPick | undefined) => void

function pickEditor(): Promise<EditorPick | undefined> {
  return new Promise((resolve) => {
    const asked = window.dispatchEvent(
      new CustomEvent<PickEditorRequest>(pickEditorEvent, { detail: resolve, cancelable: true }),
    )
    if (asked) resolve(undefined)
  })
}

export async function openInEditor(target: EditorTarget): Promise<boolean> {
  const settings = await ted.getSettings()
  if (settings.editor === null) {
    const pick = await pickEditor()
    if (!pick) return false
    await ted.updateSettings(pick)
  }
  await ted.openInEditor(target.taskId, target.repo, {
    ...(target.snapshot !== undefined && { snapshot: target.snapshot }),
    ...(target.file !== undefined && { file: target.file }),
    ...(target.line !== undefined && { line: target.line }),
    ...(target.column !== undefined && { column: target.column }),
  })
  return true
}
