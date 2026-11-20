import { redactSecrets } from '../redact.ts'

export class IntakeBudgetError extends Error {}

export interface FiringLink {
  automationId: string
  firingId: string
}

export interface BulkCap {
  remaining: () => number
  unchanged: () => void
}

export interface BulkListing<Item, Skipped, Fields> {
  items: readonly Item[]
  unchanged: () => void
  label: string
  fields: Fields
  tracked?: number
  skipped?: Skipped[]
}

export interface BulkTracker<Item, Imported, Skipped, Fields> {
  kind: 'asana' | 'github' | 'linear'
  limit: number
  owns: (url: string) => boolean
  overBudget: 'stop' | 'next'
  start: () => Promise<BulkListing<Item, Skipped, Fields>>
  isTracked: (item: Item) => boolean
  importOne: (item: Item, cap: BulkCap) => Promise<{ entry?: Imported; created: number }>
  skippedEntry: (item: Item, reason: string) => Skipped
}

export type BulkResult<Imported, Skipped, Fields> = Fields & {
  imported: Imported[]
  skipped: Skipped[]
  tracked: number
  left: number
  stopped?: string
}

export interface BulkIntakeDeps {
  createdInFiring: (link: FiringLink, owns: (url: string) => boolean) => number
  log?: (line: string) => void
}

export function createBulkIntake(deps: BulkIntakeDeps) {
  const runs = new Map<string, Promise<unknown>>()
  const log = deps.log ?? ((line: string) => console.log(line))

  async function runNow<Item, Imported, Skipped, Fields>(
    automation: FiringLink | undefined,
    tracker: BulkTracker<Item, Imported, Skipped, Fields>,
  ): Promise<BulkResult<Imported, Skipped, Fields>> {
    const listing = await tracker.start()
    const { unchanged } = listing
    const imported: Imported[] = []
    const skipped: Skipped[] = [...(listing.skipped ?? [])]
    let tracked = listing.tracked ?? 0
    let left = 0
    let stopped: string | undefined
    let created = 0
    let exhausted = false
    const remaining = () => {
      if (exhausted) return 0
      return automation
        ? tracker.limit - deps.createdInFiring(automation, tracker.owns)
        : tracker.limit - created
    }
    for (const item of listing.items) {
      if (tracker.isTracked(item)) {
        tracked++
        continue
      }
      if (remaining() <= 0) {
        left++
        continue
      }
      try {
        unchanged()
        const done = await tracker.importOne(item, { remaining, unchanged })
        created += done.created
        if (done.entry !== undefined) imported.push(done.entry)
      } catch (error) {
        if (error instanceof IntakeBudgetError) {
          if (tracker.overBudget === 'stop') exhausted = true
          left++
          continue
        }
        const reason = redactSecrets(error instanceof Error ? error.message : String(error))
        try {
          unchanged()
        } catch (changed) {
          stopped = changed instanceof Error ? changed.message : reason
          break
        }
        skipped.push(tracker.skippedEntry(item, reason))
      }
    }
    if (imported.length > 0 || stopped !== undefined) {
      log(
        redactSecrets(
          `${listing.label}: imported ${imported.length}, skipped ${skipped.length}, left ${left}${stopped ? ', stopped' : ''}`,
        ),
      )
    }
    return {
      ...listing.fields,
      imported,
      skipped,
      tracked,
      left,
      ...(stopped !== undefined && { stopped }),
    }
  }

  return {
    run<Item, Imported, Skipped, Fields>(
      factoryId: string,
      automation: FiringLink | undefined,
      tracker: BulkTracker<Item, Imported, Skipped, Fields>,
    ): Promise<BulkResult<Imported, Skipped, Fields>> {
      const key = `${tracker.kind}:${factoryId}`
      const prior = runs.get(key) ?? Promise.resolve()
      const next = prior.catch(() => undefined).then(() => runNow(automation, tracker))
      runs.set(key, next)
      return next.finally(() => {
        if (runs.get(key) === next) runs.delete(key)
      })
    },
  }
}
