import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { webLink } from '../../web-link.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { CopyIcon } from './icons.tsx'
import styles from './Markdown.module.css'

function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    setCopying(true)
    setCopied(false)
    setError(undefined)
    try {
      await ted.copyText(pre.current?.textContent ?? '')
      setCopied(true)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className={styles.code}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Horizontal scroll regions need keyboard focus. */}
      <section className={styles.codeScroll} aria-label="Code block" tabIndex={0}>
        <pre ref={pre}>{children}</pre>
      </section>
      <Button
        variant="quiet"
        size="small"
        className={styles.copy}
        aria-label="Copy code"
        title={copied ? 'Copied' : 'Copy code'}
        disabled={copying}
        onClick={() => void copy()}
      >
        {copied ? <span aria-hidden>✓</span> : <CopyIcon />}
      </Button>
      <span className={styles.copyStatus} role="status">
        {copied ? 'Copied' : ''}
      </span>
      {error !== undefined && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </div>
  )
}

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
  pre: CodeBlock,
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
