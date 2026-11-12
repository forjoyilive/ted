import { agentKinds } from '@ted/protocol/run'
import { useSettings } from '../data.ts'
import { agentLabels } from '../task-fields.ts'

export function useEnabledAgents() {
  return useSettings()?.enabledAgents ?? agentKinds
}

export function AgentOptions({
  current,
  same = false,
}: {
  current?: string | undefined
  same?: boolean
}) {
  const enabled = useEnabledAgents()
  return (
    <>
      {agentKinds
        .filter((kind) => enabled.includes(kind) || kind === current)
        .map((kind) => (
          <option key={kind} value={kind} disabled={!enabled.includes(kind)}>
            {agentLabels[kind]}
            {!enabled.includes(kind) ? ' · Off — new Runs wait' : ''}
          </option>
        ))}
      {same && <option value="same">Same as Task Lead</option>}
    </>
  )
}
