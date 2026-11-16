import type { MakeDirectoryOptions } from 'node:fs'
import { stat } from 'node:fs/promises'

export function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

export type MakeDirectory = (
  dir: string,
  options: MakeDirectoryOptions,
) => Promise<string | undefined>
