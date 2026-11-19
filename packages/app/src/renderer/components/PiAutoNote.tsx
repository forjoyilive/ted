import { useAgentHealth, useSettings } from '../data.ts'
import styles from './PiAutoNote.module.css'

export function PiAutoNote({
  agent,
  factoryId,
  className,
  alwaysAuto = false,
}: {
  agent: string | undefined
  factoryId: string | undefined
  className?: string | undefined
  alwaysAuto?: boolean
}) {
  const settings = useSettings()
  if (agent !== 'pi' || settings === undefined || settings.piUnsandboxedAllowed) return null
  if (
    !alwaysAuto &&
    (factoryId === undefined || settings.factoryPermissions[factoryId] === 'bypass')
  )
    return null
  return <SandboxNote className={className} />
}

function SandboxNote({ className }: { className: string | undefined }) {
  const health = useAgentHealth()
  if (health.find((h) => h.agent === 'pi')?.sandboxProblem === undefined) return null
  const classes = [styles.note, className].filter(Boolean).join(' ')
  return (
    <p className={classes}>
      Ted can’t sandbox Pi on this computer, so Pi work here waits. Allow it in Settings →
      Providers.
    </p>
  )
}
