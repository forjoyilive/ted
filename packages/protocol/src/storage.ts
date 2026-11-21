import type { Backup } from './data.ts'
import { reader, type Untyped } from './parse.ts'
import { RequestValidationError } from './validation.ts'

export const diskLimits = {
  warnBelowBytes: 10e9,
  holdBelowBytes: 2e9,
  releaseAboveBytes: 4e9,
} as const

export const diskFullHold = 'disk full'

export const storageKeptForMs = 10 * 60_000

export const storageCategories = [
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'sandbox-caches', label: 'Sandbox caches' },
  { id: 'simulators', label: 'Simulators' },
  { id: 'clones', label: 'Clones' },
  { id: 'conversations-and-logs', label: 'Conversations and logs' },
  { id: 'store', label: 'Store' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'backups', label: 'Backups' },
  { id: 'scratch-worktrees', label: 'Scratch worktrees' },
] as const

export type StorageCategoryId = (typeof storageCategories)[number]['id']

export interface StorageCategory {
  id: StorageCategoryId
  label: string
  bytes: number
}

export interface WorktreeUse {
  taskId: string
  displayId: string
  title: string
  factoryId: string
  factoryName: string
  bytes: number
}

export interface StoredBackup extends Backup {
  bytes: number
}

export interface StorageSummary {
  home: string
  usedBytes: number
  freeBytes: number
  volume: string
  categories: StorageCategory[]
  largestWorktrees: WorktreeUse[]
  removableClones: { count: number; bytes: number }
  simulators: { count: number; bytes: number }
  backups: StoredBackup[]
  backupsDir: string
  storeFiles: { eventLogBytes: number; stateBytes: number; backupsBytes: number }
  measuredAt: string
}

export interface RemoveClonesResult {
  removed: string[]
  bytes: number
}

export function formatBytes(bytes: number): string {
  if (bytes >= 999.5e6) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} bytes`
}

export const storageFolderKinds = ['backups', 'sandbox-caches'] as const
export type StorageFolderKind = (typeof storageFolderKinds)[number]

export interface StorageFolderChange {
  kind: StorageFolderKind
  parent: string | null
}

export interface StorageFolderLocation {
  kind: StorageFolderKind
  path: string
  custom: boolean
  available: boolean
  problem?: string
}

export function parseStorageFolderChange(value: Untyped): StorageFolderChange {
  const read = reader((message) => {
    throw new RequestValidationError(400, message)
  })
  const body = read.object(value, 'storage folder')
  return {
    kind: read.oneOf(body, 'kind', storageFolderKinds),
    parent: body.parent === null ? null : read.string(body, 'parent'),
  }
}
