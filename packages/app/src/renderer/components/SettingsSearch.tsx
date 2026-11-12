import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'
import type { NavigationAction } from '../navigation.ts'
import { openSetting } from '../setting-focus.ts'
import { findSettings, matchedParts, platformOf, type SettingHit } from '../settings-search.ts'
import { CloseIcon, SearchIcon } from './icons.tsx'
import styles from './SettingsSearch.module.css'

const limit = 12

export function MatchedName({ name, query }: { name: string; query: string }) {
  return matchedParts(name, query).map((part, index) =>
    part.matched ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
      <mark key={index} className={styles.match}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  )
}

export function SettingsSearch({
  factory,
  dispatch,
  onLeave,
  children,
}: {
  factory: { id: string; name: string } | undefined
  dispatch: (action: NavigationAction) => void
  onLeave?: () => void
  children: ReactNode
}) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const searching = query.trim() !== ''
  const hits = searching
    ? findSettings(query, { factory, platform: platformOf(navigator.userAgent), limit })
    : []
  const active = Math.min(selected, Math.max(0, hits.length - 1))
  const optionId = (index: number) => `${listId}-${index}`

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  function clear() {
    setQuery('')
    setSelected(0)
  }

  function choose(hit: SettingHit | undefined) {
    if (!hit) return
    clear()
    openSetting(hit, dispatch)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((active + 1) % Math.max(1, hits.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((active - 1 + hits.length) % Math.max(1, hits.length))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      choose(hits[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (query !== '') clear()
      else if (onLeave) onLeave()
      else event.currentTarget.blur()
    }
  }

  return (
    <>
      <div className={styles.field}>
        <SearchIcon className={styles.icon} />
        <input
          className={styles.input}
          data-filter-box
          role="combobox"
          aria-expanded={searching}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
        {query !== '' && (
          <button type="button" className={styles.clear} aria-label="Clear search" onClick={clear}>
            <CloseIcon size={11} />
          </button>
        )}
      </div>
      {searching ? (
        <div id={listId} role="listbox" aria-label="Matching settings" className={styles.results}>
          {hits.length === 0 && (
            <p className={styles.none}>{`No settings match ‘${query.trim()}’`}</p>
          )}
          {hits.map((hit, index) => (
            <button
              type="button"
              tabIndex={-1}
              key={hit.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={styles.result}
              onMouseMove={() => index !== active && setSelected(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(hit)}
            >
              <span className={styles.name}>
                <MatchedName name={hit.name} query={query} />
              </span>
              <span className={styles.where}>{hit.where}</span>
            </button>
          ))}
        </div>
      ) : (
        children
      )}
    </>
  )
}
