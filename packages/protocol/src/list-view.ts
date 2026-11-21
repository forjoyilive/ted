import type { CreatedBy, Priority, StageId, TaskStatusKind } from './task.ts'

export const listSorts = [
  'manual',
  'priority',
  'updated',
  'created',
  'stage',
  'title',
  'tokens',
] as const

export type ListSort = (typeof listSorts)[number]

export const listGroups = [
  'stage',
  'factory',
  'factory-group',
  'status',
  'priority',
  'none',
] as const

export type ListGroup = (typeof listGroups)[number]

export const listColumns = [
  'priority',
  'id',
  'title',
  'children',
  'parent',
  'stage',
  'status',
  'updated',
  'factory',
  'blocked-by',
  'created',
  'created-by',
  'provider',
  'tokens',
  'started',
] as const

export type ListColumn = (typeof listColumns)[number]

export const listColumnsVersions = [2, 3] as const

export type ListColumnsVersion = (typeof listColumnsVersions)[number]

export const archivedFilters = ['hidden', 'included', 'only'] as const

export type ArchivedFilter = (typeof archivedFilters)[number]

export type StatusFilter = TaskStatusKind | 'none'

export interface ListFilters {
  factories?: string[]
  factoryGroups?: string[]
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
  columnsVersion?: ListColumnsVersion
  filters: ListFilters
}

export const allTasksScope = 'all'
