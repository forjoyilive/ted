import { type FocusEvent, useEffect, useId, useRef, useState } from 'react'
import { modelOptions } from '../task-fields.ts'
import { CloseIcon } from './icons.tsx'
import styles from './ModelSelect.module.css'
import { Select } from './Select.tsx'

const other = ' other'

interface ModelSelectProps {
  agent: string | undefined
  value: string
  onChange: (model: string) => void
  extra?: readonly (string | undefined)[]
  defaultLabel?: string
  disabled?: boolean | undefined
  id?: string | undefined
  'aria-label'?: string | undefined
  className?: string | undefined
  controlClassName?: string | undefined
  inputClassName?: string | undefined
  fullWidth?: boolean | undefined
}

export function ModelSelect({
  agent,
  value,
  onChange,
  extra,
  defaultLabel = 'Default model',
  disabled,
  id,
  'aria-label': label,
  className,
  controlClassName,
  inputClassName,
  fullWidth,
}: ModelSelectProps) {
  const ownId = useId()
  const selectId = id ?? ownId
  const [typed, setTyped] = useState<string>()
  const refocus = useRef(false)
  const models = modelOptions(agent, value, extra)

  useEffect(() => {
    if (typed !== undefined || !refocus.current) return
    refocus.current = false
    document.getElementById(selectId)?.focus()
  }, [typed, selectId])

  if (typed === undefined || disabled) {
    return (
      <Select
        id={selectId}
        aria-label={label}
        className={className}
        controlClassName={controlClassName}
        fullWidth={fullWidth}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          if (event.target.value === other) setTyped('')
          else onChange(event.target.value)
        }}
      >
        <option value="">{defaultLabel}</option>
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <hr />
        <option value={other}>Other…</option>
      </Select>
    )
  }

  const finish = (keep: boolean, focus: boolean) => {
    const model = typed.trim()
    refocus.current = focus
    setTyped(undefined)
    if (keep && model !== '' && model !== value) onChange(model)
  }

  const leave = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) finish(true, false)
  }

  return (
    <span
      className={[styles.wrap, fullWidth && styles.fullWidth, className].filter(Boolean).join(' ')}
    >
      <input
        onBlur={leave}
        // biome-ignore lint/a11y/noAutofocus: the box replaces the list the user just chose Other… from
        autoFocus
        id={selectId}
        aria-label={label}
        className={[styles.control, inputClassName ?? styles.input].join(' ')}
        placeholder={agent === 'pi' ? 'provider/id' : 'Model name'}
        title={
          agent === 'pi'
            ? 'Pi models are written as provider/id, e.g. ollama/gemma4:12b'
            : undefined
        }
        size={14}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            finish(true, true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(false, true)
          }
        }}
      />
      <button
        type="button"
        className={styles.back}
        aria-label="Back to the list"
        title="Back to the list"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => finish(false, true)}
        onBlur={leave}
      >
        <CloseIcon size={12} />
      </button>
    </span>
  )
}
