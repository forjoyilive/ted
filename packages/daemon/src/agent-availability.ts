import {
  type AgentAvailability,
  agentKinds,
  type ChangeAgentAvailabilityRequest,
  type ChangeAgentAvailabilityResult,
} from '@ted/protocol'
import type { Services } from './data.ts'
import { RequestError } from './errors.ts'

export function createAgentAvailability(services: Omit<Services, 'agentAvailability'>) {
  const { store, runs, tasks, plans, coordinators, sideChats, automations } = services
  function summary(agent: AgentAvailability['agent']): AgentAvailability {
    const live = store.listRuns().filter((run) => run.state !== 'finished')
    const own = live.filter((run) => run.agent === agent)
    const stoppedTasks = new Set(
      own
        .filter((run) => run.taskId && store.getTask(run.taskId)?.leadRunId === run.id)
        .map((run) => run.taskId),
    )
    const describe = (run: (typeof live)[number]) => ({
      id: run.id,
      agent: run.agent,
      name: run.name ?? (run.taskId ? store.getTask(run.taskId)?.displayId : undefined) ?? 'Run',
      ...(run.taskId && { taskId: run.taskId }),
    })
    return {
      agent,
      enabled: store.settings().enabledAgents.includes(agent),
      runs: own.map(describe),
      additionalRuns: live
        .filter((run) => run.agent !== agent && stoppedTasks.has(run.taskId))
        .map(describe),
    }
  }
  let changing: Promise<unknown> = Promise.resolve()
  async function apply(
    input: ChangeAgentAvailabilityRequest,
  ): Promise<ChangeAgentAvailabilityResult> {
    const stopAffected = (availability: AgentAvailability): Promise<unknown>[] => {
      const pending: Promise<unknown>[] = []
      const stoppedTasks = new Set<string>()
      for (const run of availability.runs) {
        if (run.taskId && store.getTask(run.taskId)?.leadRunId === run.id) {
          const task = store.getTask(run.taskId)
          if (!task?.stopped) pending.push(tasks.stop(run.taskId))
          stoppedTasks.add(run.taskId)
        }
      }
      for (const run of availability.runs) {
        if (
          (run.taskId && stoppedTasks.has(run.taskId)) ||
          store.getRun(run.id)?.state === 'finished'
        )
          continue
        const coordinator = store.coordinators.forRun(run.id)
        const side = store.sideChats.forRun(run.id)
        if (coordinator?.runId === run.id) pending.push(coordinators.stop(coordinator.id))
        else if (side) pending.push(sideChats.stop(side.sourceRunId))
        else if (store.plans.get(run.id)?.state === 'started')
          pending.push(plans.stop(run.id, { kind: 'app' }))
        else if (store.automationDrafts.get(run.id)) pending.push(automations.drafts.cancel(run.id))
        else pending.push(runs.stop(run.id))
      }
      return pending
    }
    const decision = await runs.serializeStarts(() => {
      const availability = summary(input.agent)
      if (availability.enabled === input.enabled && !(input.existing === 'stop' && !input.enabled))
        return { availability, confirmationRequired: false }
      const enabled = store.settings().enabledAgents
      if (!input.enabled && availability.enabled && enabled.length === 1)
        throw new RequestError(409, 'Enable another agent before turning this one off.')
      const affected = [...availability.runs, ...availability.additionalRuns]
      if (
        !input.enabled &&
        availability.runs.length &&
        (!input.existing || affected.some((run) => !input.confirmedRunIds?.includes(run.id)))
      )
        return { availability, confirmationRequired: true }
      store.updateSettings({
        enabledAgents: input.enabled
          ? agentKinds.filter((kind) => enabled.includes(kind) || kind === input.agent)
          : enabled.filter((kind) => kind !== input.agent),
      })
      const stops = !input.enabled && input.existing === 'stop' ? stopAffected(availability) : []
      return { availability, confirmationRequired: false, stops }
    })
    if (decision.confirmationRequired) return decision
    await Promise.all('stops' in decision ? decision.stops : [])
    return { availability: summary(input.agent), confirmationRequired: false }
  }
  return {
    list: () => agentKinds.map(summary),
    change(input: ChangeAgentAvailabilityRequest): Promise<ChangeAgentAvailabilityResult> {
      const next = changing.then(() => apply(input))
      changing = next.catch(() => undefined)
      return next
    },
  }
}
