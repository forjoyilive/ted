import type { ChatRequest } from '@ted/protocol'
import {
  localFolderCardAction,
  localFolderCardText,
  repoShortName,
} from '@ted/protocol/local-folder'
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
  const local = ask.localFolder
  const action = local ? localFolderCardAction(local, ask.folder).kind : 'run'
  const status = local && localFolderCardText(local, ask.folder, repoShortName(ask.repo))
  const runLabel = action === 'update' ? 'Update and run' : action === 'hold' ? 'Run anyway' : 'Run'
  const branch = local?.check.branch

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
        {ask.allowedButHeld
          ? 'You allowed this command always, but Ted asks because the folder is out of date. '
          : ask.allowedBefore !== undefined
            ? 'The command changed since you allowed it, so Ted asks again. '
            : ask.allowedFolder !== undefined
              ? 'The folder changed since you allowed this command, so Ted asks again. '
              : ''}
        This command runs on your Mac with your login environment. It can push, publish and use your
        keychain. It runs only if you click {runLabel}.
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
          {`The local folder set for ${ask.repo}${branch !== undefined ? `, on ${branch}` : ''}.`}
          {ask.allowedFolder !== undefined && ` You allowed it in ${ask.allowedFolder}.`}
        </span>
        {status && (
          <p
            className={`${styles.status} ${styles[status.tone] ?? ''}`}
            data-local-folder={status.tone}
          >
            {status.text}
            {status.detail !== undefined && (
              <span className={styles.detail} data-git-said>{`Git said: ${status.detail}`}</span>
            )}
            {status.fix !== undefined && <span className={styles.fix}>{status.fix}</span>}
          </p>
        )}
      </div>
      {!ask.allowedButHeld && (
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
              {`${agentName} runs ${ask.command} in any chat of this Factory without asking${ask.argument !== undefined ? ', with any plain argument' : ''}. Ted asks again if the command or the folder changes, or when the folder is out of date and Ted can’t update it. Remove it from ${agentName}’s settings.`}
            </span>
          </span>
        </label>
      )}
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
          {runLabel}
        </Button>
      </div>
    </section>
  )
}
