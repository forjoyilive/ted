import type {
  Automation,
  AutomationTemplate,
  AutomationTemplateId,
  CheckAgentStep,
  Factory,
  Priority,
  SchedulePreview,
  TaskLead,
  Weekday,
} from '@ted/protocol'
import { scheduledCheckPrompt } from '@ted/protocol/automation'
import { isOneOf } from '@ted/protocol/parse'
import { weekdays } from '@ted/protocol/schedule'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { priorities } from '@ted/protocol/task'
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
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { FactoryPicker } from '../components/FactoryPicker.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { ScheduleTime } from '../components/ScheduleTime.tsx'
import { Select } from '../components/Select.tsx'
import grow from '../components/TextGrow.module.css'
import { useAutomationTemplates, useSettings } from '../data.ts'
import { priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AutomationDialog.module.css'
import { AutomationPromptDraft } from './AutomationPromptDraft.tsx'
import { LeadFields } from './NewTaskDialog.tsx'

export type TemplateChoice = AutomationTemplateId | 'blank' | 'check'

const blankSchedule = { kind: 'every', every: 30, unit: 'minutes' } as const
const checkSchedule = { kind: 'daily', at: '03:00' } as const
const defaultCheckTimeout = '2h'
const timeoutPattern = /^[1-9]\d{0,4}[smh]$/

const agentStepLabels: Record<CheckAgentStep, string> = {
  'on-failure': 'When the check fails',
  always: 'After every run',
  never: 'Never',
}

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
  const [prompt, setPrompt] = useState(
    editing?.check && editing.prompt.trim() === '' ? scheduledCheckPrompt : (editing?.prompt ?? ''),
  )
  const isCheck = editing ? editing.check !== undefined : template === 'check'
  const [command, setCommand] = useState(editing?.check?.command ?? '')
  const [timeout, setCheckTimeout] = useState(editing?.check?.timeout ?? defaultCheckTimeout)
  const [runBy, setRunBy] = useState(editing?.check?.runBy ?? '07:00')
  const [hasRunBy, setHasRunBy] = useState(editing ? editing.check?.runBy !== undefined : true)
  const [agentStep, setAgentStep] = useState<CheckAgentStep>(
    editing?.check?.agentStep ?? 'on-failure',
  )
  const [startTasks, setStartTasks] = useState(editing?.check?.startTasks === true)
  const checkAgent = isCheck && agentStep !== 'never'
  const showsLead = !isCheck || checkAgent
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
  const [checkout, setCheckout] = useState(editing?.checkout === true)
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? 'high')
  const [preview, setPreview] = useState<SchedulePreview>()
  const [busy, setBusy] = useState(false)
  const [savingAndRunning, setSavingAndRunning] = useState(false)
  const saving = useRef(false)
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
      setCheckout(false)
    } else if (choice === 'check') {
      setName('Nightly full test run')
      setPrompt(scheduledCheckPrompt)
      setCommand('')
      setDraft(draftOf(checkSchedule))
      setCheckout(false)
    } else if (chosen) {
      setName(chosen.name)
      setPrompt(chosen.prompt)
      setDraft(draftOf(chosen.schedule))
      setCheckout(chosen.checkout === true)
    }
  }

  useEffect(() => {
    if (editing || applied.current !== undefined || initialTemplate === 'blank') return
    if (templates.length === 0 && initialTemplate !== 'check') return
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
  const checkError = !isCheck
    ? undefined
    : command.trim() === ''
      ? 'Enter the command to run.'
      : !timeoutPattern.test(timeout.trim())
        ? 'Enter a time limit like 90m or 2h.'
        : undefined
  const canSave =
    chosenFactory !== undefined &&
    name.trim() !== '' &&
    (!isCheck || checkError === undefined) &&
    ((isCheck && !checkAgent) || prompt.trim() !== '') &&
    scheduleError === undefined &&
    !busy &&
    !draftBusy

  async function save(runNow: boolean) {
    if (!canSave || typeof schedule === 'string' || !chosenFactory || saving.current) return
    saving.current = true
    setSavingAndRunning(runNow)
    setBusy(true)
    setError(undefined)
    const check = isCheck
      ? {
          command: command.trim(),
          timeout: timeout.trim(),
          ...(hasRunBy ? { runBy } : editing ? { runBy: null } : {}),
          agentStep,
          startTasks: checkAgent && startTasks,
        }
      : undefined
    const fields = {
      name: name.trim(),
      ...((!isCheck || checkAgent) && { prompt }),
      schedule,
      on,
      ...(check && { check }),
      ...(!isCheck && { checkout }),
      ...((!isCheck || checkAgent) && { priority }),
      ...(lead &&
        showsLead && {
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
          ...(lead && showsLead && lead.model === undefined && { model: null }),
          ...(lead && showsLead && lead.effort === undefined && { effort: null }),
        })
        if (runNow) await ted.runAutomation(saved.id)
      } else {
        saved = await ted.createAutomation({
          prompt: '',
          ...fields,
          factory: chosenFactory.key,
          ...(template !== 'blank' && template !== 'check' && { template }),
          ...(runNow && { runNow: true }),
        })
      }
      onSaved(saved)
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    } finally {
      saving.current = false
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
        if (!busy) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          {editing ? 'Edit Automation' : 'New Automation in'}
        </h2>
        {!editing && (
          <FactoryPicker
            factories={factories}
            value={factory}
            disabled={draftBusy}
            onChange={setFactory}
          />
        )}
        <span className={styles.spacer} />
        <ActionButton
          type="button"
          className={styles.close}
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <CloseIcon />
        </ActionButton>
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
              <TemplateCard
                name="Scheduled check"
                note="Run a command; an agent looks into failures"
                checked={template === 'check'}
                group={id}
                onPick={() => pick('check', templates)}
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

        {isCheck && (
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <label className={styles.label} htmlFor={`${id}-command`}>
                Command
              </label>
              <span className={styles.hint}>required</span>
              <Help>
                Runs in a fresh worktree on the tip of the default branch, as a check in Ted’s
                sandbox, after the repo’s setup.
              </Help>
            </span>
            <input
              id={`${id}-command`}
              className={styles.input}
              aria-invalid={checkError !== undefined && command.trim() === ''}
              spellCheck={false}
              placeholder="npm test"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <div className={styles.scheduleRow}>
              <label className={styles.label} htmlFor={`${id}-timeout`}>
                Time limit
              </label>
              <input
                id={`${id}-timeout`}
                className={`${styles.input} ${styles.short}`}
                aria-invalid={!timeoutPattern.test(timeout.trim())}
                spellCheck={false}
                value={timeout}
                onChange={(event) => setCheckTimeout(event.target.value)}
              />
            </div>
            {checkError !== undefined && command.trim() !== '' && (
              <span className={styles.scheduleError} role="alert">
                {checkError}
              </span>
            )}
            <div className={styles.on}>
              <input
                id={`${id}-run-by`}
                type="checkbox"
                className={styles.checkbox}
                checked={hasRunBy}
                onChange={(event) => setHasRunBy(event.target.checked)}
              />
              <label htmlFor={`${id}-run-by`} className={styles.onLabel}>
                While the computer is busy, wait until
              </label>
              {hasRunBy && <ScheduleTime value={runBy} onChange={setRunBy} />}
              <Help>
                With “Start fewer Runs when this computer is busy” on, a scheduled firing waits
                while the computer is busy, then runs anyway at this time. Without a time it waits
                at most 4 hours. Run now never waits.
              </Help>
            </div>
          </div>
        )}

        {isCheck && (
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <label className={styles.label} htmlFor={`${id}-agent-step`}>
                Agent step
              </label>
              <Help>
                An agent reads the result in a copy of the same commit, reruns failing tests, and
                creates or notes Tasks. If it can’t start, fails or ends without reporting, Ted
                creates one Task per failing test file instead. Never: Ted always does that.
              </Help>
            </span>
            <Select
              id={`${id}-agent-step`}
              value={agentStep}
              onChange={(event) => setAgentStep(event.target.value as CheckAgentStep)}
            >
              {(Object.keys(agentStepLabels) as CheckAgentStep[]).map((step) => (
                <option key={step} value={step}>
                  {agentStepLabels[step]}
                </option>
              ))}
            </Select>
          </div>
        )}

        {(!isCheck || checkAgent) && (
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <label className={styles.label} htmlFor={`${id}-prompt`}>
                Prompt
              </label>
              <span className={styles.hint}>required</span>
              <Help>
                Markdown. The agent gets it each time the Automation fires, after Ted’s own
                instructions.
              </Help>
            </span>
            <textarea
              id={`${id}-prompt`}
              className={`${styles.prompt} ${grow.text}`}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            {!isCheck && (
              <span className={styles.note}>
                Whether new Tasks start is up to the prompt (--start).
              </span>
            )}
            {lead && !isCheck && (
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
        )}

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
                  <ActionButton
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
                  </ActionButton>
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

        {checkAgent && (
          <div className={styles.on}>
            <input
              id={`${id}-start-tasks`}
              type="checkbox"
              className={styles.checkbox}
              checked={startTasks}
              onChange={(event) => setStartTasks(event.target.checked)}
            />
            <label htmlFor={`${id}-start-tasks`} className={styles.onLabel}>
              Start the Tasks it creates
            </label>
            <Help>
              The agent may start Tasks it created in this run. They join the queue and wait for a
              free slot like any other Task. Off, they wait in Backlog for you.
            </Help>
          </div>
        )}

        {lead && showsLead && (
          <fieldset className={styles.fieldset} disabled={draftBusy}>
            <LeadFields
              id={id}
              lead={lead}
              factoryLead={factoryLead}
              onChange={setLead}
              label="Provider · model · effort"
              help="The Provider used for drafting and each firing. Filled from the Factory’s lead."
            />
          </fieldset>
        )}

        {(!isCheck || checkAgent) && (
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <label className={styles.label} htmlFor={`${id}-priority`}>
                Priority
              </label>
              <Help>
                Where this Automation’s Runs wait among queued Tasks when every slot is taken. A Run
                goes ahead of a Task with the same priority; Tasks in Merge and Cleanup and Tasks
                already under way go first.
              </Help>
            </span>
            <Select
              id={`${id}-priority`}
              value={priority}
              onChange={(event) => {
                const chosen = event.target.value
                if (isOneOf(chosen, priorities)) setPriority(chosen)
              }}
            >
              {[...priorities].reverse().map((p) => (
                <option key={p} value={p}>
                  {priorityLabels[p]}
                </option>
              ))}
            </Select>
          </div>
        )}

        {!isCheck && (
          <div className={styles.on}>
            <input
              id={`${id}-checkout`}
              type="checkbox"
              className={styles.checkbox}
              checked={checkout}
              onChange={(event) => setCheckout(event.target.checked)}
            />
            <label htmlFor={`${id}-checkout`} className={styles.onLabel}>
              Run in a copy of the code
            </label>
            <Help>
              Each Run gets a fresh copy of the default branch and can start the Factory’s Apps
              there. Ted removes it when the Run ends.
            </Help>
          </div>
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
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!canSave} pending={busy && savingAndRunning} onClick={() => save(true)}>
          Save and run now
        </Button>
        <Button
          variant="primary"
          shortcut="⌘↵"
          aria-keyshortcuts="Meta+Enter"
          disabled={!canSave}
          pending={busy && !savingAndRunning}
          onClick={() => save(false)}
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
