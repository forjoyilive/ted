import { stat } from 'node:fs/promises'

export function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}
