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
      <div className={styles.header}>
        <span className={styles.title}>Setting up {view.factoryName}</span>
        <button type="button" className={styles.hide} onClick={onHide}>
          Hide guide
        </button>
      </div>
      <p className={styles.text}>{view.text}</p>
      {button && (
        <div className={styles.actions}>
          <Button
            size="small"
            variant={button.open === 'task' ? 'secondary' : 'primary'}
            onClick={() => onOpen(button)}
          >
            {button.label}
          </Button>
        </div>
      )}
    </section>
  )
}
