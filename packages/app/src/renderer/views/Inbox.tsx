import type { Factory, InboxItem } from '@ted/protocol'
import type { ReactNode } from 'react'
import { Help } from '../components/Help.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { age, headline, kindLabels, useNow } from '../requests.ts'
import styles from './Inbox.module.css'
import { factoryName, stageName } from './TaskViews.tsx'
import views from './views.module.css'

export function Inbox({
  items,
  factories,
  selected,
  onOpen,
  children,
}: {
  items: readonly InboxItem[]
  factories: readonly Factory[]
  selected: string | undefined
  onOpen: (item: InboxItem) => void
  children?: ReactNode
}) {
  const now = useNow()
  const manyFactories = factories.length > 1
  return (
    <>
      <section className={`${views.pane} ${views.listPane}`} aria-label="Inbox">
        <header className={`${views.header} ${views.listHeader}`}>
          <h1 className={views.listTitle}>Inbox</h1>
          <Help>
            Questions and sign-offs from agents that need your answer, from every Factory.
          </Help>
        </header>
        {items.length === 0 ? (
          <p className={views.empty}>Nothing is waiting on you.</p>
        ) : (
          <ul className={styles.rows}>
            {items.map((item) => {
              const { request, task } = item
              const where = [
                task.displayId,
                task.title,
                stageName(request.stage ?? task.stage),
                ...(manyFactories ? [factoryName(factories, task.factoryId)] : []),
              ].join(' · ')
              return (
                <li key={request.id}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-current={request.id === selected ? 'true' : undefined}
                    onClick={() => onOpen(item)}
                  >
                    <span className={styles.top}>
                      <PriorityIcon priority={task.priority} />
                      <span className={styles.kind}>{kindLabels[request.kind]}</span>
                      <span className={styles.age}>{age(request.createdAt, now)}</span>
                    </span>
                    <span className={styles.headline}>{headline(request)}</span>
                    <span className={styles.where}>{where}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {children ?? <section className={views.pane} aria-label="Nothing open" />}
    </>
  )
}
