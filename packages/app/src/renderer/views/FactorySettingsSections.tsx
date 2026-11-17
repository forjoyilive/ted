import type {
  AgentChoiceInput,
  AgentRole,
  AgentRowView,
  AgentStageId,
  CheckInput,
  CheckTry,
  ClarifyDepth,
  Effort,
  FactorySettingsView,
  InvalidSettings,
  LayerKind,
  LibraryInvalid,
  StageDrift,
  StageId,
  StageRowView,
} from '@ted/protocol'
import { cleanupStepProblem } from '@ted/protocol/factory-settings'
import {
  handsOff,
  hasClarifyRounds,
  isCleanup,
  isEntryStage,
  mergesHere,
  validates,
} from '@ted/protocol/stage'
import { memo, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { Button } from '../components/Button.tsx'
import { FactoryNotificationChoices } from '../components/FactoryNotifications.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { Select } from '../components/Select.tsx'
import { StageEffort } from '../components/StageEffort.tsx'
import grow from '../components/TextGrow.module.css'
import { useEventValue, useSettings } from '../data.ts'
import {
  agentEdited,
  type CleanupStepDraft,
  cleanupStepInput,
  driftLine,
  lastRunText,
  lastValidLine,
  type SettingsDraft,
  type StageDraft,
  stageEdited,
} from '../factory-settings.ts'
import { type MarkdownBlock, markdownBlocks, markdownSpans } from '../markdown.ts'
import { OvernightNotice } from '../overnight.tsx'
import { usePendingAction } from '../pending-action.ts'
import type { SettingId } from '../settings-search.ts'
import { readableError, ted } from '../ted.ts'
import base from './FactorySettings.module.css'
import styles from './FactorySettingsSections.module.css'
import { DiffLines } from './SaveSettingsDialog.tsx'

type Update = (change: (draft: SettingsDraft) => SettingsDraft) => void

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'
const machineShort = navigator.userAgent.includes('Mac') ? 'this Mac’s' : 'this computer’s'
const layerNames: Record<LayerKind, string> = {
  ted: 'Default',
  library: 'Library',
  factory: 'Factory',
}
const depthNames: Record<ClarifyDepth, string> = {
  auto: 'Auto',
  none: 'None',
  few: 'Few',
  grilling: 'Grilling',
}
const roleNames: Record<AgentRole, string> = {
  lead: 'Task Lead',
  reviewer: 'Reviewer',
  planner: 'Planner',
}
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function Edited({ when }: { when: boolean }) {
  return when ? <span className={base.edited}>Edited</span> : null
}

export function FromChip({ layer }: { layer: LayerKind }) {
  const tone =
    layer === 'factory'
      ? styles.fromFactory
      : layer === 'library'
        ? styles.fromLibrary
        : styles.fromDefault
  return <span className={`${styles.fromChip} ${tone}`}>{layerNames[layer]}</span>
}

export function Toggle({
  label,
  checked,
  disabled,
  title: tip,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  title?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <ActionButton
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      title={tip}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </ActionButton>
  )
}

export function ValidateRounds({
  stage,
  onStage,
}: {
  stage: Pick<StageDraft, 'p1OnlyFrom' | 'subAgents'> | undefined
  onStage: (fields: Pick<StageDraft, 'p1OnlyFrom' | 'subAgents'>) => void
}) {
  const from = stage?.p1OnlyFrom ?? false
  const rounds = [2, 3, 4, 5, 6]
  if (from !== false && !rounds.includes(from)) rounds.push(from)
  return (
    <div className={styles.validateRounds}>
      <span className={styles.roundSetting} data-setting="factory.workflow.p1-only">
        Send back only for P1 findings
        <Select
          aria-label="Validate sends back only for P1 findings"
          controlClassName={styles.cellSelect}
          value={from === false ? 'off' : String(from)}
          onChange={(event) =>
            onStage({
              p1OnlyFrom: event.target.value === 'off' ? false : Number(event.target.value),
            })
          }
        >
          <option value="off">Off</option>
          {rounds.map((round) => (
            <option key={round} value={round}>
              From round {round}
            </option>
          ))}
        </Select>
        <Help>
          Off: every blocking finding sends the Task back to Work. From a round: in that round of
          Validate and every later one, a new finding sends it back only if it is P1. P1 means lost
          or corrupted data, a security hole, or broken behaviour the Task asks for. A finding from
          an earlier round that is still not fixed sends it back too. Every other new finding stays
          unfixed and is listed as a note for you at Review. You get fewer rounds, and problems
          Validate found can merge if you approve without reading the notes.
        </Help>
      </span>
      <span className={styles.roundSetting} data-setting="factory.workflow.validate-sub-agents">
        Other sub-agents in Validate
        <Toggle
          label="Other sub-agents in Validate"
          checked={stage?.subAgents === true}
          onChange={(subAgents) => onStage({ subAgents })}
        />
        <Help>
          Off: in Validate the Task Lead can start only TED’s reviewer, one per visit. On: it can
          also start other sub-agents, for example to run slow tests. Each one takes a working Run,
          and a sub-agent that reviews the diff adds findings that can cost another round. The
          one-reviewer rule stays either way.
        </Help>
      </span>
    </div>
  )
}

export function WorkFailures({
  stage,
  onStage,
}: {
  stage: Pick<StageDraft, 'leadClosesFailures'> | undefined
  onStage: (fields: Pick<StageDraft, 'leadClosesFailures'>) => void
}) {
  return (
    <div className={styles.validateRounds}>
      <span className={styles.roundSetting} data-setting="factory.workflow.lead-closes-failures">
        Task Lead closes its own fixed failures
        <Toggle
          label="Task Lead closes its own fixed failures"
          checked={stage?.leadClosesFailures === true}
          onChange={(leadClosesFailures) => onStage({ leadClosesFailures })}
        />
        <Help>
          Off: when a test the Task Lead ran itself failed outside Validate and it recorded the
          failure, only you can close it, from a question in your Inbox. On: once the Task Lead runs
          the test again and it passes, it closes the failure itself with that evidence, and you get
          a line in the thread and no question. TED doesn’t run the test, so you are trusting the
          Task Lead’s report. Failed checks and failures found in Validate still need your decision,
          and only you can accept a failure that still happens.
        </Help>
      </span>
    </div>
  )
}

export function MergeCommitTitles({
  stage,
  onStage,
}: {
  stage: Pick<StageDraft, 'commitTitles'> | undefined
  onStage: (fields: Pick<StageDraft, 'commitTitles'>) => void
}) {
  return (
    <div className={styles.validateRounds}>
      <span className={styles.roundSetting} data-setting="factory.workflow.commit-titles">
        Task Lead writes the merge commit
        <Toggle
          label="Task Lead writes the merge commit"
          checked={stage?.commitTitles !== false}
          onChange={(commitTitles) => onStage({ commitTitles })}
        />
        <Help>
          On: at Merge the Task Lead gives each pull request a Conventional Commits title, such as
          “fix(app): keep the sidebar open (TED-12)”, and a short description. TED uses them as the
          merge commit’s subject and body. If the Task Lead writes none, TED keeps the Task’s title
          and GitHub’s own merge message. Off: TED keeps the Task’s title and GitHub’s merge
          message.
        </Help>
      </span>
    </div>
  )
}

export function InvalidNotice({
  invalid,
}: {
  invalid: LibraryInvalid & Partial<Pick<InvalidSettings, 'url'>>
}) {
  return (
    <section className={styles.invalid} role="alert" aria-label={`${invalid.file} has an error`}>
      <div className={styles.invalidHead}>
        <span className={styles.warnMark} aria-hidden>
          ▲
        </span>
        <span className={styles.invalidTitle}>{invalid.file} has an error</span>
        <span className={base.spacer} />
        {invalid.url !== undefined && (
          <Button onClick={() => ted.openOnGitHub(invalid.url ?? '')}>Open on GitHub</Button>
        )}
      </div>
      <p className={styles.invalidLine}>
        {invalid.line > 0 && (
          <span className={styles.invalidAt}>
            line {invalid.line}, column {invalid.column}
          </span>
        )}
        <span>{invalid.message}</span>
      </p>
      <p className={styles.invalidText}>{lastValidLine(invalid, Date.now())}</p>
    </section>
  )
}

function SectionHeading({
  id,
  setting,
  title: heading,
  help,
  where = 'repo',
}: {
  id: string
  setting: SettingId
  title: string
  help: ReactNode
  where?: 'repo' | 'machine'
}) {
  return (
    <div className={base.sectionHeading} data-setting={setting}>
      <h2 id={id} className={base.sectionTitle}>
        {heading}
      </h2>
      <Help>{help}</Help>
      {where === 'repo' ? (
        <span className={base.repoChip}>In the repo</span>
      ) : (
        <span className={base.machineChip}>Saved on {machine}</span>
      )}
    </div>
  )
}

function WorkflowSectionView({
  view,
  draft,
  loaded,
  onDraft,
  onOpenCleanup,
}: {
  view: FactorySettingsView
  draft: SettingsDraft
  loaded: SettingsDraft
  onDraft: Update
  onOpenCleanup: () => void
}) {
  const [editing, setEditing] = useState<StageId>()
  const setStage = (id: StageId, fields: Partial<SettingsDraft['stages'][StageId]>) =>
    onDraft((d) => {
      const current = d.stages[id]
      if (!current) return d
      return { ...d, stages: { ...d.stages, [id]: { ...current, ...fields } } }
    })
  const setFile = (id: StageId, text: string | null) =>
    onDraft((d) => ({ ...d, stageFiles: { ...d.stageFiles, [id]: text } }))
  const keep = (id: AgentStageId) =>
    onDraft((d) =>
      d.keepStageFiles.includes(id) ? d : { ...d, keepStageFiles: [...d.keepStageFiles, id] },
    )
  const review = draft.stages.review
  const merge = draft.stages.merge
  const reviewGateOff =
    review !== undefined &&
    merge?.enabled === true &&
    (review.enabled === false || review.gate === false)

  return (
    <section className={base.section} aria-labelledby="workflow">
      <SectionHeading
        id="workflow"
        setting="factory.workflow"
        title="Workflow"
        help="The Stages a Task moves through, saved in .ted/workflow.yaml. Stage files hold each Stage’s instructions; Override copies one into .ted/stages/ for this Factory. Task Lead effort applies at Stage entry unless the Task has its own effort."
      />
      <OvernightNotice />
      <div className={`${styles.table} ${styles.workflowTable}`}>
        <div className={`${styles.workflowRow} ${styles.headRow}`}>
          <span>Stage</span>
          <span>On</span>
          <span className={styles.gateHeading}>
            Sign-off
            <Help>
              When on, the Task waits for your approval at the end of this Stage before moving on.
              If the Stage skips itself, its sign-off is skipped too.
            </Help>
          </span>
          <span>Send-backs</span>
          <span>Clarify depth</span>
          <span>Task Lead effort</span>
          <span>From</span>
          <span className={base.visuallyHidden}>Actions</span>
        </div>
        {view.stages.map((row) => (
          <StageRow
            key={row.id}
            row={row}
            draft={draft}
            edited={stageEdited(draft, loaded, row.id)}
            editing={editing === row.id}
            onStage={(fields) => setStage(row.id, fields)}
            onFile={(text) => setFile(row.id, text)}
            onEdit={(open) => setEditing(open ? row.id : undefined)}
            onKeep={() => keep(row.id as AgentStageId)}
            factoryId={view.factoryId}
            {...(isCleanup(row.id) && {
              cleanup: {
                enabled: draft.cleanup.enabled,
                edited: draft.cleanup.enabled !== loaded.cleanup.enabled,
                steps: draft.cleanup.steps.length,
                onEnabled: (enabled: boolean) =>
                  onDraft((d) => ({ ...d, cleanup: { ...d.cleanup, enabled } })),
                onSteps: onOpenCleanup,
              },
            })}
          />
        ))}
      </div>
      {reviewGateOff && (
        <p className={styles.warning}>
          <span className={styles.warnMark} aria-hidden>
            ▲
          </span>{' '}
          The Review sign-off is off, so Merge runs right after Validate without your sign-off.
        </p>
      )}
      {view.ignoredStageFiles.map((file) => (
        <p key={file} className={styles.warning}>
          <span className={styles.warnMark} aria-hidden>
            ▲
          </span>{' '}
          {file} is ignored: no Stage in this Workflow’s order uses it. Add its Stage to `order` in
          .ted/workflow.yaml, or put its steps in the Stage file they belong to.
        </p>
      ))}
    </section>
  )
}

function StageRow({
  row,
  draft,
  edited,
  editing,
  onStage,
  onFile,
  onEdit,
  onKeep,
  factoryId,
  cleanup,
}: {
  row: StageRowView
  draft: SettingsDraft
  edited: Set<string>
  editing: boolean
  onStage: (fields: Partial<SettingsDraft['stages'][StageId]>) => void
  onFile: (text: string | null) => void
  onEdit: (open: boolean) => void
  onKeep: () => void
  factoryId: string
  cleanup?: CleanupRow
}) {
  const stage = draft.stages[row.id]
  const { name } = row
  const agent = row.id !== 'backlog' && row.id !== 'done'
  const decides = agent && !isCleanup(row.id)
  const file = agent
    ? (draft.stageFiles[row.id as Exclude<StageId, 'backlog' | 'done'>] ?? null)
    : null
  const from: LayerKind = !agent
    ? 'ted'
    : file !== null
      ? 'factory'
      : (row.inherited?.layer ?? (row.from === 'factory' ? 'ted' : row.from))
  const fixed = row.id === 'backlog' || isEntryStage(row.id) || handsOff(row.id)
  const dash = <span className={styles.dash}>—</span>
  const drift =
    agent && file !== null && !draft.keepStageFiles.includes(row.id as AgentStageId)
      ? row.drift
      : undefined
  return (
    <div
      className={drift ? styles.stageDrift : editing ? styles.stageOpen : styles.stageBlock}
      data-setting={cleanup ? 'factory.workflow.cleanup' : undefined}
    >
      <div className={styles.workflowRow}>
        <span className={styles.stageName}>
          {name}
          {row.custom && <CustomTag />}
          {drift && (
            <span className={styles.driftDot} role="img" aria-label="Inherited version changed" />
          )}{' '}
          <Edited when={edited.size > 0 || cleanup?.edited === true} />
        </span>
        <span>
          {row.id === 'done' ? (
            dash
          ) : fixed ? (
            <span className={styles.always} title={`${name} can’t be turned off`}>
              Always on
            </span>
          ) : row.custom ? (
            <InOrder name={name} />
          ) : cleanup ? (
            <Toggle label={`${name} on`} checked={cleanup.enabled} onChange={cleanup.onEnabled} />
          ) : (
            <Toggle
              label={`${name} on`}
              checked={stage?.enabled ?? row.enabled}
              disabled={!row.inOrder}
              {...(!row.inOrder && { title: `${name} isn’t in this Factory’s order` })}
              onChange={(enabled) => onStage({ enabled })}
            />
          )}
        </span>
        <span>
          {decides ? (
            <Toggle
              label={`${name} sign-off`}
              checked={stage?.gate ?? row.gate}
              onChange={(gate) => onStage({ gate })}
            />
          ) : (
            dash
          )}
        </span>
        <span>
          {decides ? (
            <input
              aria-label={`${name} send-backs`}
              className={styles.numberInput}
              inputMode="numeric"
              value={stage?.maxBack ?? ''}
              onChange={(event) => {
                const text = event.target.value.replace(/\D/g, '')
                if (text !== '') onStage({ maxBack: Number(text) })
              }}
            />
          ) : (
            dash
          )}
        </span>
        <span>
          {hasClarifyRounds(row.id) ? (
            <Select
              fullWidth
              aria-label="Clarify depth"
              controlClassName={styles.cellSelect}
              value={stage?.depth ?? 'auto'}
              onChange={(event) => onStage({ depth: event.target.value as ClarifyDepth })}
            >
              {Object.entries(depthNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          ) : (
            dash
          )}
        </span>
        <span>
          {agent ? (
            <StageEffort
              stage={name}
              value={stage?.effort}
              inherited={row.inheritedEffort}
              source={row.inheritedEffortFrom}
              onChange={(effort) => onStage({ effort })}
            />
          ) : (
            dash
          )}
        </span>
        <span>
          <FromChip layer={from} />
        </span>
        <span className={styles.actions}>
          {row.id === 'backlog' && <span className={styles.always}>Always first</span>}
          {row.id === 'done' && <span className={styles.always}>Always last</span>}
          {cleanup && (
            <ActionButton type="button" className={base.link} onClick={cleanup.onSteps}>
              {stepsLabel(cleanup.steps)}
            </ActionButton>
          )}
          {agent && file === null && row.inherited && (
            <ActionButton
              type="button"
              className={base.link}
              onClick={() => {
                onFile(row.inherited?.text ?? '')
                return onEdit(true)
              }}
            >
              Override
            </ActionButton>
          )}
          {agent && file !== null && (
            <>
              <ActionButton type="button" className={base.link} onClick={() => onEdit(!editing)}>
                {editing ? 'Close file' : 'Edit file'}
              </ActionButton>
              {row.inherited && (
                <ActionButton
                  type="button"
                  className={base.link}
                  onClick={() => {
                    onFile(null)
                    return onEdit(false)
                  }}
                >
                  Reset to inherited
                </ActionButton>
              )}
            </>
          )}
        </span>
      </div>
      {validates(row.id) && <ValidateRounds stage={stage} onStage={onStage} />}
      {handsOff(row.id) && <WorkFailures stage={stage} onStage={onStage} />}
      {mergesHere(row.id) && <MergeCommitTitles stage={stage} onStage={onStage} />}
      {cleanup?.enabled && cleanup.steps === 0 && (
        <CleanupWithoutSteps>
          Cleanup is on but has no steps, so it won’t run. Add a step under Cleanup.
        </CleanupWithoutSteps>
      )}
      {drift && (
        <DriftNotice
          stage={row.id as AgentStageId}
          name={name}
          drift={drift}
          label="Inherited"
          useLabel="Use inherited"
          onKeep={onKeep}
          onUse={() => {
            onFile(null)
            onEdit(false)
          }}
          factoryId={factoryId}
        />
      )}
      {editing && file !== null && (
        <div className={styles.fileEditor}>
          <div className={styles.fileHead}>
            <span className={base.mono}>.ted/stages/{row.id}.md</span>
            <span className={base.spacer} />
            <Edited when={edited.has('file')} />
          </div>
          <textarea
            aria-label={`${name} Stage file`}
            className={`${styles.fileText} ${grow.text}`}
            value={file}
            spellCheck={false}
            onChange={(event) => onFile(event.target.value)}
          />
        </div>
      )}
    </div>
  )
}

interface CleanupRow {
  enabled: boolean
  edited: boolean
  steps: number
  onEnabled: (enabled: boolean) => void
  onSteps: () => void
}

function stepsLabel(steps: number): string {
  return steps === 0 ? 'Add steps →' : `Steps (${steps}) →`
}

export function CustomTag() {
  return (
    <span className={styles.customTag} title="A Stage written by hand in workflow.yaml">
      Custom
    </span>
  )
}

export function InOrder({ name, where = 'this Factory’s' }: { name: string; where?: string }) {
  return (
    <span
      className={styles.always}
      title={`${name} is on because ${where} order lists it. Edit order in workflow.yaml to remove it.`}
    >
      In order
    </span>
  )
}

export function CleanupWithoutSteps({ children }: { children: string }) {
  return (
    <p className={`${styles.warning} ${styles.rowWarning}`}>
      <span className={styles.warnMark} aria-hidden>
        ▲
      </span>{' '}
      {children}
    </p>
  )
}

export function DriftNotice({
  stage,
  name,
  drift,
  label,
  useLabel,
  onKeep,
  onUse,
  factoryId,
}: {
  stage: AgentStageId
  name: string
  drift: StageDrift
  label: 'Inherited' | 'Default'
  useLabel: string
  onKeep: () => void
  onUse: () => void
  factoryId?: string
}) {
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string>()
  const [error, setError] = useState<string>()
  const merge = async () => {
    if (factoryId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const task = await ted.mergeInherited(factoryId, stage)
      setCreated(task.displayId)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={styles.driftBody} aria-label={`${name} drift`}>
      <p className={styles.driftLine}>
        <span className={styles.warnMark} aria-hidden>
          ▲
        </span>{' '}
        {driftLine(stage, drift, label)}
      </p>
      {drift.diffOf === 'yours' && (
        <p className={styles.driftCaption}>
          TED doesn’t have the version your copy was made from, so this compares your copy with the{' '}
          {label === 'Default' ? 'default' : 'inherited file'}.
        </p>
      )}
      <div className={styles.driftDiff}>
        <DiffLines lines={drift.diff} />
      </div>
      <div className={styles.driftActions}>
        <Button onClick={onKeep}>Keep mine</Button>
        <Button onClick={onUse}>{useLabel}</Button>
        {factoryId !== undefined && (
          <>
            <Button disabled={busy || created !== undefined} onClick={() => merge()}>
              Merge with an agent
            </Button>
            <Help>
              Creates a Task in this Factory that folds the inherited changes into your copy and
              updates based_on. Its Review sign-off is always on, so you see the result before it
              merges.
            </Help>
          </>
        )}
        {created !== undefined && (
          <span className={styles.driftCaption}>{created} will merge the changes.</span>
        )}
      </div>
      {error !== undefined && <p className={styles.driftError}>{error}</p>}
    </section>
  )
}

function ChecksSectionView({
  view,
  draft,
  tries,
  onDraft,
}: {
  view: FactorySettingsView
  draft: SettingsDraft
  tries: CheckTry[]
  onDraft: Update
}) {
  const starting = usePendingAction(`check-try:${view.factoryId}`)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string>()
  const [output, setOutput] = useState<string>()
  const keys = useRef<string[]>([])
  const counter = useRef(0)
  while (keys.current.length < draft.checks.length) keys.current.push(`check-${counter.current++}`)
  if (keys.current.length > draft.checks.length) keys.current.length = draft.checks.length
  const running = tries.some((t) => t.state === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const multiRepo = draft.repos.length > 1
  const setCheck = (index: number, fields: Partial<CheckInput>) =>
    onDraft((d) => ({
      ...d,
      checks: d.checks.map((c, i) => {
        if (i !== index) return c
        const next = { ...c, ...fields }
        for (const key of ['repo', 'timeout'] as const) if (next[key] === '') delete next[key]
        return next
      }),
    }))

  function runNow(check: CheckInput) {
    return starting.run(async () => {
      setError(undefined)
      try {
        await ted.tryCheck(view.factoryId, {
          name: check.name.trim(),
          run: check.run.trim(),
          ...(check.repo !== undefined && { repo: check.repo }),
          ...(check.timeout !== undefined &&
            check.timeout.trim() !== '' && { timeout: check.timeout.trim() }),
        })
        setNow(Date.now())
      } catch (failure) {
        setError(readableError(failure))
      }
    })
  }

  return (
    <section className={`${base.section} ${base.wideSection}`} aria-labelledby="checks">
      <SectionHeading
        id="checks"
        setting="factory.checks"
        title="Checks"
        help="Commands TED runs at Validate, one after another, before the agent’s own checks. Run now tries one on the base branch in a scratch worktree."
      />
      <div className={styles.table}>
        <div className={styles.scrollTable}>
          <div className={`${multiRepo ? styles.checkRowRepo : styles.checkRow} ${styles.headRow}`}>
            <span>Name</span>
            <span>Command</span>
            {multiRepo && <span>Repo</span>}
            <span>Timeout</span>
            <span>Last run</span>
            <span className={base.visuallyHidden}>Actions</span>
          </div>
          {draft.checks.map((check, index) => {
            const last = tries.find((t) => t.name === check.name.trim())
            const ready = check.name.trim() !== '' && check.run.trim() !== ''
            return (
              <div
                key={keys.current[index]}
                className={multiRepo ? styles.checkRowRepo : styles.checkRow}
              >
                <input
                  aria-label="Check name"
                  className={styles.cellInput}
                  placeholder="Name"
                  value={check.name}
                  onChange={(event) => setCheck(index, { name: event.target.value })}
                />
                <input
                  aria-label={`${check.name || 'Check'} command`}
                  className={`${styles.cellInput} ${base.mono}`}
                  placeholder="npm test"
                  value={check.run}
                  onChange={(event) => setCheck(index, { run: event.target.value })}
                />
                {multiRepo && (
                  <Select
                    fullWidth
                    aria-label={`${check.name || 'Check'} repo`}
                    controlClassName={styles.cellSelect}
                    value={check.repo ?? draft.repos[0]?.name ?? ''}
                    onChange={(event) =>
                      setCheck(index, {
                        repo: event.target.value === draft.repos[0]?.name ? '' : event.target.value,
                      })
                    }
                  >
                    {draft.repos.map((repo) => (
                      <option key={repo.name} value={repo.name}>
                        {repo.name}
                      </option>
                    ))}
                  </Select>
                )}
                <input
                  aria-label={`${check.name || 'Check'} timeout`}
                  className={styles.cellInput}
                  placeholder="10m"
                  value={check.timeout ?? ''}
                  onChange={(event) => setCheck(index, { timeout: event.target.value })}
                />
                <span className={lastRunClass(last)}>
                  {last ? lastRunText(last, now) : <span className={styles.dash}>Never</span>}
                  {last && last.state !== 'running' && (
                    <>
                      {' · '}
                      <ActionButton
                        type="button"
                        className={base.link}
                        onClick={() =>
                          ted.checkTryOutput(view.factoryId, last.name).then(
                            (shown) => setOutput(shown.text || 'No output.'),
                            (failure: unknown) => setError(readableError(failure)),
                          )
                        }
                      >
                        Output
                      </ActionButton>
                    </>
                  )}
                </span>
                <span className={styles.actions}>
                  {last?.state === 'running' ? (
                    <Button
                      size="small"
                      onClick={() =>
                        ted
                          .stopCheckTry(view.factoryId, last.name)
                          .catch((failure: unknown) => setError(readableError(failure)))
                      }
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      disabled={!ready || running || starting.pending}
                      title={running ? 'Another check is running.' : undefined}
                      onClick={() => runNow(check)}
                    >
                      Run now
                    </Button>
                  )}
                  <ActionButton
                    type="button"
                    className={base.iconButton}
                    aria-label={`Remove ${check.name || 'this check'}`}
                    onClick={() => {
                      keys.current.splice(index, 1)
                      return onDraft((d) => ({
                        ...d,
                        checks: d.checks.filter((_, i) => i !== index),
                      }))
                    }}
                  >
                    <CloseIcon size={12} />
                  </ActionButton>
                </span>
              </div>
            )
          })}
        </div>
        <div className={styles.builtInRow}>
          <span>TED settings</span>
          <span className={styles.builtInText}>Built in.</span>
          <span className={base.spacer} />
          <Help align="end">
            Added at Validate when a Task changes .ted/. It checks the TED settings files, like ted
            workflow check.
          </Help>
        </div>
      </div>
      <div>
        <ActionButton
          type="button"
          className={base.link}
          onClick={() => onDraft((d) => ({ ...d, checks: [...d.checks, { name: '', run: '' }] }))}
        >
          + Add check
        </ActionButton>
      </div>
      {error !== undefined && (
        <p className={base.fieldError} role="alert">
          {error}
        </p>
      )}
      {output !== undefined && <OutputDialog text={output} onClose={() => setOutput(undefined)} />}
    </section>
  )
}

function lastRunClass(last: CheckTry | undefined): string {
  if (!last) return styles.lastRun ?? ''
  if (last.state === 'passed') return `${styles.lastRun} ${styles.passed}`
  if (last.state === 'failed' || last.state === 'timed-out')
    return `${styles.lastRun} ${styles.failed}`
  return styles.lastRun ?? ''
}

function OutputDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={base.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className={base.dialogBody}>
        <h2 id={headingId} className={base.dialogHeading}>
          Check output
        </h2>
        <pre className={styles.output}>{text}</pre>
      </div>
      <footer className={base.dialogFooter}>
        <span className={base.spacer} />
        <Button onClick={onClose}>Close</Button>
      </footer>
    </dialog>
  )
}

function AgentsSectionView({
  view,
  draft,
  loaded,
  onDraft,
}: {
  view: FactorySettingsView
  draft: SettingsDraft
  loaded: SettingsDraft
  onDraft: Update
}) {
  const set = (role: AgentRole, choice: AgentChoiceInput | null) =>
    onDraft((d) => ({ ...d, agents: { ...d.agents, [role]: choice } }))
  return (
    <section className={`${base.section} ${base.wideSection}`} aria-labelledby="agents">
      <SectionHeading
        id="agents"
        setting="factory.agents"
        title="Providers"
        help="Which Provider, model and effort each role uses in this Factory. Rows marked Default or Library are inherited; Override sets them here."
      />
      <div className={`${styles.table} ${styles.scrollTable}`}>
        {view.agents.map((row) => (
          <AgentRow
            key={row.role}
            row={row}
            own={draft.agents[row.role]}
            edited={agentEdited(draft, loaded, row.role)}
            onChange={(choice) => set(row.role, choice)}
          />
        ))}
      </div>
    </section>
  )
}

function AgentRow({
  row,
  own,
  edited,
  onChange,
}: {
  row: AgentRowView
  own: AgentChoiceInput | null
  edited: boolean
  onChange: (choice: AgentChoiceInput | null) => void
}) {
  const shown = own ?? row.inherited
  const locked = own === null
  const name = roleNames[row.role]
  const update = (fields: Partial<AgentChoiceInput>) => {
    const next: AgentChoiceInput = { ...(own ?? {}), ...fields }
    for (const key of ['model', 'effort'] as const) if (!next[key]) delete next[key]
    onChange(next)
  }
  return (
    <div className={styles.agentRow}>
      <span className={styles.agentName}>
        <span>
          {name} <Edited when={edited} />
        </span>
        <span className={`${base.mono} ${styles.agentKey}`}>{row.role}</span>
      </span>
      <Select
        fullWidth
        aria-label={`${name} Provider`}
        controlClassName={styles.cellSelect}
        disabled={locked}
        value={shown.agent ?? 'claude'}
        onChange={(event) => update({ agent: event.target.value, model: '' })}
      >
        <AgentOptions current={shown.agent} same={row.role === 'reviewer'} />
      </Select>
      <ModelSelect
        fullWidth
        aria-label={`${name} model`}
        controlClassName={styles.cellSelect}
        inputClassName={`${styles.cellInput} ${base.mono}`}
        defaultLabel="default model"
        disabled={locked}
        agent={shown.agent ?? 'claude'}
        value={shown.model ?? ''}
        onChange={(model) => update({ model })}
      />
      <Select
        fullWidth
        aria-label={`${name} effort`}
        controlClassName={styles.cellSelect}
        disabled={locked}
        value={shown.effort ?? ''}
        onChange={(event) => {
          const effort = efforts.find((e) => e === event.target.value)
          if (effort === undefined) {
            const { effort: _, ...rest } = own ?? {}
            onChange(rest)
          } else update({ effort })
        }}
      >
        <option value="">default effort</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </Select>
      <FromChip layer={own ? 'factory' : row.inheritedFrom} />
      <span className={styles.actions}>
        {own ? (
          <ActionButton type="button" className={base.link} onClick={() => onChange(null)}>
            Reset to inherited
          </ActionButton>
        ) : (
          <ActionButton
            type="button"
            className={base.link}
            onClick={() => onChange({ ...row.inherited })}
          >
            Override
          </ActionButton>
        )}
      </span>
    </div>
  )
}

function PermissionsSectionView({
  view,
  draft,
  loaded,
  onDraft,
  onMode,
}: {
  view: FactorySettingsView
  draft: SettingsDraft
  loaded: SettingsDraft
  onDraft: Update
  onMode?: (mode: FactorySettingsView['permissions']) => void
}) {
  const id = useId()
  const { value: mode, update } = useEventValue({
    initial: view.permissions,
    key: view.factoryId,
    load: async () => view.permissions,
    event: (event) =>
      event.type === 'settings-changed'
        ? () => (event.settings.factoryPermissions[view.factoryId] === 'bypass' ? 'bypass' : 'auto')
        : undefined,
  })
  const setMode = (mode: typeof view.permissions) => update(() => mode)
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const dialog = useRef<HTMLDialogElement>(null)
  const bypass = mode === 'bypass'
  useEffect(() => update(() => view.permissions), [view, update])
  useEffect(() => {
    if (confirming) dialog.current?.showModal()
  }, [confirming])

  const save = async (next: 'auto' | 'bypass') => {
    setBusy(true)
    setError(undefined)
    try {
      const saved = await ted.setFactoryPermissions(view.factoryId, next, confirmed)
      setMode(saved.mode)
      onMode?.(saved.mode)
      setConfirming(false)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className={`${base.section} ${base.compactSection}`} aria-labelledby="permissions">
        <SectionHeading
          id="permissions"
          setting="factory.permissions"
          title="Permission mode"
          where="machine"
          help="Permission mode is saved only on this computer, separately for each Factory."
        />
        <p className={base.caption}>
          Saved here immediately. Applies to new and restarted Task Leads, sub-agents and reviewers,
          and new checks and agent-started Apps. Running processes keep their current permissions;
          stop them to end existing access. Planning, Automation and Coordinator Runs always use
          Auto.
        </p>
        {view.repoPermissions === 'bypass' && !bypass && (
          <p className={styles.bypass}>
            The repo requests Bypass. This computer uses Auto until you enable Bypass here.
          </p>
        )}
        <p>
          <strong>{bypass ? 'Bypass is on.' : 'Auto is on.'}</strong>
        </p>
        {bypass ? (
          <>
            <p className={styles.bypass}>
              Agents act without asking: they can run any command, change any file and use the
              network on {machine}. Agent-started checks and Apps run outside TED’s sandbox.
            </p>
            <Button disabled={busy} onClick={() => save('auto')}>
              Use Auto
            </Button>
          </>
        ) : (
          <>
            <p className={base.caption}>
              Agents use Auto permissions and requests reach your Inbox.
            </p>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmed(false)
                setError(undefined)
                setConfirming(true)
              }}
            >
              Enable Bypass…
            </Button>
          </>
        )}
        {error && !confirming && (
          <p role="alert" className={base.fieldError}>
            {error}
          </p>
        )}
        {confirming && (
          <dialog
            ref={dialog}
            className={base.dialog}
            aria-labelledby={`${id}-confirm`}
            onCancel={(event) => {
              event.preventDefault()
              if (!busy) setConfirming(false)
            }}
          >
            <div className={base.dialogBody}>
              <h2 id={`${id}-confirm`} className={base.dialogHeading}>
                Enable Bypass on this computer?
              </h2>
              <p className={styles.bypass}>
                Agents can run any command, change any file and use the network without asking.
                Agent-started checks and Apps also run outside TED’s sandbox. Use only on an
                isolated machine or VM. This choice applies only to this Factory on {machine}.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{' '}
                I understand and want to enable Bypass.
              </label>
              {error && (
                <p role="alert" className={base.fieldError}>
                  {error}
                </p>
              )}
            </div>
            <div className={base.dialogFooter}>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !confirmed}
                onClick={() => save('bypass')}
              >
                Enable Bypass
              </Button>
            </div>
          </dialog>
        )}
      </section>
      <section
        className={`${base.section} ${base.compactSection}`}
        aria-labelledby={`${id}-limits`}
      >
        <SectionHeading
          id={`${id}-limits`}
          setting="factory.permissions.working-run-limit"
          title="Working Run limit"
          help="This Factory’s limit follows its Workflow."
        />
        <div className={base.field}>
          <label className={base.label} htmlFor={`${id}-limit`}>
            Limit on working Runs{' '}
            <Edited when={draft.maxWorkingRuns.trim() !== loaded.maxWorkingRuns.trim()} />
          </label>
          <span className={styles.limitLine}>
            <input
              id={`${id}-limit`}
              className={styles.limitInput}
              inputMode="numeric"
              value={draft.maxWorkingRuns}
              onChange={(event) =>
                onDraft((d) => ({ ...d, maxWorkingRuns: event.target.value.replace(/\D/g, '') }))
              }
            />
            <span className={base.caption}>
              of {machineShort} {view.machineMaxWorkingRuns}
            </span>
            <Help>Leave empty to use only the Mac’s limit.</Help>
          </span>
        </div>
      </section>
    </>
  )
}

function NotesSectionView({
  draft,
  loaded,
  onDraft,
}: {
  draft: SettingsDraft
  loaded: SettingsDraft
  onDraft: Update
}) {
  const [preview, setPreview] = useState(false)
  return (
    <section className={`${base.section} ${base.wideSection}`} aria-labelledby="notes">
      <SectionHeading
        id="notes"
        setting="factory.notes"
        title="Factory notes"
        help="Facts about the product, given to every Run in this Factory: how to run it, conventions, risky areas. Stage instructions belong in Stage files."
      />
      <div className={styles.notes}>
        <div className={styles.notesBar}>
          <div className={styles.tabs} role="tablist" aria-label="Factory notes view">
            <ActionButton
              type="button"
              role="tab"
              aria-selected={!preview}
              className={preview ? styles.tab : styles.tabOn}
              onClick={() => setPreview(false)}
            >
              Edit
            </ActionButton>
            <ActionButton
              type="button"
              role="tab"
              aria-selected={preview}
              className={preview ? styles.tabOn : styles.tab}
              onClick={() => setPreview(true)}
            >
              Preview
            </ActionButton>
          </div>
          <span className={base.spacer} />
          <span className={base.caption}>.ted/notes.md · Markdown</span>
          <Help>
            Suggested headings: Product, Repos, Running locally, Conventions, Risky areas.
          </Help>
          <Edited when={draft.notes !== loaded.notes} />
        </div>
        {preview ? (
          <div className={styles.preview}>
            {draft.notes.trim() === '' ? (
              <p className={base.caption}>No Factory notes yet.</p>
            ) : (
              <Markdown text={draft.notes} />
            )}
          </div>
        ) : (
          <textarea
            aria-label="Factory notes"
            className={`${styles.notesText} ${grow.text}`}
            value={draft.notes}
            spellCheck={false}
            placeholder={'# Product\n\n## Running locally\n'}
            onChange={(event) => onDraft((d) => ({ ...d, notes: event.target.value }))}
          />
        )}
      </div>
    </section>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {keyed(markdownBlocks(text), (b) => `${b.kind}:${JSON.stringify(b)}`).map(({ key, item }) => (
        <Block key={key} block={item} />
      ))}
    </>
  )
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'
      return (
        <Tag className={styles[`h${Math.min(block.level, 3)}`]}>
          <Spans text={block.text} />
        </Tag>
      )
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className={styles.list}>
          {keyed(block.items, (item) => item).map(({ key, item }) => (
            <li key={key}>
              <Spans text={item} />
            </li>
          ))}
        </Tag>
      )
    }
    case 'code':
      return <pre className={styles.codeBlock}>{block.text}</pre>
    default:
      return (
        <p className={styles.paragraph}>
          <Spans text={block.text} />
        </p>
      )
  }
}

function Spans({ text }: { text: string }) {
  return (
    <>
      {keyed(markdownSpans(text), (span) => `${span.kind}:${span.text}`).map(
        ({ key, item: span }) => {
          if (span.kind === 'code')
            return (
              <code key={key} className={styles.code}>
                {span.text}
              </code>
            )
          if (span.kind === 'strong') return <strong key={key}>{span.text}</strong>
          if (span.kind === 'emphasis') return <em key={key}>{span.text}</em>
          return <span key={key}>{span.text}</span>
        },
      )}
    </>
  )
}

function keyed<T>(items: readonly T[], name: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = name(item)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { key: `${base}#${n}`, item }
  })
}

const newStep: CleanupStepDraft = {
  name: '',
  kind: 'instruction',
  instruction: '',
  command: '',
  timeout: '',
}

function CleanupSectionView({ draft, onDraft }: { draft: SettingsDraft; onDraft: Update }) {
  const keys = useRef<string[]>([])
  const counter = useRef(0)
  const touched = useRef(new Set<string>())
  const focusLast = useRef(false)
  const lastName = useRef<HTMLInputElement>(null)
  const { enabled, steps } = draft.cleanup
  while (keys.current.length < steps.length) keys.current.push(`step-${counter.current++}`)
  if (keys.current.length > steps.length) keys.current.length = steps.length
  useEffect(() => {
    if (!focusLast.current) return
    focusLast.current = false
    lastName.current?.focus()
  })
  const inputs = steps.map(cleanupStepInput)
  const setCleanup = (change: (cleanup: SettingsDraft['cleanup']) => SettingsDraft['cleanup']) =>
    onDraft((d) => ({ ...d, cleanup: change(d.cleanup) }))
  const setStep = (index: number, fields: Partial<CleanupStepDraft>) => {
    const key = keys.current[index]
    if (key !== undefined) touched.current.add(key)
    setCleanup((c) => ({
      ...c,
      steps: c.steps.map((step, i) => (i === index ? { ...step, ...fields } : step)),
    }))
  }
  const move = (index: number, by: number) => {
    const to = index + by
    const order = <T,>(list: T[]) => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      if (item !== undefined) next.splice(to, 0, item)
      return next
    }
    keys.current = order(keys.current)
    setCleanup((c) => ({ ...c, steps: order(c.steps) }))
  }

  return (
    <section className={`${base.section} ${base.compactSection}`} aria-labelledby="cleanup">
      <SectionHeading
        id="cleanup"
        setting="factory.cleanup"
        title="Cleanup"
        help="Steps that run after a Task’s pull requests merge and before it moves to Done. TED runs the command steps itself, then the Task Lead does the instruction steps."
      />
      <div className={base.autoStartRow} data-setting="factory.cleanup.enabled">
        <div className={base.block}>
          <span className={base.label}>Turn on Cleanup</span>
          <span className={base.caption}>Adds a Cleanup column between Merge and Done.</span>
        </div>
        <Toggle
          label="Turn on Cleanup"
          checked={enabled}
          onChange={(on) => setCleanup((c) => ({ ...c, enabled: on }))}
        />
      </div>
      <div className={base.block}>
        <span className={base.label}>Steps</span>
        <span className={base.caption}>
          In order. A command runs in the Task’s worktree, in the sandbox, and a failed command
          doesn’t stop the steps after it.
        </span>
      </div>
      {enabled && steps.length === 0 && (
        <p className={styles.cleanupNotice}>Cleanup stays off until it has at least one step.</p>
      )}
      {steps.map((step, index) => {
        const key = keys.current[index] ?? String(index)
        const input = inputs[index]
        const problem =
          input && touched.current.has(key) ? cleanupStepProblem(input, inputs) : undefined
        const label = step.name.trim() || `Step ${index + 1}`
        return (
          <div key={key} className={styles.cleanupStep}>
            <div className={styles.cleanupHead}>
              <span className={styles.cleanupNumber}>{index + 1}</span>
              <input
                ref={index === steps.length - 1 ? lastName : undefined}
                aria-label={`Step ${index + 1} name`}
                className={`${base.input} ${styles.cleanupName}`}
                placeholder="Name"
                value={step.name}
                onChange={(event) => setStep(index, { name: event.target.value })}
              />
              <Select
                aria-label={`${label} kind`}
                controlClassName={styles.cellSelect}
                value={step.kind}
                onChange={(event) =>
                  setStep(index, { kind: event.target.value as CleanupStepDraft['kind'] })
                }
              >
                <option value="instruction">Instruction</option>
                <option value="command">Command</option>
              </Select>
              <ActionButton
                type="button"
                className={base.iconButton}
                aria-label={`Move ${label} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </ActionButton>
              <ActionButton
                type="button"
                className={base.iconButton}
                aria-label={`Move ${label} down`}
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </ActionButton>
              <ActionButton
                type="button"
                className={base.iconButton}
                aria-label={`Remove ${label}`}
                onClick={() => {
                  keys.current.splice(index, 1)
                  setCleanup((c) => ({ ...c, steps: c.steps.filter((_, i) => i !== index) }))
                }}
              >
                <CloseIcon size={12} />
              </ActionButton>
            </div>
            {step.kind === 'instruction' ? (
              <label className={`${base.field} ${styles.cleanupBody}`}>
                <span className={base.caption}>Instruction for the Task Lead</span>
                <textarea
                  aria-label={`${label} instruction`}
                  className={`${base.input} ${styles.cleanupText} ${grow.text}`}
                  placeholder="Post a comment on the Asana task linking the merged pull request."
                  value={step.instruction}
                  onChange={(event) => setStep(index, { instruction: event.target.value })}
                />
              </label>
            ) : (
              <div className={`${styles.cleanupCommand} ${styles.cleanupBody}`}>
                <label className={base.field}>
                  <span className={base.caption}>Command</span>
                  <input
                    aria-label={`${label} command`}
                    className={`${base.input} ${base.mono}`}
                    placeholder="docker compose down"
                    value={step.command}
                    onChange={(event) => setStep(index, { command: event.target.value })}
                  />
                </label>
                <label className={base.field}>
                  <span className={base.caption}>Timeout</span>
                  <input
                    aria-label={`${label} timeout`}
                    className={base.input}
                    placeholder="10m"
                    value={step.timeout}
                    onChange={(event) => setStep(index, { timeout: event.target.value })}
                  />
                </label>
              </div>
            )}
            {problem !== undefined && (
              <p className={`${base.fieldError} ${styles.cleanupBody}`} role="alert">
                {problem}
              </p>
            )}
          </div>
        )
      })}
      <div>
        <ActionButton
          type="button"
          className={base.link}
          onClick={() => {
            focusLast.current = true
            setCleanup((c) => ({ ...c, steps: [...c.steps, { ...newStep }] }))
          }}
        >
          + Add step
        </ActionButton>
      </div>
    </section>
  )
}

function sameDraft<P extends { draft: SettingsDraft }>(...fields: (keyof SettingsDraft)[]) {
  return (before: P, after: P) =>
    (Object.keys(after) as (keyof P)[]).every((name) =>
      name === 'draft'
        ? fields.every((field) => before.draft[field] === after.draft[field])
        : before[name] === after[name],
    )
}

export const WorkflowSection = memo(
  WorkflowSectionView,
  sameDraft('stages', 'stageFiles', 'keepStageFiles', 'cleanup'),
)
export const ChecksSection = memo(ChecksSectionView, sameDraft('checks', 'repos'))
export const CleanupSection = memo(CleanupSectionView, sameDraft('cleanup'))
export const AgentsSection = memo(AgentsSectionView, sameDraft('agents'))
export function NotificationsSection({ factoryId }: { factoryId: string }) {
  const settings = useSettings()
  return (
    <section className={`${base.section} ${base.compactSection}`} aria-labelledby="notifications">
      <SectionHeading
        id="notifications"
        setting="factory.notifications"
        title="Notifications"
        where="machine"
        help="Which of this Factory’s events notify you. The same choices are in Settings → Notifications, under By Factory."
      />
      <p className={base.caption}>
        Saved here immediately. A notification is sent only when it is also on in Settings →
        Notifications.
      </p>
      {settings && <FactoryNotificationChoices settings={settings} factoryId={factoryId} />}
    </section>
  )
}

export const PermissionsSection = memo(PermissionsSectionView, sameDraft('maxWorkingRuns'))
export const NotesSection = memo(NotesSectionView, sameDraft('notes'))
