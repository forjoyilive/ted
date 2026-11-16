export type Untyped = unknown

export type Json = null | boolean | number | string | JsonArray | JsonObject
export type JsonArray = readonly Json[]
export type JsonObject = { readonly [key: string]: Json | undefined }

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isArray(value: unknown): value is JsonArray {
  return Array.isArray(value)
}

export function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return values.some((allowed) => allowed === value)
}

export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export class ParseError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.field = field
  }
}

export type Fail = (message: string, field: string) => never

export interface Reader {
  object(value: Untyped, name: string, message?: string): JsonObject
  string(object: JsonObject, field: string, message?: string): string
  number(object: JsonObject, field: string, message?: string): number
  integer(object: JsonObject, field: string, message?: string): number
  boolean(object: JsonObject, field: string, message?: string): boolean
  list(object: JsonObject, field: string, message?: string): JsonArray
  oneOf<const T extends string>(
    object: JsonObject,
    field: string,
    values: readonly T[],
    message?: string,
  ): T
  optional<T>(
    object: JsonObject,
    field: string,
    read: (object: JsonObject, field: string) => T,
  ): T | undefined
}

function throwParseError(message: string, field: string): never {
  throw new ParseError(field, message)
}

export function reader(fail: Fail = throwParseError): Reader {
  function check<T>(
    value: unknown,
    is: (value: unknown) => value is T,
    field: string,
    message: string,
  ): T {
    return is(value) ? value : fail(message, field)
  }
  return {
    object: (value, name, message = `${name} must be an object`) =>
      check(value, isObject, name, message),
    string: (object, field, message = `${field} must be text`) =>
      check(object[field], isString, field, message),
    number: (object, field, message = `${field} must be a number`) =>
      check(object[field], isNumber, field, message),
    integer: (object, field, message = `${field} must be a whole number`) =>
      check(object[field], isInteger, field, message),
    boolean: (object, field, message = `${field} must be true or false`) =>
      check(object[field], isBoolean, field, message),
    list: (object, field, message = `${field} must be a list`) =>
      check(object[field], isArray, field, message),
    oneOf: (object, field, values, message = `${field} must be one of ${values.join(', ')}`) => {
      const value = object[field]
      return isOneOf(value, values) ? value : fail(message, field)
    },
    optional: (object, field, read) =>
      object[field] === undefined ? undefined : read(object, field),
  }
}
