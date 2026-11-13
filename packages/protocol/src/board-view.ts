import type { StageId } from './task.ts'

export const boardCardSizes = ['full', 'compact'] as const

export type BoardCardSize = (typeof boardCardSizes)[number]

export const boardFields = ['priority', 'activity', 'sub-agents', 'blockers', 'hierarchy'] as const

export type BoardField = (typeof boardFields)[number]

export interface BoardView {
  cardSize: BoardCardSize
  fields: BoardField[]
  hiddenStages: StageId[]
  hideEmpty: boolean
}

export const defaultBoardView: BoardView = {
  cardSize: 'full',
  fields: [...boardFields],
  hiddenStages: [],
  hideEmpty: false,
}
