import { expect, test } from 'vitest'
import { RequestValidationError } from '../src/validation.ts'

export type AllFields<T> = T extends object ? { [K in keyof T]-?: T[K] } : T

export function roundTrip<T>(
  parser: (value: unknown) => T,
  body: NoInfer<AllFields<T>>,
  expected: NoInfer<T> = body,
): void {
  test(`${parser.name} keeps every field`, () => {
    expect(parser(structuredClone(body))).toEqual(expected)
  })
}

export function rejects(parser: (value: unknown) => unknown, body: unknown, message: string): void {
  test(`${parser.name} rejects ${message}`, () => {
    expect(() => parser(body)).toThrow(message)
    expect(() => parser(body)).toThrow(RequestValidationError)
  })
}

export function variant<T>(parser: (value: unknown) => T, body: T): void {
  test(`${parser.name} keeps variant ${JSON.stringify(body)}`, () => {
    expect(parser(structuredClone(body))).toEqual(body)
  })
}

type Keys<T> = T extends unknown ? keyof T : never

export function variants<T, V extends NoInfer<T>[]>(
  parser: (value: unknown) => T,
  bodies: V & Record<Exclude<keyof T, Keys<V[number]>>, never>,
): void {
  for (const body of bodies) variant(parser, body)
}
