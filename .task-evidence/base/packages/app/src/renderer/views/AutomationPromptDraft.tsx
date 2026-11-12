import type { AutomationPromptDraft as PromptDraft, TaskLead } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { AntigravityChatWarning } from '../components/AntigravityChatWarning.tsx'
import { Button } from '../components/Button.tsx'
import { ChatBody } from '../components/RunChat.tsx'
import { useConnection } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AutomationDialog.module.css'

export function AutomationPromptDraft({
  factory,
  name,
  prompt,
  lead,
  onApply,
  onBusy,
}: {
  factory: string
  name: string
  prompt: string
  lead: TaskLead | undefined
  onApply: (prompt: string) => void
  onBusy: (busy: boolean) => void
}) {
  const id = useId()
  const { epoch } = useConnection()
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState('')
  const [job, setJob] = useState<PromptDraft>()
  const [suggestion, setSuggestion] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [applied, setApplied] = useState(false)
  const generation = useRef(0)
  const remote = useRef<string | undefined>(undefined)
  const inFlight = useRef(false)
  const active = job?.state === 'queued' || job?.state === 'working'
  const busy = pending || active

  useEffect(() => {
    onBusy(busy)
  }, [busy, onBusy])
  useEffect(
    () => () => {
      generation.current++
      if (remote.current)
        void ted.cancelAutomationPromptDraft(remote.current).catch(() => undefined)
      onBusy(false)
    },
    [onBusy],
  )

  const draftId = job?.id
  const attempt = generation.current
  useEffect(() => {
    void epoch
    if (!draftId || !active) return
    const token = attempt
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await ted.getAutomationPromptDraft(draftId)
        if (!current || token !== generation.current) return
        setJob(result)
        setError(undefined)
        if (result.state === 'ready') setSuggestion(result.prompt ?? '')
        if (result.state !== 'queued' && result.state !== 'working') return
      } catch (failure) {
        if (!current || token !== generation.current) return
        setError(`Couldn’t check the draft: ${readableError(failure)}`)
      }
      if (current) timer = setTimeout(() => void poll(), 750)
    }
    void poll()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [draftId, active, epoch, attempt])

  async function generate() {
    if (inFlight.current || busy || !request.trim()) return
    inFlight.current = true
    const token = ++generation.current
    setPending(true)
    onBusy(true)
    setJob(undefined)
    setSuggestion('')
    setApplied(false)
    setError(undefined)
    try {
      const result = await ted.draftAutomationPrompt({ factory, name, prompt, request, ...lead })
      if (token !== generation.current) {
        void ted.cancelAutomationPromptDraft(result.id).catch(() => undefined)
        return
      }
      remote.current = result.id
      setJob(result)
    } catch (failure) {
      if (token === generation.current) setError(readableError(failure))
    } finally {
      if (token === generation.current) {
        inFlight.current = false
        setPending(false)
      }
    }
  }

  async function cancel() {
    const token = ++generation.current
    setPending(true)
    setError(undefined)
    try {
      if (remote.current) await ted.cancelAutomationPromptDraft(remote.current)
      if (token !== generation.current) return
      remote.current = undefined
      setJob(undefined)
    } catch (failure) {
      if (token === generation.current) setError(readableError(failure))
    } finally {
      if (token === generation.current) {
        setPending(false)
        inFlight.current = false
      }
    }
  }

  const status = pending
    ? 'Starting…'
    : job?.paused
      ? `Agent paused · ${job.paused}`
      : job?.state === 'queued'
        ? 'Waiting for a free Run slot…'
        : job?.state === 'working'
          ? 'Drafting…'
          : ''
  return (
    <>
      <div className={styles.draftActions}>
        <Button
          variant="quiet"
          size="small"
          disabled={busy}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide drafting' : 'Draft with AI'}
        </Button>
        {applied && (
          <span className={styles.note} role="status">
            Draft applied. Review the Prompt before saving.
          </span>
        )}
      </div>
      {open && (
        <section className={styles.draftBox} aria-label="Draft with AI">
          {lead && <AntigravityChatWarning agent={lead.agent} />}
          <label className={styles.label} htmlFor={`${id}-request`}>
            What should this Automation do?
          </label>
          <textarea
            id={`${id}-request`}
            className={styles.input}
            rows={3}
            disabled={busy}
            value={request}
            placeholder="Find unassigned bugs in Linear and create Tasks in Backlog."
            onChange={(event) => setRequest(event.target.value)}
          />
          <span className={styles.note}>
            Uses the agent selected below. Includes your current Prompt when drafting a revision.
          </span>
          <div className={styles.draftActions}>
            <Button
              size="small"
              disabled={busy || !request.trim() || !factory}
              onClick={() => void generate()}
            >
              {job?.state === 'failed' || error
                ? 'Try again'
                : job?.state === 'ready'
                  ? 'Generate again'
                  : 'Generate draft'}
            </Button>
            {busy && (
              <Button size="small" onClick={() => void cancel()}>
                Cancel drafting
              </Button>
            )}
            <span className={styles.note} role="status">
              {status}
            </span>
          </div>
          {(error || job?.error) && (
            <p className={styles.error} role="alert">
              {error || job?.error} Your Prompt is unchanged.
            </p>
          )}
          {job?.chat && (
            <ChatBody
              chat={job.chat}
              onStopTask={undefined}
              options={{ inspect: true, bar: false }}
            />
          )}
          {job?.state === 'ready' && (
            <div className={styles.draftResult}>
              <label className={styles.label} htmlFor={`${id}-suggestion`}>
                Suggested Prompt
              </label>
              <textarea
                id={`${id}-suggestion`}
                className={styles.prompt}
                rows={9}
                value={suggestion}
                onChange={(event) => setSuggestion(event.target.value)}
              />
              <div className={styles.draftActions}>
                <Button
                  variant="primary"
                  size="small"
                  disabled={busy || !suggestion.trim()}
                  onClick={() => {
                    onApply(suggestion)
                    setJob(undefined)
                    setSuggestion('')
                    setApplied(true)
                  }}
                >
                  Use draft
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setJob(undefined)
                    setSuggestion('')
                  }}
                >
                  Discard draft
                </Button>
              </div>
              <span className={styles.note}>
                Use draft replaces the Prompt above. Review it before saving.
              </span>
            </div>
          )}
        </section>
      )}
    </>
  )
}
