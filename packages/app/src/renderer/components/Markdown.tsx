import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { webLink } from '../../web-link.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Markdown.module.css'

const components: Components = {
  a: function Link({ href, children, title }) {
    const [error, setError] = useState<string>()
    const url = webLink(href)
    if (url === undefined) return <>{children}</>
    return (
      <>
        <a
          href={url}
          title={title}
          onClick={(event) => {
            event.preventDefault()
            setError(undefined)
            void ted.openMarkdownLink(url).catch((failure: unknown) => {
              setError(readableError(failure))
            })
          }}
        >
          {children}
        </a>
        {error !== undefined && (
          <span role="alert" className={styles.error}>
            {' '}
            {error}
          </span>
        )}
      </>
    )
  },
  img: ({ alt }) => <>{alt}</>,
  table: ({ children }) => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Horizontal scroll regions need keyboard focus.
    <section className={styles.table} aria-label="Markdown table" tabIndex={0}>
      <table>{children}</table>
    </section>
  ),
  pre: ({ children }) => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Horizontal scroll regions need keyboard focus.
    <section className={styles.code} aria-label="Code block" tabIndex={0}>
      <pre>{children}</pre>
    </section>
  ),
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string | undefined
}) {
  return (
    <div className={[styles.markdown, className].filter(Boolean).join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) => webLink(url) ?? ''}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
