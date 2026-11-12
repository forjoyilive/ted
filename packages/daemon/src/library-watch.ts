import { type FSWatcher, watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { DaemonEvent } from '@ted/protocol'
import { contentVersion, readLayerDirectory } from './workflow/layers.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface LibraryWatch {
  saw(version: string): void
  close(): void
}

export async function watchLibrary(options: {
  libraryDir: string
  workflows: Pick<Workflows, 'inherited'>
  emit: (event: DaemonEvent) => void
  debounceMs?: number
}): Promise<LibraryWatch> {
  await mkdir(options.libraryDir, { recursive: true })
  const read = async () => {
    const files = await readLayerDirectory(options.libraryDir)
    return files && contentVersion(files)
  }
  // macOS FSEvents reports the folder's own creation just after the watch starts.
  let seen = await read()
  let timer: NodeJS.Timeout | undefined
  let closed = false
  const changed = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      read()
        .then(async (version) => {
          if (closed || version === seen) return
          seen = version
          await options.workflows.inherited()
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
    saw(version) {
      seen = version
    },
    close() {
      closed = true
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
