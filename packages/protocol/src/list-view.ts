import type { CreatedBy, Priority, StageId, TaskStatusKind } from './task.ts'

export const listSorts = ['manual', 'priority', 'updated', 'created', 'stage', 'title'] as const

export type ListSort = (typeof listSorts)[number]

export const listGroups = ['stage', 'factory', 'status', 'priority', 'none'] as const

export type ListGroup = (typeof listGroups)[number]

export const listColumns = [
  'priority',
  'id',
  'title',
  'stage',
  'status',
  'updated',
  'factory',
  'blocked-by',
  'created',
  'created-by',
  'tokens',
  'started',
] as const

export type ListColumn = (typeof listColumns)[number]

export const archivedFilters = ['hidden', 'included', 'only'] as const

export type ArchivedFilter = (typeof archivedFilters)[number]

export type StatusFilter = TaskStatusKind | 'none'

export interface ListFilters {
  factories?: string[]
  stages?: StageId[]
  statuses?: StatusFilter[]
  priorities?: Priority[]
  needsPlanning?: boolean
  createdBy?: CreatedBy[]
  archived?: ArchivedFilter
}

export interface ListView {
  sort: ListSort
  group: ListGroup
  showEmptyGroups?: boolean
  nested?: boolean
  columns: ListColumn[]
  columnsVersion?: 2
  filters: ListFilters
}

export const allTasksScope = 'all'
