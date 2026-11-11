import type { CheckResult, CheckRun } from './checks.ts'

export const failureChoices = {
  accepted: 'Accept this failure',
  fixed: 'Fixed',
  'no-longer-applicable': 'No longer applicable',
} as const

export type FailureSource =
  | { kind: 'factory-check' | 'post-rebase-check'; checkRunId: string; position: number }
  | { kind: 'finding'; runId: string; finding: string }
  | { kind: 'github-ci'; repo: string; number: number; head: string; attempt: string }

export interface FailureContext {
  id: string
  taskId: string
  version: 1 | 2
  fingerprint: string
  capturedAt: string
  repos: { repo: string; head: string; base: string; tree: string; mergeBase: string }[]
  checks: string
  ci?: string
  ciFailures?: string[]
}

export interface RecordFailureRequest {
  source: FailureSource
  evidence: string
  contextId?: string
}

export interface AssessFailureRequest {
  assessment: 'regression' | 'unrelated' | 'uncertain'
  recommendation: string
}

export interface FailureAssessment extends AssessFailureRequest {
  id: string
  runId: string
  contextId?: string
  evidenceCount?: number
  at: string
}

export interface ResolveFailureRequest {
  requestId: string
  resolution: 'accepted' | 'fixed' | 'no-longer-applicable'
  reason?: string
}

export interface FailureResolution extends ResolveFailureRequest {
  at: string
  contextId?: string
  assessmentId: string
}

export interface FailureDecision {
  commentId: string
  assessmentId: string
  contextId?: string
}

export interface FailureCase {
  id: string
  taskId: string
  source: FailureSource
  recordedBy: string
  provenance: 'stored-check' | 'task-lead-reported'
  evidence: string
  originalCheck?: CheckResult
  contextId?: string
  createdAt: string
  assessments: FailureAssessment[]
  additions: { evidence: string; runId: string; at: string; contextId?: string }[]
  decisions: FailureDecision[]
  resolutions: FailureResolution[]
  invalidations: { requestId: string; reason: string; at: string }[]
}

export interface ValidationObligations {
  checkRuns: Pick<CheckRun, 'id' | 'trigger' | 'stage' | 'outcome' | 'startedAt' | 'finishedAt'>[]
  satisfied: boolean
  cases: {
    id: string
    disposition: 'unresolved' | 'accepted' | 'fixed' | 'no-longer-applicable' | 'invalidated'
    context: 'current' | 'unknown' | 'changed' | 'historical'
  }[]
  blockers: string[]
}

export interface AddFailureEvidenceRequest {
  evidence: string
  contextId?: string
}
