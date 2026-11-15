import type { GuideButton, GuideCardView } from '../guide.ts'
import { Button } from './Button.tsx'
import styles from './GuideCard.module.css'

export function GuideCard({
  view,
  onOpen,
  onHide,
}: {
  view: GuideCardView
  onOpen: (button: GuideButton) => void
  onHide: () => void
}) {
  const { button } = view
  return (
    <section className={styles.card} aria-label="Setup guide" data-guide>
      <span className={styles.title}>Setting up {view.factoryName}</span>
      <p className={styles.text}>{view.text}</p>
      <div className={styles.actions}>
        {button && (
          <Button
            size="small"
            variant={button.open === 'task' ? 'secondary' : 'primary'}
            onClick={() => onOpen(button)}
          >
            {button.label}
          </Button>
        )}
        <button type="button" className={styles.hide} onClick={onHide}>
          Hide guide
        </button>
      </div>
    </section>
  )
}
