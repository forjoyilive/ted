export interface FactoryGuide {
  factoryId: string
  addedAt: string
  setUp: boolean
}

export const guideEndings = ['task-created', 'hidden', 'setup-archived', 'setup-deleted'] as const

export type GuideEnding = (typeof guideEndings)[number]
