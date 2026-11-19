import { useSettings } from '../data.ts'
import styles from './PiAutoNote.module.css'

export function PiAutoNote({
  agent,
  factoryId,
  className,
  alwaysWaits = false,
}: {
  agent: string | undefined
  factoryId: string | undefined
  className?: string | undefined
  alwaysWaits?: boolean
}) {
  const settings = useSettings()
  if (agent !== 'pi') return null
  const classes = [styles.note, className].filter(Boolean).join(' ')
  if (alwaysWaits)
    return (
      <p className={classes}>
        Pi can’t run planning chats, Automations or Coordinator chats until sandbox support arrives.
      </p>
    )
  if (factoryId === undefined || settings === undefined) return null
  if (settings.factoryPermissions[factoryId] === 'bypass') return null
  return <p className={classes}>Pi work waits in this Factory until sandbox support arrives.</p>
}
