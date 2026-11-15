import type { DashboardFlow, FlowInterval, FlowPeriod, FlowStage } from '@ted/protocol'
import { useState } from 'react'

const storageKey = 'ted.dashboard.stage-waits'
const ms = Date.parse

export interface LeftOutTask {
  taskId: string
  reasons: string[]
}

export interface StagesWithoutWaits {
  stages: FlowStage[]
  leftOut: LeftOutTask[]
}

const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null
  const index = (values.length - 1) * p
  const lower = values[Math.floor(index)] ?? 0
  const upper = values[Math.ceil(index)] ?? lower
  return lower + (upper - lower) * (index - Math.floor(index))
}

function overlap(visits: FlowInterval[], waits: FlowInterval[]) {
  let total = 0
  for (const visit of visits)
    for (const wait of waits)
      total += Math.max(
        0,
        Math.min(ms(visit.to), ms(wait.to)) - Math.max(ms(visit.from), ms(wait.from)),
      )
  return total
}

export function withoutUserWaits(
  period: FlowPeriod,
  factoryOf?: ReadonlyMap<string, string>,
): StagesWithoutWaits {
  const requests = new Map(
    (period.reasons.find((r) => r.reason === 'user-request')?.samples ?? []).map((s) => [
      s.taskId,
      s,
    ]),
  )
  const leftOut = new Map<string, LeftOutTask>()
  const stages = period.stages.map((stage) => {
    const samples = stage.samples.flatMap((sample) => {
      const request = requests.get(sample.taskId)
      if (request?.coverage !== 'full') {
        leftOut.set(sample.taskId, {
          taskId: sample.taskId,
          reasons: request?.notices.length
            ? request.notices
            : ['No record of requests to you for this Task.'],
        })
        return []
      }
      return [
        {
          ...sample,
          elapsedMs: Math.max(0, sample.elapsedMs - overlap(sample.intervals, request.intervals)),
        },
      ]
    })
    const values = samples.map((s) => s.elapsedMs).sort((a, b) => a - b)
    return {
      ...stage,
      factoryIds: factoryOf
        ? stage.factoryIds.filter((id) => samples.some((s) => factoryOf.get(s.taskId) === id))
        : stage.factoryIds,
      samples,
      totalMs: values.reduce((n, v) => n + v, 0),
      medianMs: quantile(values, 0.5),
      p25Ms: quantile(values, 0.25),
      p75Ms: quantile(values, 0.75),
    }
  })
  return {
    stages,
    leftOut: [...leftOut.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)),
  }
}

export function flowWithoutUserWaits(data: DashboardFlow): {
  data: DashboardFlow
  leftOut: { current: LeftOutTask[]; previous: LeftOutTask[] }
} {
  const factoryOf = new Map(data.tasks.map((task) => [task.id, task.factoryId]))
  const current = withoutUserWaits(data.current, factoryOf)
  const previous = data.previous ? withoutUserWaits(data.previous, factoryOf) : null
  return {
    data: {
      ...data,
      current: { ...data.current, stages: current.stages },
      previous:
        data.previous && previous ? { ...data.previous, stages: previous.stages } : data.previous,
    },
    leftOut: { current: current.leftOut, previous: previous?.leftOut ?? [] },
  }
}

function stored() {
  try {
    return localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

export function useIncludeUserWaits() {
  const [include, setInclude] = useState(stored)
  const change = (next: boolean) => {
    setInclude(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {}
  }
  return [include, change] as const
}
