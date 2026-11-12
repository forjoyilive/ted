import type { AnswerRequest } from '@ted/protocol'
import { failureChoices } from '@ted/protocol/failures'
import { useEffect, useId, useRef, useState } from 'react'
import { sendOnEnter } from '../composer-keys.ts'
import { readableError } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './RequestCard.module.css'

type Form = { kind: 'reason'; choice: string } | { kind: 'message' }

const reasonLabels: Record<string, string> = {
  [failureChoices.fixed]: 'Why is this failure fixed?',
  [failureChoices['no-longer-applicable']]: 'Why does this failure no longer apply?',
}

export function FailureActions({
  choices,
  reasonChoices,
  readOnly,
  answer,
}: {
  choices: readonly string[]
  reasonChoices: readonly string[]
  readOnly: boolean
  answer: (answer: AnswerRequest) => Promise<unknown>
}) {
  const [form, setForm] = useState<Form>()
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const box = useRef<HTMLTextAreaElement>(null)
  const boxId = useId()
  const formKey = form?.kind === 'reason' ? form.choice : form?.kind

  useEffect(() => {
    if (formKey !== undefined) box.current?.focus()
  }, [formKey])

  async function submit(request: AnswerRequest, done: () => void) {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      await answer(request)
      done()
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  function show(next: Form | undefined) {
    setError(undefined)
    setForm(next)
  }

  if (form && !readOnly) {
    const reason = form.kind === 'reason'
    const text = reason ? (reasons[form.choice] ?? '') : message
    const ready = text.trim() !== ''
    const confirm = () =>
      void submit(
        reason ? { action: 'answer', choice: form.choice, text } : { action: 'answer', text },
        () => {
          if (reason) setReasons({})
          else setMessage('')
          setForm(undefined)
        },
      )
    return (
      <div className={styles.failureForm}>
        <div className={styles.formHead}>
          <label className={styles.formLabel} htmlFor={boxId}>
            {reason
              ? (reasonLabels[form.choice] ?? `Reason for ${form.choice}`)
              : 'Message to the Task Lead'}
          </label>
          <p className={styles.formHint}>
            {reason
              ? 'A reason is required. Confirming closes this failure.'
              : 'Sending a message leaves this failure open. Choose a decision to resolve it.'}
          </p>
        </div>
        <textarea
          ref={box}
          id={boxId}
          className={styles.box}
          data-answer-box
          placeholder={reason ? 'Explain what changed…' : 'Ask a question or add context…'}
          value={text}
          onChange={(event) => {
            const { value } = event.target
            if (reason) setReasons({ ...reasons, [form.choice]: value })
            else setMessage(value)
          }}
          onKeyDown={sendOnEnter(confirm)}
        />
        {error !== undefined && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.buttons}>
          <span className={styles.caption}>
            {`Enter to ${reason ? 'confirm' : 'send'} · Shift+Enter for a new line`}
          </span>
          <Button disabled={sending} onClick={() => show(undefined)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={sending || !ready} onClick={confirm}>
            {reason ? `Confirm ${form.choice}` : 'Send message'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={styles.choices}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className={styles.choice}
            disabled={sending || readOnly}
            onClick={() =>
              reasonChoices.includes(choice)
                ? show({ kind: 'reason', choice })
                : void submit({ action: 'answer', choice }, () => {})
            }
          >
            {choice}
          </button>
        ))}
      </div>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!readOnly && (
        <div className={styles.messageRow}>
          <button
            type="button"
            className={styles.messageLink}
            data-reply
            disabled={sending}
            onClick={() => show({ kind: 'message' })}
          >
            Send a message to the Task Lead…
          </button>
          <span className={styles.caption}>A message leaves this failure open.</span>
        </div>
      )}
    </>
  )
}
