import type { AgentSummary, Factory, TaskLead } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { agentDescription, agentSources } from '../components/AgentAbout.tsx'
import { agentNames } from '../components/RunIcon.tsx'
import { ted } from '../ted.ts'
import styles from './AgentPicker.module.css'
import views from './views.module.css'

const tones = [
  styles.toneAccent,
  styles.toneTesting,
  styles.toneSuccess,
  styles.toneWaiting,
  styles.toneFailed,
  styles.toneNeutral,
] as const

function toneOf(id: string): string {
  let sum = 0
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) % 9973
  return tones[sum % tones.length] ?? ''
}

function CoordinatorGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 7.5l3 8M16 7.5l-3 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function PlannerGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function AgentIcon({
  agent,
  small = false,
}: {
  agent: Pick<AgentSummary, 'id' | 'name'>
  small?: boolean
}) {
  const size = small ? `${styles.icon} ${styles.small}` : styles.icon
  if (agent.id === 'coordinator') {
    return (
      <span className={`${size} ${styles.toneAccent}`} data-glyph="coordinator">
        <CoordinatorGlyph />
      </span>
    )
  }
  if (agent.id === 'planner') {
    return (
      <span className={`${size} ${styles.toneTesting}`} data-glyph="planner">
        <PlannerGlyph />
      </span>
    )
  }
  return (
    <span className={`${size} ${toneOf(agent.id)}`} aria-hidden="true">
      {agent.name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

export function AgentHeading({
  agent,
  titleClassName,
}: {
  agent: AgentSummary
  titleClassName?: string | undefined
}) {
  return (
    <>
      <AgentIcon agent={agent} small />
      <h1 className={titleClassName}>{agent.name}</h1>
    </>
  )
}

export function AgentDescriptionLine({ agent }: { agent: AgentSummary }) {
  const description = agentDescription(agent)
  if (description === undefined) return null
  return (
    <p className={styles.descriptionLine} title={description}>
      {description}
    </p>
  )
}

function providerLine(agent: AgentSummary, fallback: TaskLead | undefined): string {
  if (agent.agent !== undefined) {
    return [agentNames[agent.agent], agent.model].filter(Boolean).join(' · ')
  }
  return fallback ? [agentNames[fallback.agent], fallback.model].filter(Boolean).join(' · ') : ''
}

export function AgentPicker({
  factory,
  agents,
  onPick,
  onNewAgent,
}: {
  factory: Factory
  agents: readonly AgentSummary[]
  onPick: (agent: AgentSummary) => void
  onNewAgent: () => void
}) {
  const [fallback, setFallback] = useState<TaskLead>()
  useEffect(() => {
    let active = true
    ted.taskDefaults(factory.id).then(
      (defaults) => {
        if (active) setFallback(defaults.planner)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [factory.id])
  return (
    <section className={views.pane} aria-label="New chat">
      <div className={styles.picker}>
        <h1 className={styles.title}>New chat</h1>
        <p className={styles.lead}>Pick who you want to talk to.</p>
        <ul className={styles.grid} aria-label="Agents">
          {agents.map((agent) => {
            const description = agentDescription(agent)
            const provider = providerLine(agent, fallback)
            return (
              <li key={agent.id}>
                <ActionButton
                  type="button"
                  data-nav-item
                  className={styles.card}
                  onClick={() => onPick(agent)}
                >
                  <AgentIcon agent={agent} />
                  <span className={styles.name}>{agent.name}</span>
                  {description !== undefined && (
                    <span className={styles.description}>{description}</span>
                  )}
                  <span className={styles.labels}>
                    <span className={styles.source}>{agentSources[agent.source]}</span>
                    {provider !== '' && <span>{provider}</span>}
                  </span>
                </ActionButton>
              </li>
            )
          })}
          <li>
            <ActionButton
              type="button"
              data-nav-item
              className={`${styles.card} ${styles.newCard}`}
              onClick={onNewAgent}
            >
              <span className={`${styles.icon} ${styles.newIcon}`}>
                <PlusGlyph />
              </span>
              <span className={styles.name}>New Agent</span>
              <span className={styles.description}>
                Start one from a recipe in this Factory’s Agent files.
              </span>
            </ActionButton>
          </li>
        </ul>
      </div>
    </section>
  )
}
