import type { AgentDraftAnswer, AgentDraftPlace, ChatRequest, DiffLine } from '@ted/protocol'
import {
  type AgentPower,
  agentPowerHelp,
  agentPowerNames,
  maxAgentDraftInstructions,
  maxAgentName,
} from '@ted/protocol/agent-files'
import { fileChange } from '@ted/protocol/diff'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Markdown } from '../components/Markdown.tsx'
import grow from '../components/TextGrow.module.css'
import { dotted } from '../plans.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AgentDraftCard.module.css'
import chat from './PlanChat.module.css'

const places: readonly { value: AgentDraftPlace; label: string; help: string }[] = [
  { value: 'library', label: 'Library', help: 'Every Factory on this Mac. Saved at once.' },
  {
    value: 'factory',
    label: 'This Factory',
    help: 'Opens a settings pull request. It applies once merged.',
  },
]

const lineClass: Readonly<Record<DiffLine['kind'], string | undefined>> = {
  added: styles.lineAdded,
  removed: styles.lineRemoved,
  same: undefined,
  gap: styles.lineGap,
}

function numbered<T extends { kind: string }>(lines: readonly T[]): (T & { key: string })[] {
  return lines.map((line, n) => ({ ...line, key: `${n}:${line.kind}` }))
}

export function AgentDraftCard({
  chatId,
  request,
  agentName,
}: {
  chatId: string
  request: ChatRequest
  agentName: string
}) {
  const now = useNow()
  const draft = request.agentDraft
  const [name, setName] = useState(draft?.name ?? '')
  const [instructions, setInstructions] = useState(draft?.instructions ?? '')
  const [powers, setPowers] = useState<readonly AgentPower[]>(draft?.powers ?? [])
  const factoryOnly = draft?.current?.source === 'factory'
  const [where, setWhere] = useState<AgentDraftPlace>(
    factoryOnly ? 'factory' : (draft?.place ?? 'library'),
  )
  const [showFull, setShowFull] = useState(false)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const preview = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = preview.current
    setOverflows(box !== null && box.scrollHeight > box.clientHeight)
  })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  if (!draft) return null
  const current = draft.current
  const shown = current ? [...new Set([...current.powers, ...draft.powers])] : draft.powers
  const diff = current ? fileChange('instructions', current.instructions, instructions) : undefined
  const ready =
    name.trim() !== '' &&
    name.trim().length <= maxAgentName &&
    instructions.trim() !== '' &&
    instructions.length <= maxAgentDraftInstructions
  const action = current ? 'Save change' : 'Create'

  async function send(answer: AgentDraftAnswer) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerAgentDraft(chatId, request.id, answer)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      className={`${chat.request} ${styles.card}`}
      aria-label={`Agent draft from ${agentName}`}
      data-request={request.id}
      data-agent-draft={draft.id}
    >
      <div className={`${chat.cardHead} ${styles.head}`}>
        <span className={styles.dot} aria-hidden />
        <span className={chat.pendingKind}>Agent draft</span>
        <span>{`· ${dotted(`from ${agentName}`, ago(request.createdAt, now))}`}</span>
      </div>
      <div className={styles.identity}>
        <span className={styles.monogram} aria-hidden>
          {initials(name)}
        </span>
        <div className={styles.naming}>
          <input
            type="text"
            className={styles.name}
            aria-label="Name"
            value={name}
            maxLength={maxAgentName}
            disabled={sending}
            onChange={(event) => setName(event.target.value)}
          />
          <span className={styles.file}>{`agents/${draft.id}.md`}</span>
          {current && <span className={styles.changes}>{`Changes ${current.name}`}</span>}
        </div>
      </div>
      {request.body !== '' && <Markdown className={styles.summary} text={request.body} />}
      <fieldset className={styles.section}>
        <legend className={styles.label}>Powers</legend>
        {shown.length === 0 ? (
          <p className={styles.hint}>No powers: it only talks with you.</p>
        ) : (
          <div className={styles.tiles}>
            {shown.map((power) => {
              const drafted = draft.powers.includes(power)
              const added = current !== undefined && drafted && !current.powers.includes(power)
              return (
                <label
                  key={power}
                  className={drafted ? styles.tile : `${styles.tile} ${styles.removed}`}
                  data-power={power}
                >
                  <input
                    type="checkbox"
                    checked={drafted && powers.includes(power)}
                    disabled={!drafted || sending}
                    onChange={(event) =>
                      setPowers(
                        event.target.checked
                          ? draft.powers.filter((p) => p === power || powers.includes(p))
                          : powers.filter((p) => p !== power),
                      )
                    }
                  />
                  <span>
                    <span className={styles.tileName}>
                      {agentPowerNames[power]}
                      {added && <span className={styles.added}>New</span>}
                    </span>
                    <span className={styles.hint}>
                      {drafted ? agentPowerHelp[power] : 'The draft removes this power.'}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <p className={styles.hint}>
          Untick a power to leave it out. To add one the draft doesn’t have, change the Agent in
          settings after saving it.
        </p>
      </fieldset>
      {diff && !showFull ? (
        <div className={styles.section}>
          <span className={styles.label}>What changes in the instructions</span>
          {diff.lines.length === 0 ? (
            <p className={styles.hint}>The instructions stay the same.</p>
          ) : (
            <div className={styles.diff}>
              {numbered(diff.lines).map((line) => (
                <div key={line.key} className={lineClass[line.kind]}>
                  {line.kind === 'gap'
                    ? line.text
                    : `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`}
                </div>
              ))}
            </div>
          )}
          <Button
            size="small"
            variant="quiet"
            onClick={() => {
              setShowFull(true)
              setEditing(true)
            }}
          >
            Edit the full instructions
          </Button>
        </div>
      ) : (
        <div className={styles.section}>
          <div className={styles.labelRow}>
            <span className={styles.label} id={`${request.id}-instructions`}>
              Instructions
            </span>
            <Button size="small" variant="quiet" onClick={() => setEditing(!editing)}>
              {editing ? 'Preview' : 'Edit'}
            </Button>
          </div>
          {editing ? (
            <>
              <textarea
                className={`${styles.instructions} ${grow.text}`}
                aria-labelledby={`${request.id}-instructions`}
                value={instructions}
                disabled={sending}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <span className={styles.hint}>
                {`Up to ${maxAgentDraftInstructions.toLocaleString('en-US')} characters. Ted adds the commands its powers allow.`}
              </span>
            </>
          ) : (
            <>
              <div
                ref={preview}
                className={[
                  styles.preview,
                  !expanded && styles.clipped,
                  !expanded && overflows && styles.faded,
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-labelledby={`${request.id}-instructions`}
                role="document"
              >
                <Markdown text={instructions} />
              </div>
              {!expanded && overflows && (
                <Button size="small" variant="quiet" onClick={() => setExpanded(true)}>
                  Show all
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <fieldset className={styles.section}>
        <legend className={styles.label}>Save to</legend>
        <div className={styles.tiles}>
          {places.map((place) => (
            <label key={place.value} className={`${styles.tile} ${styles.place}`}>
              <input
                type="radio"
                name={`${request.id}-where`}
                value={place.value}
                checked={where === place.value}
                disabled={sending || (factoryOnly && place.value === 'library')}
                onChange={() => setWhere(place.value)}
              />
              <span>
                <span className={styles.tileName}>{place.label}</span>
                <span className={styles.hint}>{place.help}</span>
              </span>
            </label>
          ))}
        </div>
        {factoryOnly && (
          <p className={styles.hint}>
            This Factory defines this Agent, so the change goes to This Factory.
          </p>
        )}
      </fieldset>
      {error !== undefined && (
        <p className={chat.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.footer}>
        <span
          className={styles.hint}
        >{`Only you can save it. Nothing is saved until you click ${action}.`}</span>
        <Button variant="quiet" disabled={sending} onClick={() => send({ action: 'dismiss' })}>
          Dismiss
        </Button>
        <Button
          variant="primary"
          disabled={sending || !ready}
          pending={sending}
          onClick={() =>
            send({
              action: 'create',
              where,
              name: name.trim(),
              instructions,
              powers: [...powers],
            })
          }
        >
          {action}
        </Button>
      </div>
    </section>
  )
}

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word[0] ?? '')
    .join('')
  return (letters.slice(0, 2) || '?').toUpperCase()
}
