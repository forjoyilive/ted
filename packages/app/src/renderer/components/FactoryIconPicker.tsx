import type { Factory } from '@ted/protocol'
import {
  type FactoryIcon,
  type FactoryIconColor,
  factoryIconColors,
  factoryIconEmojiGroups,
  factoryIconImagePrefix,
  factoryIconImageSide,
  factoryIconSymbolGroups,
  factoryIconUploadMaxBytes,
  factoryIconUploadTypes,
} from '@ted/protocol/factory-icon'
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Button } from './Button.tsx'
import { factoryIconSymbolShapes, IconMark, FactoryIcon as Mark } from './FactoryIcon.tsx'
import styles from './FactoryIconPicker.module.css'

type Tab = 'icons' | 'emoji' | 'upload'

const colorNames: Record<FactoryIconColor, string> = {
  gray: 'Gray',
  blue: 'Blue',
  sky: 'Sky',
  teal: 'Teal',
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
  pink: 'Pink',
  purple: 'Purple',
}

export function FactoryIconPicker({
  factory,
  labelledBy,
  onChange,
}: {
  factory: Factory
  labelledBy: string
  onChange: (icon: FactoryIcon | null) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <span className={styles.anchor}>
      <button
        ref={button}
        type="button"
        className={styles.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        title="Change icon"
        onClick={() => setOpen((was) => !was)}
      >
        <Mark factory={factory} size={20} />
      </button>
      {open && (
        <IconPopover
          factory={factory}
          onClose={() => {
            setOpen(false)
            button.current?.focus()
          }}
          onChange={onChange}
          anchor={button}
        />
      )}
    </span>
  )
}

function IconPopover({
  factory,
  anchor,
  onClose,
  onChange,
}: {
  factory: Factory
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onChange: (icon: FactoryIcon | null) => Promise<unknown>
}) {
  const current = factory.icon
  const [tab, setTab] = useState<Tab>(
    current?.kind === 'emoji' ? 'emoji' : current?.kind === 'image' ? 'upload' : 'icons',
  )
  const [query, setQuery] = useState('')
  const [color, setColor] = useState<FactoryIconColor>(
    current?.kind === 'symbol' || current?.kind === 'letter' ? current.color : 'blue',
  )
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const tabsId = useId()

  useEffect(() => {
    if (tab === 'upload') panel.current?.querySelector<HTMLButtonElement>('[data-choose]')?.focus()
    else search.current?.focus()
  }, [tab])

  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [anchor, onClose])

  async function choose(icon: FactoryIcon | null, close = true) {
    setSaving(true)
    setError(undefined)
    try {
      await onChange(icon)
      if (close) onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  function pickColor(next: FactoryIconColor) {
    setColor(next)
    if (current?.kind === 'symbol' || current?.kind === 'letter') {
      void choose({ ...current, color: next }, false)
    }
  }

  const words = query.trim().toLowerCase()
  const tabs: [Tab, string][] = [
    ['icons', 'Icons'],
    ['emoji', 'Emoji'],
    ['upload', 'Upload'],
  ]

  return (
    <div
      ref={panel}
      className={styles.popover}
      role="dialog"
      aria-label={`Icon for ${factory.name}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onClose()
      }}
    >
      <div className={styles.tabs} role="tablist" id={tabsId}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={styles.tab}
            onClick={() => {
              setTab(id)
              setQuery('')
              setError(undefined)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'icons' && (
        <div className={styles.swatches}>
          {factoryIconColors.map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={color === each}
              aria-label={`${colorNames[each]} colour`}
              title={colorNames[each]}
              className={styles.swatch}
              style={{ background: `var(--factory-icon-${each}-fg)` }}
              disabled={saving}
              onClick={() => pickColor(each)}
            />
          ))}
        </div>
      )}
      {tab !== 'upload' && (
        <input
          className={styles.search}
          type="search"
          placeholder={tab === 'icons' ? 'Search icons…' : 'Search emoji…'}
          aria-label={tab === 'icons' ? 'Search icons' : 'Search emoji'}
          value={query}
          ref={search}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className={styles.body}>
        {tab === 'icons' && (
          <IconsTab
            factory={factory}
            words={words}
            color={color}
            disabled={saving}
            onChoose={(icon) => void choose(icon)}
          />
        )}
        {tab === 'emoji' && (
          <EmojiTab
            words={words}
            chosen={current?.kind === 'emoji' ? current.emoji : undefined}
            disabled={saving}
            onChoose={(emoji) => void choose({ kind: 'emoji', emoji })}
          />
        )}
        {tab === 'upload' && (
          <UploadTab
            disabled={saving}
            onError={setError}
            onImage={(dataUrl) => void choose({ kind: 'image', dataUrl })}
          />
        )}
        {words !== '' && tab !== 'upload' && <NoMatch tab={tab} words={words} />}
      </div>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.remove}
          disabled={saving || current === undefined}
          onClick={() => void choose(null)}
        >
          Remove icon
        </button>
      </div>
    </div>
  )
}

function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={name}>
      <h4 className={styles.groupName}>{name}</h4>
      <div className={styles.grid}>{children}</div>
    </section>
  )
}

function IconsTab({
  factory,
  words,
  color,
  disabled,
  onChoose,
}: {
  factory: Factory
  words: string
  color: FactoryIconColor
  disabled: boolean
  onChoose: (icon: FactoryIcon) => void
}) {
  const current = factory.icon
  const showLetter = words === '' || 'letter'.includes(words)
  return (
    <>
      {showLetter && (
        <Group name="Letter">
          <button
            type="button"
            className={styles.cell}
            aria-label="First letter of the name"
            aria-pressed={current?.kind === 'letter'}
            disabled={disabled}
            onClick={() => onChoose({ kind: 'letter', color })}
          >
            <IconMark icon={{ kind: 'letter', color }} name={factory.name} size={22} />
          </button>
        </Group>
      )}
      {factoryIconSymbolGroups.map((group) => {
        const hits = group.symbols.filter(
          (name) =>
            words === '' || name.includes(words) || group.name.toLowerCase().includes(words),
        )
        if (hits.length === 0) return null
        return (
          <Group key={group.name} name={group.name}>
            {hits.map((name) => {
              const Shape = factoryIconSymbolShapes[name]
              return (
                <button
                  key={name}
                  type="button"
                  className={styles.cell}
                  aria-label={name.replaceAll('-', ' ')}
                  title={name.replaceAll('-', ' ')}
                  aria-pressed={current?.kind === 'symbol' && current.name === name}
                  style={{ color: `var(--factory-icon-${color}-fg)` }}
                  disabled={disabled}
                  onClick={() => onChoose({ kind: 'symbol', name, color })}
                >
                  <Shape size={18} strokeWidth={2} aria-hidden="true" />
                </button>
              )
            })}
          </Group>
        )
      })}
    </>
  )
}

function EmojiTab({
  words,
  chosen,
  disabled,
  onChoose,
}: {
  words: string
  chosen: string | undefined
  disabled: boolean
  onChoose: (emoji: string) => void
}) {
  return (
    <>
      {factoryIconEmojiGroups.map((group) => {
        const hits = group.emoji.filter(
          (entry) =>
            words === '' || entry.words.includes(words) || group.name.toLowerCase().includes(words),
        )
        if (hits.length === 0) return null
        return (
          <Group key={group.name} name={group.name}>
            {hits.map((entry) => (
              <button
                key={entry.emoji}
                type="button"
                className={`${styles.cell} ${styles.emoji}`}
                aria-label={entry.words.split(' ')[0]}
                title={entry.words.split(' ')[0]}
                aria-pressed={chosen === entry.emoji}
                disabled={disabled}
                onClick={() => onChoose(entry.emoji)}
              >
                {entry.emoji}
              </button>
            ))}
          </Group>
        )
      })}
    </>
  )
}

function NoMatch({ tab, words }: { tab: Tab; words: string }) {
  const any =
    tab === 'icons'
      ? 'letter'.includes(words) ||
        factoryIconSymbolGroups.some(
          (group) =>
            group.name.toLowerCase().includes(words) ||
            group.symbols.some((name) => name.includes(words)),
        )
      : factoryIconEmojiGroups.some(
          (group) =>
            group.name.toLowerCase().includes(words) ||
            group.emoji.some((entry) => entry.words.includes(words)),
        )
  if (any) return null
  return <p className={styles.empty}>Nothing matches “{words}”.</p>
}

function UploadTab({
  disabled,
  onError,
  onImage,
}: {
  disabled: boolean
  onError: (message: string | undefined) => void
  onImage: (dataUrl: string) => void
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  async function take(file: File | undefined) {
    if (file === undefined) return
    onError(undefined)
    try {
      onImage(await squareIcon(file))
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  return (
    <section
      aria-label="Upload an image"
      className={`${styles.drop} ${over ? styles.over : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        void take(event.dataTransfer.files[0])
      }}
    >
      <span>Drop an image here, or</span>
      <Button data-choose disabled={disabled} onClick={() => input.current?.click()}>
        Choose image…
      </Button>
      <input
        ref={input}
        hidden
        aria-label="Image file"
        type="file"
        accept={factoryIconUploadTypes.join(',')}
        disabled={disabled}
        onChange={(event) => {
          void take(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <span className={styles.hint}>
        PNG, JPEG, WebP or GIF, up to 1 MB. TED crops it to the centre square and keeps a small
        copy.
      </span>
    </section>
  )
}

export async function squareIcon(file: Blob): Promise<string> {
  if (!factoryIconUploadTypes.includes(file.type))
    throw new Error('Choose a PNG, JPEG, WebP or GIF.')
  if (file.size > factoryIconUploadMaxBytes) throw new Error('That image is over 1 MB.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('TED couldn’t read that image.')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = factoryIconImageSide
  canvas.height = factoryIconImageSide
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('TED couldn’t read that image.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    factoryIconImageSide,
    factoryIconImageSide,
  )
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/png')
  if (!dataUrl.startsWith(factoryIconImagePrefix)) throw new Error('TED couldn’t read that image.')
  return dataUrl
}
