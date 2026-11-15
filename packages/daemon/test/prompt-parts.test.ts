import { expect, test } from 'vitest'
import { joinPrompt, promptTextHash, splitPrompt } from '../src/store/prompt-parts.ts'

const long = (word: string) => `${word} `.repeat(80)

test('splitPrompt refers to shared texts and requests and joins back to the same prompt', () => {
  const preamble = long('preamble')
  const notes = long('notes')
  const instructions = long('instructions')
  const prompt = `${preamble}\n\nunique\n\n${notes}${instructions}\n\n${notes}`
  const { parts, texts } = splitPrompt(prompt, [notes, preamble, notes, 'short'], {
    id: 'sub-1',
    text: instructions,
  })
  expect(parts).toEqual([
    { hash: promptTextHash(preamble) },
    { text: '\n\nunique\n\n' },
    { hash: promptTextHash(notes) },
    { request: 'sub-1' },
    { text: '\n\n' },
    { hash: promptTextHash(notes) },
  ])
  expect([...texts.values()].sort()).toEqual([notes, preamble].sort())
  expect(
    joinPrompt(
      parts,
      (hash) => texts.get(hash),
      () => instructions,
    ),
  ).toBe(prompt)
})

test('splitPrompt keeps a prompt whole when nothing shared is in it', () => {
  expect(splitPrompt('hello', [long('absent')])).toEqual({
    parts: [{ text: 'hello' }],
    texts: new Map(),
  })
  expect(splitPrompt('', [long('absent')]).parts).toEqual([])
})
