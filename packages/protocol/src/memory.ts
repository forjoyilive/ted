export interface MemoryGroup {
  count: number
  bytes: number
}

export interface MemoryUse {
  daemon: { bytes: number; heapBytes: number; externalBytes: number }
  hosts: MemoryGroup
  agents: MemoryGroup
  other: MemoryGroup
  store: { eventLogBytes: number; stateBytes: number }
  app?: MemoryGroup
}

export interface MemoryPart {
  label: string
  bytes: number
}

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte

export function memorySize(bytes: number): string {
  return bytes >= gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : `${Math.round(bytes / megabyte)} MB`
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function memoryParts(use: MemoryUse): MemoryPart[] {
  return [
    { label: 'Daemon', bytes: use.daemon.bytes },
    ...(use.app ? [{ label: 'App', bytes: use.app.bytes }] : []),
    ...(use.hosts.count > 0
      ? [{ label: counted(use.hosts.count, 'Run host', 'Run hosts'), bytes: use.hosts.bytes }]
      : []),
    ...(use.agents.count > 0
      ? [{ label: counted(use.agents.count, 'agent', 'agents'), bytes: use.agents.bytes }]
      : []),
    ...(use.other.count > 0
      ? [{ label: 'Checks and other commands', bytes: use.other.bytes }]
      : []),
  ]
}

export function memoryTotal(use: MemoryUse): number {
  return memoryParts(use).reduce((sum, part) => sum + part.bytes, 0)
}

export function memorySummary(use: MemoryUse): string {
  return [
    memorySize(memoryTotal(use)),
    ...memoryParts(use).map((part) => `${part.label} ${memorySize(part.bytes)}`),
  ].join(' · ')
}
