import type { MemoryUse } from '@ted/protocol'
import { daemonPartLabel, memoryParts, memorySize, memoryTotal } from '@ted/protocol/memory'

const processes = (count: number) => `${count} ${count === 1 ? 'process' : 'processes'}`

export function formatMemoryUse(use: MemoryUse): string {
  const { bytes, heapBytes, externalBytes } = use.daemon
  return [
    `TED is using ${memorySize(memoryTotal(use))}.`,
    ...memoryParts(use).map((part) =>
      part.label === daemonPartLabel
        ? `  ${part.label}: ${memorySize(part.bytes)}, ${processes(part.count)} (daemon ${memorySize(bytes)}: JavaScript heap ${memorySize(heapBytes)}, store and buffers ${memorySize(externalBytes)})`
        : `  ${part.label}: ${memorySize(part.bytes)}, ${processes(part.count)}`,
    ),
    ...(use.asleepRuns
      ? [
          `  ${use.asleepRuns === 1 ? '1 idle Run is' : `${use.asleepRuns} idle Runs are`} asleep and ${use.asleepRuns === 1 ? 'uses' : 'use'} no memory.`,
        ]
      : []),
    `Store on disk: event log ${memorySize(use.store.eventLogBytes)}, state database ${memorySize(use.store.stateBytes)}.`,
    'The app’s own processes aren’t counted here. Settings → Developer shows them.',
  ].join('\n')
}
