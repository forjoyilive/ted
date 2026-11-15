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
      <div className={styles.head}>
        <span className={styles.title}>Setting up {view.factoryName}</span>
        <button type="button" className={styles.hide} onClick={onHide}>
          Hide guide
        </button>
      </div>
      <p className={styles.text}>{view.text}</p>
      {button && (
        <Button
          size="small"
          variant={button.open === 'task' ? 'secondary' : 'primary'}
          className={styles.button}
          onClick={() => onOpen(button)}
        >
          {button.label}
        </Button>
      )}
    </section>
  )
}
