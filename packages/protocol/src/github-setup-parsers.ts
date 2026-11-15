import {
  branchNameProblem,
  type GitHubNameRequest,
  type GitHubSetupPlanRequest,
  type GitHubSetupStep,
  type GitHubSetupStepRequest,
  gitHubDescriptionLimit,
  gitHubNameProblem,
  gitHubSetupSteps,
  isGitHubOwner,
} from './github-setup.ts'
import { bodyObject, RequestValidationError as HttpError } from './validation.ts'

const maxLeaveOut = 50
const maxPathLength = 500

function folder(value: unknown): string {
  if (typeof value !== 'string' || value === '' || !value.startsWith('/')) {
    throw new HttpError(400, 'folder must be an absolute path')
  }
  if (value.length > 4096 || value.includes('\0')) throw new HttpError(400, 'folder is invalid')
  return value
}

function owner(value: unknown): string {
  if (typeof value !== 'string' || !isGitHubOwner(value)) {
    throw new HttpError(400, 'owner must be a GitHub account or organization name')
  }
  return value
}

function repoName(value: unknown): string {
  const name = typeof value === 'string' ? value : ''
  const problem = gitHubNameProblem(name)
  if (problem !== undefined) throw new HttpError(400, `name: ${problem}`)
  return name
}

export function parseGitHubSetupPlanRequest(value: unknown): GitHubSetupPlanRequest {
  return { folder: folder(bodyObject(value).folder) }
}

export function parseGitHubNameRequest(value: unknown): GitHubNameRequest {
  const body = bodyObject(value)
  return { owner: owner(body.owner), name: repoName(body.name) }
}

export function parseGitHubSetupStepRequest(value: unknown): GitHubSetupStepRequest {
  const body = bodyObject(value)
  if (!gitHubSetupSteps.includes(body.step as GitHubSetupStep)) {
    throw new HttpError(400, `step must be one of ${gitHubSetupSteps.join(', ')}`)
  }
  const description = body.description === undefined ? '' : body.description
  if (typeof description !== 'string' || description.length > gitHubDescriptionLimit) {
    throw new HttpError(400, `description is limited to ${gitHubDescriptionLimit} characters`)
  }
  const branch = typeof body.branch === 'string' ? body.branch : ''
  const branchProblem = branchNameProblem(branch)
  if (branchProblem !== undefined) throw new HttpError(400, `branch: ${branchProblem}`)
  const leaveOut = body.leaveOut === undefined ? [] : body.leaveOut
  if (
    !Array.isArray(leaveOut) ||
    leaveOut.length > maxLeaveOut ||
    leaveOut.some(
      (p) =>
        typeof p !== 'string' ||
        p === '' ||
        p.length > maxPathLength ||
        p.includes('\0') ||
        p.includes('\n') ||
        p.includes('\r'),
    )
  ) {
    throw new HttpError(400, 'leaveOut must be a list of paths')
  }
  return {
    folder: folder(body.folder),
    step: body.step as GitHubSetupStep,
    owner: owner(body.owner),
    name: repoName(body.name),
    description: withoutControls(description).trim(),
    branch,
    leaveOut: leaveOut as string[],
  }
}

function withoutControls(value: string): string {
  return [...value].map((c) => (c < ' ' || c === '\u007f' ? ' ' : c)).join('')
}
