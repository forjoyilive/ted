import { describe, expect, test } from 'vitest'
import {
  type EnterPress,
  enterAction,
  sendOnEnter,
  signOffEnter,
} from '../src/renderer/composer-keys.ts'

const press = (mods: Partial<EnterPress> = {}): EnterPress => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  keyCode: 13,
  ...mods,
})

function keyDown(value: string, mods: Partial<EnterPress> = {}) {
  const pressed = press(mods)
  let prevented = false
  const event = {
    ...pressed,
    currentTarget: { value },
    nativeEvent: { isComposing: pressed.isComposing, keyCode: pressed.keyCode },
    preventDefault: () => {
      prevented = true
    },
  }
  return { event, prevented: () => prevented }
}

describe('composer keys', () => {
  test('↵ sends, ⌘↵ and ⌃↵ send with the command key, ⇧↵ and ⌥↵ add a line', () => {
    expect(enterAction(press())).toBe('send')
    expect(enterAction(press({ metaKey: true }))).toBe('command-send')
    expect(enterAction(press({ ctrlKey: true }))).toBe('command-send')
    expect(enterAction(press({ shiftKey: true }))).toBeUndefined()
    expect(enterAction(press({ altKey: true }))).toBeUndefined()
    expect(enterAction(press({ key: 'a' }))).toBeUndefined()
  })

  test('nothing sends while an input method is composing', () => {
    expect(enterAction(press({ isComposing: true }))).toBeUndefined()
    expect(enterAction(press({ keyCode: 229 }))).toBeUndefined()
  })

  test('the handler sends typed text and never empty or whitespace-only text', () => {
    const sent: boolean[] = []
    const handler = sendOnEnter((command) => sent.push(command))

    const typed = keyDown('Ship it')
    handler(typed.event as never)
    expect(sent).toEqual([false])
    expect(typed.prevented()).toBe(true)

    const command = keyDown('Ship it', { metaKey: true })
    handler(command.event as never)
    expect(sent).toEqual([false, true])

    const blank = keyDown('  \n ')
    handler(blank.event as never)
    expect(sent).toEqual([false, true])
    expect(blank.prevented()).toBe(true)

    const newline = keyDown('Ship it', { shiftKey: true })
    handler(newline.event as never)
    expect(newline.prevented()).toBe(false)

    const composing = keyDown('日本', { isComposing: true })
    handler(composing.event as never)
    expect(composing.prevented()).toBe(false)
    expect(sent).toEqual([false, true])
  })

  test('a box with files may send without text when it says it is ready', () => {
    const sent: boolean[] = []
    const handler = sendOnEnter(
      (command) => sent.push(command),
      () => true,
    )
    handler(keyDown('').event as never)
    expect(sent).toEqual([false])
  })

  test('on a sign-off, ↵ approves an empty box and requests changes once text is typed', () => {
    expect(signOffEnter(false)).toBe('approve')
    expect(signOffEnter(true)).toBe('request-changes')
  })
})
