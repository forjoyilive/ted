import type { NotificationOffer } from '../../notifications.ts'
import { useEventValue } from '../data.ts'
import { ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './NotificationOffer.module.css'

export function useNotificationOffer(): NotificationOffer {
  return useEventValue<NotificationOffer>({
    initial: 'done',
    load: ted.notificationOffer,
    event: (event) => (event.type === 'notification-offer' ? () => event.offer : undefined),
  }).value
}

export function NotificationOfferBanner() {
  const offer = useNotificationOffer()
  if (offer !== 'offered') return null
  return (
    <section className={styles.offer} aria-label="Notifications">
      <div className={styles.text}>
        <span className={styles.title}>Get a notification when something needs you?</span>
        <span className={styles.detail}>macOS will ask whether TED may send notifications.</span>
      </div>
      <Button onClick={() => ted.declineNotifications()}>Not now</Button>
      <Button variant="primary" onClick={() => ted.turnOnNotifications()}>
        Turn on
      </Button>
    </section>
  )
}
