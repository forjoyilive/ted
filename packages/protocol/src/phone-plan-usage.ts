import type { PlanUsage } from './health.ts'
import type { AgentKind } from './run.ts'

export interface PhonePlanUsageBody {
  providers: { provider: AgentKind; usage?: Pick<PlanUsage, 'at' | 'windows'> }[]
}
