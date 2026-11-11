import {
  type BrowserPollRequest,
  type BrowserReplyRequest,
  type BrowserRequest,
  browserActions,
} from './browser.ts'
import { bodyObject, RequestValidationError, text } from './validation.ts'

function shortText(value: unknown, name: string, limit: number): string {
  const result = text(value, name)
  if (result.length > limit) throw new RequestValidationError(400, `${name} is too long`)
  return result
}

export function parseBrowserRequest(value: unknown): BrowserRequest {
  const body = bodyObject(value)
  const action = text(body.action, 'action')
  if (!browserActions.includes(action as BrowserRequest['action'])) {
    throw new RequestValidationError(400, 'Unknown browser action')
  }
  const app = body.app === undefined ? undefined : bodyObject(body.app, 'app')
  const request: BrowserRequest = {
    action: action as BrowserRequest['action'],
    ...(app && {
      app: {
        name: shortText(app.name, 'app.name', 200),
        ...(app.repo !== undefined && { repo: shortText(app.repo, 'app.repo', 200) }),
      },
    }),
    ...(body.value !== undefined && { value: shortText(body.value, 'value', 16_000) }),
    ...(body.ref !== undefined && { ref: shortText(body.ref, 'ref', 100) }),
  }
  if (action === 'open' && !request.app) throw new RequestValidationError(400, 'Name the web App')
  if (['click', 'fill'].includes(action) && !request.ref)
    throw new RequestValidationError(400, 'Name an element reference from snapshot')
  if (['fill', 'press', 'navigate'].includes(action) && request.value === undefined)
    throw new RequestValidationError(400, 'Give a value')
  return request
}

export function parseBrowserPollRequest(value: unknown): BrowserPollRequest {
  const body = bodyObject(value)
  return { session: shortText(body.session, 'session', 100) }
}

export function parseBrowserReplyRequest(value: unknown): BrowserReplyRequest {
  const body = bodyObject(value)
  const result = body.result === undefined ? undefined : bodyObject(body.result, 'result')
  return {
    ...parseBrowserPollRequest(body),
    ...(body.canceled === true && { canceled: true }),
    ...(body.error !== undefined && { error: shortText(body.error, 'error', 1000) }),
    ...(result && {
      result: {
        ...(result.url !== undefined && { url: shortText(result.url, 'url', 4000) }),
        ...(result.text !== undefined && { text: shortText(result.text, 'text', 64_000) }),
      },
    }),
  }
}
