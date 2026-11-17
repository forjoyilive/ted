import type { AgentDraftAnswer, AgentDraftPlace, ChatRequest, DiffLine } from '@ted/protocol'
import {
  type AgentPower,
  agentPowerHelp,
  agentPowerNames,
  maxAgentDraftInstructions,
  maxAgentName,
} from '@ted/protocol/agent-files'
import { fileChange } from '@ted/protocol/diff'
import { useState } from 'react'
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
  const [where, setWhere] = useState<AgentDraftPlace>(factoryOnly ? 'factory' : 'library')
  const [showFull, setShowFull] = useState(false)
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
      className={chat.request}
      aria-label={`Agent draft from ${agentName}`}
      data-request={request.id}
      data-agent-draft={draft.id}
    >
      <div className={chat.cardHead}>
        <span className={chat.pendingKind}>Agent draft</span>
        <span>{`· ${dotted(`from ${agentName}`, ago(request.createdAt, now))}`}</span>
      </div>
      <p className={chat.cardTitle}>{request.title}</p>
      {request.body !== '' && <Markdown className={chat.summary} text={request.body} />}
      <p className={styles.note}>
        {current
          ? `This changes ${current.name}. Nothing is saved until you click Save change.`
          : 'Nothing is saved until you click Create. You can edit the name and instructions and untick powers first.'}
      </p>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            type="text"
            className={styles.input}
            value={name}
            maxLength={maxAgentName}
            disabled={sending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>ID</span>
          <input type="text" className={styles.input} value={draft.id} readOnly />
          <span className={styles.hint}>{`Names its files: agents/${draft.id}.md`}</span>
        </label>
      </div>
      <fieldset className={styles.group}>
        <legend className={styles.label}>Powers</legend>
        {shown.length === 0 && <p className={styles.hint}>No powers: it only talks with you.</p>}
        {shown.map((power) => {
          const drafted = draft.powers.includes(power)
          const added = current !== undefined && drafted && !current.powers.includes(power)
          return (
            <label
              key={power}
              className={drafted ? styles.power : `${styles.power} ${styles.removed}`}
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
                <span className={styles.powerName}>
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
        <p className={styles.hint}>
          Untick a power to leave it out. To add one the draft doesn’t have, change the Agent in
          settings after saving it.
        </p>
      </fieldset>
      {diff && !showFull && (
        <div className={styles.group}>
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
          <Button size="small" variant="quiet" onClick={() => setShowFull(true)}>
            Edit the full instructions
          </Button>
        </div>
      )}
      {(!diff || showFull) && (
        <label className={styles.group}>
          <span className={styles.label}>Instructions</span>
          <textarea
            className={`${styles.instructions} ${grow.text}`}
            value={instructions}
            disabled={sending}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span className={styles.hint}>
            {`Up to ${maxAgentDraftInstructions.toLocaleString('en-US')} characters. Ted adds the commands its powers allow.`}
          </span>
        </label>
      )}
      <fieldset className={styles.group}>
        <legend className={styles.label}>Save to</legend>
        <div className={styles.places}>
          {places.map((place) => (
            <label key={place.value} className={styles.place}>
              <input
                type="radio"
                name={`${request.id}-where`}
                value={place.value}
                checked={where === place.value}
                disabled={sending || (factoryOnly && place.value === 'library')}
                onChange={() => setWhere(place.value)}
              />
              <span>
                {place.label}
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
        <span className={styles.hint}>Only you can save it. Autopilot and the Agent can’t.</span>
        <Button disabled={sending} onClick={() => send({ action: 'dismiss' })}>
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
          {current ? 'Save change' : 'Create'}
        </Button>
      </div>
    </section>
  )
}
