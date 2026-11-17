import type { ChatRequest } from '@ted/protocol'
import { useState } from 'react'
import { Button } from '../components/Button.tsx'
import { dotted } from '../plans.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import draft from './AgentDraftCard.module.css'
import styles from './OutsideCommandCard.module.css'
import chat from './PlanChat.module.css'

export function OutsideCommandCard({
  chatId,
  request,
  agentName,
}: {
  chatId: string
  request: ChatRequest
  agentName: string
}) {
  const now = useNow()
  const [always, setAlways] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const ask = request.outsideCommand
  if (!ask) return null
  const shown = ask.command
    .split(' ')
    .map((word) => (/^<[a-z][a-z0-9-]*>$/.test(word) ? (ask.argument ?? word) : word))
    .join(' ')

  async function send(run: boolean) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerOutsideCommand(chatId, request.id, { run, always: run && always })
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      className={`${chat.request} ${styles.card}`}
      aria-label={`Outside command from ${agentName}`}
      data-request={request.id}
      data-outside-command={ask.name}
    >
      <div className={chat.cardHead}>
        <span className={chat.pendingKind}>Outside command</span>
        <span>{`· ${dotted(`from ${agentName}`, ago(request.createdAt, now))}`}</span>
      </div>
      <p className={chat.cardTitle}>
        Run <code className={styles.name}>{ask.name}</code> outside the sandbox?
      </p>
      <p className={draft.note}>
        {ask.allowedBefore !== undefined
          ? 'The command changed since you allowed it, so Ted asks again. '
          : ask.allowedFolder !== undefined
            ? 'The folder changed since you allowed this command, so Ted asks again. '
            : ''}
        This command runs on your Mac with your login environment. It can push, publish and use your
        keychain. It runs only if you click Run.
      </p>
      <div className={draft.group}>
        <span className={draft.label}>Command</span>
        <code className={styles.command} data-command>
          {shown}
        </code>
        <span className={draft.hint}>
          {`Listed in ${agentName}’s settings as ${ask.name}: ${ask.command}.`}
          {ask.argument !== undefined &&
            ` The argument ${ask.argument} comes from the agent and is passed as one separate word.`}
        </span>
        {ask.allowedBefore !== undefined && (
          <span className={draft.hint}>{`You allowed: ${ask.allowedBefore}`}</span>
        )}
      </div>
      <div className={draft.group}>
        <span className={draft.label}>Folder</span>
        <code className={styles.folder}>{ask.folder}</code>
        <span className={draft.hint}>
          {ask.allowedFolder !== undefined
            ? `The local folder set for ${ask.repo}. You allowed it in ${ask.allowedFolder}.`
            : `The local folder set for ${ask.repo}.`}
        </span>
      </div>
      <label className={draft.power}>
        <input
          type="checkbox"
          checked={always}
          disabled={sending}
          onChange={(event) => setAlways(event.target.checked)}
        />
        <span>
          <span className={draft.powerName}>Always allow this command</span>
          <span className={draft.hint}>
            {`${agentName} runs ${ask.command} in any chat of this Factory without asking${ask.argument !== undefined ? ', with any plain argument' : ''}. Ted asks again if the command or the folder changes. Remove it from ${agentName}’s settings.`}
          </span>
        </span>
      </label>
      {error !== undefined && (
        <p className={chat.error} role="alert">
          {error}
        </p>
      )}
      <div className={draft.footer}>
        <span className={draft.hint}>Only you can run it. Autopilot and the Agent can’t.</span>
        <Button disabled={sending} onClick={() => send(false)}>
          Don’t run
        </Button>
        <Button variant="primary" disabled={sending} pending={sending} onClick={() => send(true)}>
          Run
        </Button>
      </div>
    </section>
  )
}
