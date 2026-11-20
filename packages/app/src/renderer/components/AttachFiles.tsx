import type { Attachment } from '@ted/protocol'
import { type ClipboardEvent, useRef, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './AttachFiles.module.css'
import { PaperclipIcon } from './icons.tsx'

const maxAttachmentBytes = 25 * 1024 * 1024

export function useAttachFiles({
  setFiles,
  setError,
}: {
  setFiles: (next: (files: Attachment[]) => Attachment[]) => void
  setError: (error: string | undefined) => void
}) {
  const [uploading, setUploading] = useState(0)

  async function attach(picked: readonly File[]) {
    const tooBig = picked.find((file) => file.size > maxAttachmentBytes)
    if (tooBig) {
      setError(`${tooBig.name} is over 25 MB.`)
      return
    }
    setError(undefined)
    setUploading((n) => n + picked.length)
    for (const file of picked) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const name = file.name || `pasted.${file.type.split('/')[1] ?? 'bin'}`
        const added = await ted.uploadAttachment({ name, mediaType: file.type }, bytes)
        setFiles((current) =>
          current.some((a) => a.hash === added.hash && a.name === added.name)
            ? current
            : [...current, added],
        )
      } catch (failure) {
        setError(`Couldn’t attach ${file.name}: ${readableError(failure)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  function onPaste(event: ClipboardEvent) {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    event.preventDefault()
    void attach(pasted)
  }

  return { uploading, attach, onPaste }
}

export function AttachButton({
  pending,
  disabled = false,
  onPick,
}: {
  pending: boolean
  disabled?: boolean
  onPick: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <ActionButton
        type="button"
        className={styles.attach}
        pending={pending}
        disabled={disabled}
        aria-label="Attach files"
        title="Attach files — or drop or paste them into the box"
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
      </ActionButton>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files to attach"
        onChange={(event) => {
          onPick([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </>
  )
}
