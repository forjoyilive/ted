import { DaemonUnreachableError } from '@ted/protocol'
import { expect, test } from 'vitest'
import { handleUncaught } from '../src/uncaught.ts'

function errno(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

function outcome(error: unknown, hidden = false) {
  const logged: unknown[] = []
  const shown: string[] = []
  handleUncaught(error, {
    hidden,
    log: (...args) => logged.push(...args),
    show: (title) => shown.push(title),
  })
  return { logged: logged.includes(error), shown }
}

test('socket errors from a daemon that went away are logged, never shown', () => {
  for (const error of [
    errno('EINVAL', 'setTypeOfService'),
    errno('ECONNRESET', 'read'),
    errno('EPIPE', 'write'),
    errno('ECONNREFUSED', 'connect'),
    new DaemonUnreachableError('gone'),
  ]) {
    expect(outcome(error)).toEqual({ logged: true, shown: [] })
  }
})

test('other uncaught errors are logged and shown', () => {
  expect(outcome(new TypeError('boom'))).toEqual({
    logged: true,
    shown: ['TED hit an unexpected error'],
  })
})

test('a hidden window never shows a dialog', () => {
  expect(outcome(new TypeError('boom'), true)).toEqual({ logged: true, shown: [] })
})
