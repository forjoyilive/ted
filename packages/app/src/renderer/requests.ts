import type { Comment, CommentKind, Task } from '@ted/protocol'
import { useEffect, useState } from 'react'

export const kindLabels: Record<CommentKind, string> = {
  note: 'Note',
  question: 'Question',
  round: 'Clarify round',
  review: 'Design review',
  signoff: 'Sign-off',
  permission: 'Permission',
  proposal: 'Proposal',
}

export function requestLabel(request: Comment): string {
  return request.failed ? 'FAILED' : kindLabels[request.kind]
}

export function headline(request: Comment): string {
  return request.title ?? firstLine(request.body)
}

export function summary(request: Comment): string | undefined {
  return request.title === undefined ? restAfterFirstLine(request.body) : request.body
}

export function poster(request: Comment, task: Task | undefined): string {
  const { author } = request
  if (author.kind === 'ted') return 'TED'
  if (author.kind === 'human') return 'you'
  return task?.leadRunId === author.runId ? 'the Task Lead' : 'a sub-agent'
}

export function age(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function ago(iso: string, now: number): string {
  const short = age(iso, now)
  return short === 'now' ? 'just now' : `${short} ago`
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

export function clockTime(iso: string): string {
  return clock.format(new Date(iso))
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function briefSections(text: string): { heading: string; body: string }[] {
  const sections: { heading: string; lines: string[] }[] = []
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.trim())?.[1]
    if (heading) sections.push({ heading, lines: [] })
    else if (sections.length === 0) sections.push({ heading: '', lines: [line] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections
    .map(({ heading, lines }) => ({ heading, body: lines.join('\n').trim() }))
    .filter(({ heading, body }) => heading !== '' || body !== '')
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function restAfterFirstLine(text: string): string | undefined {
  const lines = text.trim().split('\n')
  const rest = lines.slice(1).join('\n').trim()
  return rest === '' ? undefined : rest
}
