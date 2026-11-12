import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { webLink } from '../../web-link.ts'
import { type Reference, references } from '../references.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { CopyIcon } from './icons.tsx'
import styles from './Markdown.module.css'
import { ReferenceLink, useReferenceLinks } from './References.tsx'

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

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const referenceTag = 'ted-reference'

function referenceNode(reference: Reference, children: HastNode[]): HastNode {
  return {
    type: 'element',
    tagName: referenceTag,
    properties: { reference: JSON.stringify(reference) },
    children,
  }
}

function linkReferences(node: HastNode): void {
  if (!node.children) return
  node.children = node.children.flatMap((child): HastNode[] => {
    if (child.type === 'text' && child.value !== undefined) {
      return references(child.value).map((piece) =>
        piece.reference
          ? referenceNode(piece.reference, [{ type: 'text', value: piece.text }])
          : { type: 'text', value: piece.text },
      )
    }
    if (child.type !== 'element' || child.tagName === 'a' || child.tagName === 'pre') return [child]
    if (child.tagName === 'code') {
      const [only] = child.children ?? []
      const pieces =
        child.children?.length === 1 && only?.type === 'text' ? references(only.value ?? '') : []
      const reference = pieces.length === 1 ? pieces[0]?.reference : undefined
      return [reference ? referenceNode(reference, [child]) : child]
    }
    linkReferences(child)
    return [child]
  })
}

const rehypeReferences = () => (tree: HastNode) => linkReferences(tree)

function LinkedReference({ reference, children }: { reference?: string; children?: ReactNode }) {
  return (
    <ReferenceLink reference={JSON.parse(reference ?? '{}') as Reference}>{children}</ReferenceLink>
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
  ...({ [referenceTag]: LinkedReference } as Components),
}

const linkedPlugins = [rehypeReferences]

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string | undefined
}) {
  const linked = useReferenceLinks()
  return (
    <div className={[styles.markdown, className].filter(Boolean).join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        {...(linked && { rehypePlugins: linkedPlugins })}
        components={components}
        urlTransform={(url) => webLink(url) ?? ''}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
