import { type FSWatcher, watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { DaemonEvent } from '@ted/protocol'
import type { Workflows } from './workflow/workflows.ts'

export interface LibraryWatch {
  close(): void
}

export async function watchLibrary(options: {
  libraryDir: string
  workflows: Pick<Workflows, 'inherited'>
  emit: (event: DaemonEvent) => void
  debounceMs?: number
}): Promise<LibraryWatch> {
  await mkdir(options.libraryDir, { recursive: true })
  let timer: NodeJS.Timeout | undefined
  let closed = false
  const changed = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      options.workflows
        .inherited()
        .then(() => {
          if (!closed) options.emit({ type: 'library-changed' })
        })
        .catch((error: unknown) => console.error('couldn’t read the Library:', error))
    }, options.debounceMs ?? 150)
    timer.unref()
  }
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(options.libraryDir, { recursive: true, persistent: false }, changed)
    watcher.on('error', (error) => console.error('watching the Library failed:', error))
  } catch (error) {
    console.error('couldn’t watch the Library:', error)
  }
  return {
    close() {
      closed = true
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
