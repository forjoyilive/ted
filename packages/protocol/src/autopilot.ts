import { RequestValidationError as HttpError } from './validation.ts'

export type AutopilotChoice = 'inherit' | 'on' | 'off'

export interface TaskAutopilot {
  choice: AutopilotChoice
  enabled: boolean
}

export interface SetTaskAutopilotRequest {
  choice: AutopilotChoice
}

export function parseSetTaskAutopilotRequest(body: unknown): SetTaskAutopilotRequest {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('choice' in body) ||
    (body.choice !== 'inherit' && body.choice !== 'on' && body.choice !== 'off')
  ) {
    throw new HttpError(400, 'choice must be inherit, on or off')
  }
  return { choice: body.choice }
}

export function autopilotEnabled(choice: AutopilotChoice, global: boolean): boolean {
  return choice === 'on' || (choice === 'inherit' && global)
}
