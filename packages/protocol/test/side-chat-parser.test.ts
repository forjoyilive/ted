import { parseSideChatMessageRequest, RequestValidationError } from '@ted/protocol'
import { expect, test } from 'vitest'

test('parses every side-chat message field and trims the question', () => {
  expect(parseSideChatMessageRequest({ text: ' Why? ' })).toEqual({ text: 'Why?' })
  expect(parseSideChatMessageRequest({ text: 'x'.repeat(10_000) }).text).toHaveLength(10_000)
})

test('rejects invalid side questions with the shared HTTP validation error', () => {
  for (const input of [null, [], {}, { text: 1 }, { text: '  ' }, { text: 'x'.repeat(10_001) }]) {
    expect(() => parseSideChatMessageRequest(input)).toThrow(RequestValidationError)
    try {
      parseSideChatMessageRequest(input)
    } catch (error) {
      expect(error).toMatchObject({ status: 400 })
    }
  }
})
