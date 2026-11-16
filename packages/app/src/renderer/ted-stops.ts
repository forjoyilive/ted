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
  const one = count === 1
  const left = count - picked
  const queue =
    picked > freeSlots ? 'Tasks start in queue order as working slots free up.' : undefined
  const stays =
    left > 0 && picked > 0 ? `${left} ${left === 1 ? 'stays' : 'stay'} stopped.` : undefined
  const note = [queue, stays].filter((part) => part !== undefined).join(' ')
  return {
    heading: `${count} ${one ? 'Task was' : 'Tasks were'} working when Ted quit`,
    lead: `Ted stopped ${one ? 'its Task Lead' : 'their Task Leads'} at ${stoppedAt}. Restart ${one ? 'it' : 'them'} now, or leave ${one ? 'it' : 'them'} stopped and resume ${one ? 'it' : 'each one'} later from the Task.`,
    restart: one
      ? 'Restart'
      : picked === count
        ? `Restart all ${count}`
        : `Restart ${picked} ${picked === 1 ? 'Task' : 'Tasks'}`,
    note: note === '' ? undefined : note,
  }
}
