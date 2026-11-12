import type { MachineOperations, WorkerOperations, WorkerStatus } from '@ted/protocol'

const operations = (n: number) => `${n} ${n === 1 ? 'operation' : 'operations'}`

export function machineOperationsText(
  o: Omit<MachineOperations, 'text'>,
  connected: boolean,
): string | undefined {
  const parts: string[] = []
  const unresolved = o.uncertain + o.unknown
  if (unresolved > 0) {
    const kinds = [
      o.uncertain > 0 && `${o.uncertain} may or may not have started`,
      o.unknown > 0 && `${o.unknown} ${o.unknown === 1 ? 'is' : 'are'} not in this Mac’s records`,
    ].filter(Boolean)
    parts.push(
      `${operations(unresolved)} unresolved: ${kinds.join(', ')}. ${
        unresolved === 1 ? 'It is held; its Task starts' : 'They are held; their Tasks start'
      } nothing new.`,
    )
  }
  if (o.stopsUnconfirmed > 0)
    parts.push(
      `${o.stopsUnconfirmed} ${o.stopsUnconfirmed === 1 ? 'stop' : 'stops'} requested, not confirmed. ${
        o.stopsUnconfirmed === 1 ? 'It counts' : 'They count'
      } as stopped only when this Mac answers.`,
    )
  if (!connected && o.unconfirmed > 0)
    parts.push(
      `${operations(o.unconfirmed)} not confirmed. Their Tasks stay assigned to this Mac; nothing is started elsewhere.`,
    )
  else if (o.reconciling && o.unconfirmed > 0)
    parts.push(`Checking ${operations(o.unconfirmed)} after reconnecting. New work waits.`)
  else if (o.running > 0) parts.push(`${operations(o.running)} running.`)
  if (o.refusing === 'disk')
    parts.push('Not accepting new work: less than 1 GB is free on that Mac.')
  if (o.refusing === 'limit')
    parts.push(
      'Not accepting new work: that Mac’s stored operations are at the limit. Nothing stored is deleted.',
    )
  return parts.length > 0 ? parts.join(' ') : undefined
}

export function workerOperationsText(
  state: WorkerStatus['state'],
  o: WorkerOperations,
): string | undefined {
  const parts: string[] = []
  const unfinished = o.running + o.queued
  if (state === 'connected') {
    if (o.reconciling && unfinished + o.waiting > 0)
      parts.push(
        `Checking ${operations(unfinished + o.waiting)} with the main Mac before starting new work.`,
      )
    else if (o.running > 0) parts.push(`${operations(o.running)} running.`)
  } else if (unfinished + o.waiting > 0)
    parts.push(
      `${operations(o.running)} running, ${o.waiting} ${
        o.waiting === 1 ? 'result' : 'results'
      } waiting to send. Nothing new starts until this Mac reconnects.`,
    )
  if (o.uncertain > 0)
    parts.push(
      `${operations(o.uncertain)} may or may not have started. ${
        o.uncertain === 1
          ? 'It is held and will not run again by itself.'
          : 'They are held and will not run again by themselves.'
      }`,
    )
  if (o.refusing === 'limit')
    parts.push(
      'Not accepting new work: stored operations are at the limit. Nothing stored is deleted.',
    )
  if (o.refusing === 'disk')
    parts.push('Not accepting new work: less than 1 GB is free on this Mac.')
  return parts.length > 0 ? parts.join(' ') : undefined
}
