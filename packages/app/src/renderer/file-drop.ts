import { type DragEvent, useState } from 'react'

type Receiver = (files: File[]) => unknown

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

export function useFileDrop(receiver: () => Receiver | undefined) {
  const [dragging, setDragging] = useState(false)
  return {
    dragging,
    handlers: {
      onDragOver(event: DragEvent) {
        if (!carriesFiles(event) || receiver() === undefined) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      },
      onDragLeave(event: DragEvent) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      },
      onDrop(event: DragEvent) {
        setDragging(false)
        const receive = receiver()
        if (!carriesFiles(event) || receive === undefined) return
        event.preventDefault()
        event.stopPropagation()
        receive([...event.dataTransfer.files])
      },
    },
  }
}
