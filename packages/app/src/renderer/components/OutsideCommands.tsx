import type { AgentSummary, OutsideCommandAllowance } from '@ted/protocol'
import type { AgentCommand } from '@ted/protocol/agent-files'
import { useState } from 'react'
import { useEventValue } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AgentAbout.module.css'
import { Button } from './Button.tsx'

export function shownOutsideCommands(
  agent: Pick<AgentSummary, 'powers' | 'outsideCommands'>,
): readonly AgentCommand[] {
  return agent.powers.includes('run_outside') ? (agent.outsideCommands ?? []) : []
}

export function useAllowances(factoryId: string | undefined, wanted = true) {
  return useEventValue<OutsideCommandAllowance[]>({
    initial: [],
    key: factoryId ?? '',
    enabled: factoryId !== undefined && wanted,
    load: () => ted.outsideCommandAllowances(factoryId ?? ''),
    event: (event) =>
      event.type === 'coordinator-changed' && event.factoryId === factoryId ? 'reload' : undefined,
  })
}

export function AllowanceList({
  factoryId,
  agentId,
  allowances,
  onChange,
}: {
  factoryId: string
  agentId?: string
  allowances: readonly OutsideCommandAllowance[]
  onChange: (next: OutsideCommandAllowance[]) => void
}) {
  const [error, setError] = useState<string>()
  const shown = allowances.filter((a) => agentId === undefined || a.agentId === agentId)
  if (shown.length === 0) return null
  return (
    <>
      <ul className={styles.commands} aria-label="Allowed always on this Mac">
        {shown.map((allowance) => (
          <li key={allowance.id} className={styles.allowance} data-allowance={allowance.name}>
            <span className={styles.commandName}>
              {agentId === undefined ? `${allowance.agentId} · ` : ''}
              {allowance.name}
            </span>
            <code className={styles.command}>{allowance.command}</code>
            <span className={styles.folder}>{allowance.folder}</span>
            <Button
              size="small"
              onClick={async () => {
                setError(undefined)
                try {
                  onChange(await ted.removeOutsideCommandAllowance(factoryId, allowance.id))
                } catch (failed) {
                  setError(readableError(failed))
                }
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {error !== undefined && (
        <p className={styles.none} role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function OutsideCommandsSection({
  factoryId,
  agent,
  className,
}: {
  factoryId: string | undefined
  agent: Pick<AgentSummary, 'id' | 'powers' | 'outsideCommands'>
  className?: string | undefined
}) {
  const commands = shownOutsideCommands(agent)
  const { value: allowances, refresh } = useAllowances(factoryId, commands.length > 0)
  if (commands.length === 0) return null
  const allowed = (command: AgentCommand) =>
    allowances.some(
      (a) => a.agentId === agent.id && a.name === command.name && a.command === command.command,
    )
  return (
    <section className={className} aria-label="Outside commands">
      <h2>Outside commands</h2>
      <ul className={styles.commands}>
        {commands.map((command) => (
          <li key={command.name} data-outside-command={command.name}>
            <span className={styles.commandName}>{command.name}</span>
            <code className={styles.command}>{command.command}</code>
            <span className={styles.folder}>
              {allowed(command) ? 'Always allowed' : 'Asks each time'}
            </span>
          </li>
        ))}
      </ul>
      {factoryId !== undefined && (
        <AllowanceList
          factoryId={factoryId}
          agentId={agent.id}
          allowances={allowances}
          onChange={(next) => void refresh(async () => next)}
        />
      )}
    </section>
  )
}
