import { type CheckRun, checkFailed, checkLabel } from '@ted/protocol/checks'
import type { ThreadEventTone } from '@ted/protocol/task'
import { ChecksRow } from '../components/ChecksRow.tsx'
import { EventLine } from '../components/EventLine.tsx'
import { stageName } from './TaskViews.tsx'

export function checkRunHeadline(checkRun: CheckRun): [ThreadEventTone, string] {
  const failed = checkRun.checks.find((c) => checkFailed(c.state))
  const stage = stageName(checkRun.stage)
  if (checkRun.trigger === 'agent') {
    if (checkRun.finishedAt === undefined) return ['run', `${stage} is running Checks`]
    return [failed ? 'failure' : 'run', `${stage} ran Checks`]
  }
  if (checkRun.finishedAt === undefined) {
    const running = checkRun.checks.findIndex((c) => c.state === 'running')
    const check = checkRun.checks[running]
    return [
      'run',
      check
        ? `Running Checks · ${checkLabel(check)} (${running + 1} of ${checkRun.checks.length})`
        : 'Running Checks',
    ]
  }
  if (checkRun.outcome === 'interrupted') return ['quiet', 'Checks stopped before they finished']
  if (failed) return ['failure', `${checkLabel(failed)} failed at ${stage}`]
  return ['done', `Checks passed at ${stage}`]
}

export function CheckRunLine({
  checkRun,
  onOpenOutput,
}: {
  checkRun: CheckRun
  onOpenOutput: (checkRun: CheckRun, position: number) => void
}) {
  const [tone, text] = checkRunHeadline(checkRun)
  return (
    <EventLine tone={tone} text={text} at={checkRun.startedAt}>
      <ChecksRow checks={checkRun.checks} onOpen={(position) => onOpenOutput(checkRun, position)} />
    </EventLine>
  )
}
