import { reader, type Untyped } from './parse.ts'

export const maxProblemDescription = 10_000
export const maxReportEmail = 254

export interface ProblemReportRequest {
  description: string
  email: string
  includeLog: boolean
}

export type ProblemReportResult = { sent: true; eventId: string } | { sent: false; error: string }

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isReportEmail(email: string): boolean {
  return email === '' || (email.length <= maxReportEmail && emailShape.test(email))
}

export function parseProblemReportRequest(body: Untyped): ProblemReportRequest {
  const read = reader()
  const input = read.object(body, 'request')
  const description = read.string(input, 'description').trim()
  const email = read.string(input, 'email').trim()
  if (description === '') throw new Error('Write what happened first.')
  if (description.length > maxProblemDescription) {
    throw new Error(
      `Keep what happened under ${maxProblemDescription.toLocaleString('en')} characters.`,
    )
  }
  if (!isReportEmail(email)) throw new Error('Enter an email address, or leave it empty.')
  return { description, email, includeLog: read.boolean(input, 'includeLog') }
}
