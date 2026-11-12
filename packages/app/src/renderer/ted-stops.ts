import { plural } from './words.ts'

export interface TedStopsText {
  heading: string
  lead: string
  restart: string
  note: string | undefined
}

export function tedStopsText({
  count,
  picked,
  stoppedAt,
  freeSlots,
}: {
  count: number
  picked: number
  stoppedAt: string
  freeSlots: number
}): TedStopsText {
  const left = count - picked
  const queue =
    picked > freeSlots ? 'Tasks start in queue order as working slots free up.' : undefined
  const stays =
    left > 0 && picked > 0 ? `${left} ${plural(left, 'stays', 'stay')} stopped.` : undefined
  const note = [queue, stays].filter((part) => part !== undefined).join(' ')
  return {
    heading: `${count} ${plural(count, 'Task was', 'Tasks were')} working when TED quit`,
    lead: `TED stopped ${plural(count, 'its Task Lead', 'their Task Leads')} at ${stoppedAt}. Restart ${plural(count, 'it', 'them')} now, or leave ${plural(count, 'it', 'them')} stopped and resume ${plural(count, 'it', 'each one')} later from the Task.`,
    restart:
      count === 1
        ? 'Restart'
        : picked === count
          ? `Restart all ${count}`
          : `Restart ${picked} ${plural(picked, 'Task')}`,
    note: note === '' ? undefined : note,
  }
}
