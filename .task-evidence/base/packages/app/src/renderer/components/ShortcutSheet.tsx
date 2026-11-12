import { useEffect, useRef } from 'react'
import { shortcutSheet } from '../keymap.ts'
import styles from './ShortcutSheet.module.css'

function Keys({ keys }: { keys: string }) {
  return (
    <span className={styles.keys}>
      {keys.split(' ').map((chord) => (
        <kbd key={chord} className={styles.key}>
          {chord}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.sheet}
      aria-label="Keyboard shortcuts"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialog.current) onClose()
      }}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>Keyboard shortcuts</h2>
        <span className={styles.note}>
          Shortcuts don’t work while you type in a text box, except ⌘ ones.
        </span>
      </header>
      <div className={styles.columns}>
        {shortcutSheet().map((section) => (
          <section key={section.title} aria-label={section.title} className={styles.section}>
            <h3 className={styles.sectionTitle}>{section.title}</h3>
            <table className={styles.table}>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.id} className={styles.row}>
                    <td className={styles.label}>{row.label}</td>
                    <td className={styles.shortcuts}>
                      {row.keys.map((keys, i) => (
                        <span key={keys} className={styles.alternative}>
                          {i > 0 && <span className={styles.or}>or</span>}
                          <Keys keys={keys} />
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </dialog>
  )
}
