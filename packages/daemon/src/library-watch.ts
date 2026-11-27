import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { DaemonEvent } from '@ted/protocol'
import { contentVersion, readLayerDirectory } from './workflow/layers.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface LibraryWatch {
  saw(version: string): void
  close(): void
}

export interface LibraryWatchOptions {
  watchDirectory?: (
    directory: string,
    changed: () => void,
  ) => {
    on(event: 'error', listener: (error: Error) => void): void
    close(): void
  }
  pollMs?: number
  recheckMs?: number
}

export async function watchLibrary(
  options: LibraryWatchOptions & {
    libraryDir: string
    workflows: Pick<Workflows, 'inherited'>
    emit: (event: DaemonEvent) => void
    debounceMs?: number
  },
): Promise<LibraryWatch> {
  await mkdir(options.libraryDir, { recursive: true })
  const read = async () => {
    const files = await readLayerDirectory(options.libraryDir)
    return files && contentVersion(files)
  }
  // macOS FSEvents reports the folder's own creation just after the watch starts.
  let seen = await read()
  let debounce: NodeJS.Timeout | undefined
  let recheckTimer: NodeJS.Timeout | undefined
  let loop = 0
  let closed = false
  let polling = false
  let saved = 0
  let refreshing = false
  const refresh = async () => {
    if (closed || refreshing) return
    refreshing = true
    const before = saved
    try {
      const version = await read()
      if (closed || saved !== before || version === seen) return
      await options.workflows.inherited()
      if (closed || saved !== before) return
      seen = version
      options.emit({ type: 'library-changed', ...(version && { version }) })
    } catch (error) {
      console.error('couldn’t read the Library:', error)
    } finally {
      refreshing = false
    }
  }
  const changed = () => {
    if (closed || polling) return
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (refreshing) changed()
      else void refresh()
    }, options.debounceMs ?? 150).unref()
  }
  // fs.watch on macOS (FSEvents) can miss a change under load, so a working watcher
  // is also backed by a slow re-read.
  const recheck = (current = ++loop) => {
    if (closed || current !== loop) return
    const delay = polling ? (options.pollMs ?? 1000) : (options.recheckMs ?? 5000)
    recheckTimer = setTimeout(() => void refresh().then(() => recheck(current)), delay).unref()
  }
  const watchDirectory =
    options.watchDirectory ??
    ((directory, onChange) => watch(directory, { recursive: true, persistent: false }, onChange))
  let watcher: ReturnType<typeof watchDirectory> | undefined
  const fallback = () => {
    if (closed || polling) return
    polling = true
    watcher?.close()
    watcher = undefined
    clearTimeout(debounce)
    clearTimeout(recheckTimer)
    recheck()
  }
  try {
    watcher = watchDirectory(options.libraryDir, changed)
    watcher.on('error', (error) => {
      console.error('watching the Library failed, checking for edits periodically:', error)
      fallback()
    })
  } catch (error) {
    console.error('couldn’t watch the Library, checking for edits periodically:', error)
    fallback()
  }
  if (!polling) recheck()
  return {
    saw(version) {
      seen = version
      saved += 1
    },
    close() {
      closed = true
      clearTimeout(debounce)
      clearTimeout(recheckTimer)
      watcher?.close()
    },
  }
}
