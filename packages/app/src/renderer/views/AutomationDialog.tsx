import type {
  Automation,
  AutomationTemplate,
  AutomationTemplateId,
  Factory,
  SchedulePreview,
  TaskLead,
  Weekday,
} from '@ted/protocol'
import { weekdays } from '@ted/protocol/schedule'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { effectiveTimeZone, uses12HourTime } from '@ted/protocol/time'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import {
  draftOf,
  firingDate,
  type ScheduleDraft,
  type ScheduleKind,
  scheduleOf,
  templateScheduleText,
} from '../automations.ts'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { ScheduleTime } from '../components/ScheduleTime.tsx'
import { Select } from '../components/Select.tsx'
import { useAutomationTemplates, useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AutomationDialog.module.css'
import { AutomationPromptDraft } from './AutomationPromptDraft.tsx'
import { LeadFields } from './NewTaskDialog.tsx'

export type TemplateChoice = AutomationTemplateId | 'blank'

const blankSchedule = { kind: 'every', every: 30, unit: 'minutes' } as const

const kindLabels: Record<ScheduleKind, string> = {
  every: 'Every',
  daily: 'Daily at',
  weekdays: 'Weekdays at',
  weekly: 'Weekly on',
  custom: 'Custom',
}

const dayLetters: Record<Weekday, string> = {
  mon: 'M',
  tue: 'T',
  wed: 'W',
  thu: 'T',
  fri: 'F',
  sat: 'S',
  sun: 'S',
}

const dayNames: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

export function AutomationDialog({
  factories,
  factoryId,
  editing,
  template: initialTemplate = 'blank',
  onClose,
  onSaved,
}: {
  factories: readonly Factory[]
  factoryId: string | undefined
  editing?: Automation
  template?: TemplateChoice
  onClose: () => void
  onSaved: (automation: Automation) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const id = useId()
  const templates = useAutomationTemplates()
  const [factory, setFactory] = useState(
    () =>
      editing?.factoryId ?? factories.find((f) => f.id === factoryId)?.id ?? factories[0]?.id ?? '',
  )
  const [template, setTemplate] = useState<TemplateChoice>(initialTemplate)
  const [name, setName] = useState(editing?.name ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftOf(editing?.schedule ?? blankSchedule),
  )
  const settings = useSettings()
  const timeZone = effectiveTimeZone(settings ?? defaultMachineSettings)
  const [lead, setLead] = useState<TaskLead | undefined>(
    editing && {
      agent: editing.agent,
      ...(editing.model !== undefined && { model: editing.model }),
      ...(editing.effort !== undefined && { effort: editing.effort }),
    },
  )
  const [factoryLead, setFactoryLead] = useState<TaskLead>()
  const [on, setOn] = useState(editing?.on ?? true)
  const [preview, setPreview] = useState<SchedulePreview>()
  const [busy, setBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [error, setError] = useState<string>()
  const applied = useRef<TemplateChoice | undefined>(undefined)

  useEffect(() => {
    dialog.current?.showModal()
    nameField.current?.focus()
  }, [])

  useEffect(() => {
    if (factory === '') return
    let current = true
    ted.taskDefaults(factory).then(
      (defaults) => {
        if (!current) return
        const { effortMode: _, ...lead } = defaults.lead
        setFactoryLead(lead)
        if (!editing) setLead(lead)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [factory, editing])

  const pick = (choice: TemplateChoice, list: readonly AutomationTemplate[]) => {
    setTemplate(choice)
    applied.current = choice
    const chosen = list.find((t) => t.id === choice)
    if (choice === 'blank') {
      setName('')
      setPrompt('')
      setDraft(draftOf(blankSchedule))
    } else if (chosen) {
      setName(chosen.name)
      setPrompt(chosen.prompt)
      setDraft(draftOf(chosen.schedule))
    }
  }

  useEffect(() => {
    if (editing || applied.current !== undefined || initialTemplate === 'blank') return
    if (templates.length === 0) return
    pick(initialTemplate, templates)
  })

  const schedule = scheduleOf(draft)
  const scheduleKey = JSON.stringify([
    schedule,
    timeZone,
    uses12HourTime(settings ?? defaultMachineSettings),
  ])
  useEffect(() => {
    const parsed = JSON.parse(scheduleKey) as [ReturnType<typeof scheduleOf>, string]
    const [given] = parsed
    if (typeof given === 'string') return setPreview(undefined)
    let current = true
    const timer = setTimeout(() => {
      ted.previewSchedule(given).then(
        (result) => {
          if (current) setPreview(result)
        },
        (failure: unknown) => {
          if (current) setPreview({ text: '', nextFirings: [], error: readableError(failure) })
        },
      )
    }, 150)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [scheduleKey])

  const chosenFactory = factories.find((f) => f.id === factory)
  const scheduleError = typeof schedule === 'string' ? schedule : preview?.error
  const canSave =
    chosenFactory !== undefined &&
    name.trim() !== '' &&
    prompt.trim() !== '' &&
    scheduleError === undefined &&
    !busy &&
    !draftBusy

  async function save(runNow: boolean) {
    if (!canSave || typeof schedule === 'string' || !chosenFactory) return
    setBusy(true)
    setError(undefined)
    const fields = {
      name: name.trim(),
      prompt,
      schedule,
      on,
      ...(lead && {
        agent: lead.agent,
        ...(lead.model !== undefined && { model: lead.model }),
        ...(lead.effort !== undefined && { effort: lead.effort }),
      }),
    }
    try {
      let saved: Automation
      if (editing) {
        saved = await ted.editAutomation(editing.id, {
          ...fields,
          ...(lead && lead.model === undefined && { model: null }),
          ...(lead && lead.effort === undefined && { effort: null }),
        })
        if (runNow) await ted.runAutomation(saved.id)
      } else {
        saved = await ted.createAutomation({
          ...fields,
          factory: chosenFactory.key,
          ...(template !== 'blank' && { template }),
          ...(runNow && { runNow: true }),
        })
      }
      onSaved(saved)
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save(false)
    }
  }

  const setDraftField = (change: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...change }))

  const headingId = `${id}-heading`
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          {editing ? 'Edit Automation' : 'New Automation in'}
        </h2>
        {!editing && (
          <Select
            disabled={draftBusy}
            aria-label="Factory"
            value={factory}
            onChange={(event) => setFactory(event.target.value)}
          >
            {factories.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className={styles.body}>
        {!editing && (
          <fieldset className={styles.fieldset} disabled={draftBusy}>
            <legend className={styles.labelRow}>
              <span className={styles.label}>Template</span>
              <Help>Picking one fills the name, prompt and schedule. You can change them all.</Help>
            </legend>
            <div className={styles.templates}>
              <TemplateCard
                name="Blank"
                note="Start from an empty prompt"
                checked={template === 'blank'}
                group={id}
                onPick={() => pick('blank', templates)}
              />
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  name={t.name}
                  note={templateScheduleText(t.schedule)}
                  checked={template === t.id}
                  group={id}
                  onPick={() => pick(t.id, templates)}
                />
              ))}
            </div>
          </fieldset>
        )}

        <div className={styles.field}>
          <label className={styles.labelRow} htmlFor={`${id}-name`}>
            <span className={styles.label}>Name</span>
            <span className={styles.hint}>required</span>
          </label>
          <input
            id={`${id}-name`}
            ref={nameField}
            className={styles.input}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.labelRow}>
            <label className={styles.label} htmlFor={`${id}-prompt`}>
              Prompt
            </label>
            <span className={styles.hint}>required</span>
            <Help>
              Markdown. The agent gets it each time the Automation fires, after TED’s own
              instructions.
            </Help>
          </span>
          <textarea
            id={`${id}-prompt`}
            className={styles.prompt}
            rows={6}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <span className={styles.note}>
            Whether new Tasks start is up to the prompt (--start).
          </span>
          {lead && (
            <AutomationPromptDraft
              key={JSON.stringify([factory, template, lead])}
              factory={factory}
              name={name}
              prompt={prompt}
              lead={lead}
              onApply={setPrompt}
              onBusy={setDraftBusy}
            />
          )}
        </div>

        <fieldset className={`${styles.fieldset} ${styles.field}`}>
          <legend className={styles.label}>Schedule</legend>
          <div className={styles.scheduleRow}>
            <Select
              aria-label="Repeat"
              value={draft.kind}
              onChange={(event) => setDraftField({ kind: event.target.value as ScheduleKind })}
            >
              {(Object.keys(kindLabels) as ScheduleKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind]}
                </option>
              ))}
            </Select>
            {draft.kind === 'every' && (
              <>
                <input
                  aria-label="How often"
                  className={`${styles.input} ${styles.short}`}
                  aria-invalid={scheduleError !== undefined}
                  inputMode="numeric"
                  value={draft.every}
                  onChange={(event) => setDraftField({ every: event.target.value })}
                />
                <Select
                  aria-label="Unit"
                  value={draft.unit}
                  onChange={(event) =>
                    setDraftField({ unit: event.target.value as ScheduleDraft['unit'] })
                  }
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </Select>
              </>
            )}
            {draft.kind === 'weekly' &&
              weekdays.map((day) => {
                const chosen = draft.days.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    className={styles.day}
                    aria-label={dayNames[day]}
                    aria-pressed={chosen}
                    onClick={() =>
                      setDraftField({
                        days: chosen
                          ? draft.days.filter((d) => d !== day)
                          : weekdays.filter((d) => d === day || draft.days.includes(d)),
                      })
                    }
                  >
                    {dayLetters[day]}
                  </button>
                )
              })}
            {(draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'weekly') && (
              <ScheduleTime value={draft.at} onChange={(at) => setDraftField({ at })} />
            )}
            {draft.kind === 'custom' && (
              <input
                aria-label="Cron or RRULE"
                className={`${styles.input} ${styles.expression}`}
                aria-invalid={scheduleError !== undefined}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                value={draft.expression}
                onChange={(event) => setDraftField({ expression: event.target.value })}
              />
            )}
          </div>
          {scheduleError !== undefined ? (
            <span className={styles.scheduleError} role="alert">
              {scheduleError}
            </span>
          ) : (
            preview &&
            preview.nextFirings.length > 0 && (
              <span className={styles.note} data-next-firings>
                {draft.kind === 'custom' && `${preview.text.replace(/ · [^·]+$/, '')}. `}
                Next: {preview.nextFirings.map((at) => firingDate(at)).join(' · ')}
              </span>
            )
          )}
        </fieldset>

        <p className={styles.note}>Time zone: {timeZone} · App-wide in General settings</p>

        {lead && (
          <fieldset className={styles.fieldset} disabled={draftBusy}>
            <LeadFields
              id={id}
              lead={lead}
              factoryLead={factoryLead}
              onChange={setLead}
              label="Agent · model · effort"
              help="The agent used for drafting and each firing. Filled from the Factory’s lead."
            />
          </fieldset>
        )}

        <div className={styles.on}>
          <input
            id={`${id}-on`}
            type="checkbox"
            className={styles.checkbox}
            checked={on}
            onChange={(event) => setOn(event.target.checked)}
          />
          <label htmlFor={`${id}-on`} className={styles.onLabel}>
            On
          </label>
          <Help>Fires on schedule once saved. Off, it fires only when you choose Run now.</Help>
        </div>
      </div>

      <footer className={styles.footer}>
        {error !== undefined && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <span className={styles.spacer} />
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!canSave} onClick={() => void save(true)}>
          Save and run now
        </Button>
        <Button
          variant="primary"
          shortcut="⌘↵"
          aria-keyshortcuts="Meta+Enter"
          disabled={!canSave}
          onClick={() => void save(false)}
        >
          Save
        </Button>
      </footer>
    </dialog>
  )
}

function TemplateCard({
  name,
  note,
  checked,
  group,
  onPick,
}: {
  name: string
  note: string
  checked: boolean
  group: string
  onPick: () => void
}) {
  return (
    <label className={styles.template} data-checked={checked}>
      <input
        type="radio"
        name={`${group}-template`}
        className={styles.radio}
        checked={checked}
        onChange={onPick}
      />
      <span className={styles.templateText}>
        <span className={styles.templateName}>{name}</span>
        <span className={styles.templateNote}>{note}</span>
      </span>
    </label>
  )
}
