import {
  type DeviceKey,
  type DevicePoint,
  type DeviceRequest,
  deviceActions,
  deviceKeys,
  deviceLimits,
} from './device.ts'
import { bodyObject, RequestValidationError, text } from './validation.ts'

function shortText(value: unknown, name: string, limit: number): string {
  const result = text(value, name)
  if (result.length > limit) throw new RequestValidationError(400, `${name} is too long`)
  return result
}

function point(value: unknown, name: string): DevicePoint {
  const body = bodyObject(value, name)
  const coordinate = (given: unknown, axis: string) => {
    if (
      typeof given !== 'number' ||
      !Number.isInteger(given) ||
      given < 0 ||
      given > deviceLimits.maxCoordinate
    )
      throw new RequestValidationError(
        400,
        `${name}.${axis} must be a whole number from 0 to ${deviceLimits.maxCoordinate}`,
      )
    return given
  }
  return { x: coordinate(body.x, 'x'), y: coordinate(body.y, 'y') }
}

export function parseDeviceRequest(value: unknown): DeviceRequest {
  const body = bodyObject(value)
  const action = text(body.action, 'action')
  if (!deviceActions.includes(action as DeviceRequest['action']))
    throw new RequestValidationError(400, 'Unknown App action')
  const app = bodyObject(body.app, 'app')
  const name = shortText(app.name, 'app.name', 200).trim()
  if (name === '') throw new RequestValidationError(400, 'Name the App')
  const request: DeviceRequest = {
    action: action as DeviceRequest['action'],
    app: {
      name,
      ...(app.repo !== undefined && { repo: shortText(app.repo, 'app.repo', 200) }),
    },
  }
  if (body.ref !== undefined) request.ref = shortText(body.ref, 'ref', 20)
  if (body.point !== undefined) request.point = point(body.point, 'point')
  if (body.to !== undefined) request.to = point(body.to, 'to')
  if (body.text !== undefined) request.text = shortText(body.text, 'text', deviceLimits.maxText)
  if (body.key !== undefined) {
    const key = text(body.key, 'key')
    if (!deviceKeys.includes(key as DeviceKey))
      throw new RequestValidationError(400, `Use one of these keys: ${deviceKeys.join(', ')}`)
    request.key = key as DeviceKey
  }
  if (body.appearance !== undefined) {
    if (body.appearance !== 'light' && body.appearance !== 'dark')
      throw new RequestValidationError(400, 'Use light or dark')
    request.appearance = body.appearance
  }
  if (body.size !== undefined) {
    request.size = shortText(body.size, 'size', deviceLimits.maxSize).trim()
    if (request.size === '') throw new RequestValidationError(400, 'Give a size')
  }
  if (body.density !== undefined) {
    const { density } = body
    if (
      typeof density !== 'number' ||
      !Number.isInteger(density) ||
      density < deviceLimits.minDensity ||
      density > deviceLimits.maxDensity
    )
      throw new RequestValidationError(
        400,
        `density must be a whole number from ${deviceLimits.minDensity} to ${deviceLimits.maxDensity}`,
      )
    request.density = density
  }
  if (action === 'tap' && (request.ref === undefined) === (request.point === undefined))
    throw new RequestValidationError(400, 'Tap an element reference from screen, or a point x,y')
  if (action === 'swipe' && (request.point === undefined || request.to === undefined))
    throw new RequestValidationError(400, 'Give the swipe’s start and end points')
  if (action === 'type' && (request.text === undefined || request.text === ''))
    throw new RequestValidationError(400, 'Give the text to type')
  if (action === 'key' && request.key === undefined)
    throw new RequestValidationError(400, `Give a key: ${deviceKeys.join(', ')}`)
  if (action === 'appearance' && request.appearance === undefined)
    throw new RequestValidationError(400, 'Use light or dark')
  if (action === 'size' && request.size === undefined)
    throw new RequestValidationError(400, 'Give a size, or reset')
  if (request.density !== undefined && action !== 'size')
    throw new RequestValidationError(400, 'density goes with size')
  return request
}
