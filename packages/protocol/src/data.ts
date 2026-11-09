export const backupKinds = ['pre-update', 'daily', 'before-restore'] as const

export type BackupKind = (typeof backupKinds)[number]

export interface Backup {
  name: string
  kind: BackupKind
  takenAt: string
  takenBy: string
  dataFrom?: string
}

export interface BackupsSummary {
  backups: Backup[]
  activeRuns: number
}

export interface RestoreBackupRequest {
  name: string
  stopRuns?: boolean
}

export interface RestoreBackupResult {
  restored: string
  saved: string
  stoppedRuns: number
}

export type DataStatus =
  | { state: 'ready' }
  | { state: 'opening' }
  | {
      state: 'updating'
      version: string
      done: number
      total: number
      secondsLeft?: number
      backupsDir: string
    }
  | {
      state: 'failed'
      version: string
      error: string
      done?: number
      total?: number
      restore?: Backup
    }
  | {
      state: 'needs-newer'
      version: string
      lastOpenedBy?: string
      dataDir: string
      restore?: Backup
    }

export const downloadUrl = 'https://github.com/forjoyilive/ted/releases/latest'
