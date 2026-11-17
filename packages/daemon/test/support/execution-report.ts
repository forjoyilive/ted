import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { arch, homedir, hostname, platform, release } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { workingChanges } from '../../src/git.ts'
import { redactSecrets } from '../../src/redact.ts'
import { ExecutionDiagnostics } from './execution-diagnostics.ts'
import type { EvidenceKind } from './execution-manifest.ts'

const exec = promisify(execFile)
const within = (parent: string, target: string) =>
  target === parent || target.startsWith(`${parent}${path.sep}`)
export const evidenceBytes = 256 * 1024

export interface Candidate {
  revision: string
  contentHash: string
  dirtyPatchIdentity: string | null
}
export async function candidateIdentity(root: string): Promise<Candidate> {
  const changes = await workingChanges(root, 'HEAD')
  return {
    revision: changes.head,
    contentHash: changes.tree,
    dirtyPatchIdentity: changes.files.some((f) => f.uncommitted)
      ? createHash('sha256').update(`${changes.head}\0${changes.tree}`).digest('hex')
      : null,
  }
}

export async function prerequisiteVersions() {
  const version = async (command: string) =>
    (await exec(command, ['--version'], { timeout: 10_000, maxBuffer: 4096 })).stdout.trim()
  return { node: process.version, pnpm: await version('pnpm'), git: await version('git') }
}

export async function reportDirectory(requested: string, checkout: string, scratch?: string) {
  if (!path.isAbsolute(requested)) throw new Error('--report-dir must be absolute')
  const absolute = path.resolve(requested)
  if (absolute.split(path.sep).some((part) => /^ted-(execution|validation)-/.test(part)))
    throw new Error('report directory must be outside fixture scratch folders')
  const forbidden = [
    await realpath(checkout),
    ...(scratch ? [await realpath(scratch)] : []),
    ...(await Promise.all(
      [
        path.join(homedir(), '.ted'),
        path.join(homedir(), '.ted-dev'),
        ...(process.env.TED_HOME ? [path.resolve(process.env.TED_HOME)] : []),
      ].map((home) =>
        realpath(home).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return home
        }),
      ),
    )),
  ]
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stat?.isSymbolicLink()) throw new Error('report directory must not contain symlinks')
    if (stat && !stat.isDirectory()) throw new Error('report directory must be a plain directory')
  }
  if (forbidden.some((p) => within(p, absolute)))
    throw new Error('report directory must be outside checkout, scratch and personal Ted homes')
  await mkdir(absolute, { recursive: true, mode: 0o700 })
  const canonical = await realpath(absolute)
  if (canonical !== absolute || forbidden.some((p) => within(p, canonical)))
    throw new Error('report directory changed while opening')
  return mkdtemp(path.join(canonical, 'validation-'))
}

export interface ScenarioResult {
  id: string
  evidence: EvidenceKind
  scope: string
  command: string[]
  prerequisites: string[]
  expected: string[]
  observed: unknown[]
  result: 'pass' | 'fail' | 'skipped'
  reason?: string
  durationMs: number
  evidencePaths: string[]
}
export interface ValidationReport {
  version: 1
  manifestVersion: number
  candidate: Candidate | null
  prerequisites: Record<string, string>
  machine: { id: string; platform: string; arch: string; release: string }
  startedAt: string
  durationMs: number
  result: 'pass' | 'fail' | 'skipped'
  scenarios: ScenarioResult[]
  errors: string[]
  replay: { command: string[]; candidate: Candidate | null; instruction: string }
}
export const machineIdentity = () => ({
  id: hostname(),
  platform: platform(),
  arch: arch(),
  release: release(),
})

export function boundedEvidence(text: string): { text: string; truncated: boolean } {
  const safe = redactSecrets(text)
  const bytes = Buffer.from(safe)
  return {
    text: bytes.subarray(0, evidenceBytes).toString('utf8'),
    truncated: bytes.length > evidenceBytes,
  }
}

export async function saveEvidence(directory: string, name: string, text: string) {
  if (!/^[a-z0-9-]+\.(txt|json)$/.test(name)) throw new Error('invalid evidence name')
  const evidence = boundedEvidence(text)
  await writeFile(
    path.join(directory, name),
    evidence.text + (evidence.truncated ? '\n[truncated]\n' : ''),
    { mode: 0o600 },
  )
  return name
}

export async function readTestReport(file: string) {
  if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('test report exceeds limit')
  const report: unknown = JSON.parse(await readFile(file, 'utf8'))
  const details = new ExecutionDiagnostics()
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object'
  if (record(report) && Array.isArray(report.testResults)) {
    for (const suite of report.testResults) {
      if (!record(suite)) continue
      if (suite.status === 'failed' && typeof suite.name === 'string')
        details.push(`File: ${suite.name}\n`)
      if (typeof suite.message === 'string' && suite.message) details.push(`${suite.message}\n`)
      if (!Array.isArray(suite.assertionResults)) continue
      for (const assertion of suite.assertionResults) {
        if (!record(assertion) || assertion.status !== 'failed') continue
        if (typeof assertion.fullName === 'string') details.push(`Test: ${assertion.fullName}\n`)
        if (Array.isArray(assertion.failureMessages))
          for (const message of assertion.failureMessages)
            if (typeof message === 'string') details.push(`${message}\n`)
      }
    }
  }
  return { report, failureDetails: details.text || 'No assertion failure details in test report.' }
}

export async function publishReport(directory: string, report: ValidationReport) {
  const summary = `${[
    `Validation: ${report.result}`,
    `Candidate: ${report.candidate?.revision ?? 'unavailable'}; content ${report.candidate?.contentHash ?? 'unavailable'}; dirty ${report.candidate?.dirtyPatchIdentity ?? 'none'}`,
    ...report.scenarios.map(
      (s) =>
        `- ${s.id}: ${s.result} · ${s.evidence} · ${s.scope}${s.reason ? ` · ${s.reason}` : ''}`,
    ),
    ...report.errors.map((e) => `Error: ${e}`),
    `Replay: ${JSON.stringify(report.replay.command)}`,
    report.replay.instruction,
  ].join('\n')}\n`
  for (const [name, content] of [
    ['report.json', JSON.stringify(report, null, 2)],
    ['summary.md', summary],
  ]) {
    const temp = path.join(directory, `${name}.tmp`)
    await writeFile(temp, redactSecrets(content ?? ''), { mode: 0o600 })
    await rename(temp, path.join(directory, name ?? 'invalid'))
  }
}

export async function readObservations(
  file: string,
): Promise<{ invariant: string; observed: unknown }[]> {
  if ((await stat(file)).size > 1024 * 1024) throw new Error('observations exceed limit')
  const text = await readFile(file, 'utf8')
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('observations exceed limit')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (
        !value ||
        typeof value !== 'object' ||
        !('invariant' in value) ||
        typeof value.invariant !== 'string' ||
        !('observed' in value)
      )
        throw new Error('invalid invariant observation')
      return { invariant: value.invariant, observed: value.observed }
    })
}
