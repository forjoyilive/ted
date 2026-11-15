import type { MemoryUse } from '@ted/protocol'
import { memoryParts, memorySize, memoryTotal } from '@ted/protocol/memory'

export function formatMemoryUse(use: MemoryUse): string {
  const { heapBytes, externalBytes } = use.daemon
  return [
    `TED is using ${memorySize(memoryTotal(use))}.`,
    ...memoryParts(use).map((part) =>
      part.label === 'Daemon'
        ? `  Daemon: ${memorySize(part.bytes)} (JavaScript heap ${memorySize(heapBytes)}, store and buffers ${memorySize(externalBytes)})`
        : `  ${part.label}: ${memorySize(part.bytes)}`,
    ),
    `Store on disk: event log ${memorySize(use.store.eventLogBytes)}, state database ${memorySize(use.store.stateBytes)}.`,
    'The app’s own processes aren’t counted here. Settings → Developer shows them.',
  ].join('\n')
}
