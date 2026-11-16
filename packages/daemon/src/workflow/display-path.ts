import type { LayerKind } from '@ted/protocol'

export function displayPath(kind: LayerKind, file: string): string {
  return kind === 'factory' ? `.ted/${file}` : file
}
