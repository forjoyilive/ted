import { useSettings } from '../data.ts'
import styles from './PiAutoNote.module.css'

export function PiAutoNote({
  agent,
  factoryId,
  className,
}: {
  agent: string | undefined
  factoryId: string | undefined
  className?: string | undefined
}) {
  const settings = useSettings()
  if (agent !== 'pi' || factoryId === undefined || settings === undefined) return null
  if (settings.factoryPermissions[factoryId] === 'bypass') return null
  return (
    <p className={[styles.note, className].filter(Boolean).join(' ')}>
      Pi work waits in this Factory until sandbox support arrives.
    </p>
  )
}
