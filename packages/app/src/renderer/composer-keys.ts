import type { KeyboardEvent } from 'react'

export interface EnterPress {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  keyCode: number
}

export function enterAction(press: EnterPress): 'send' | 'command-send' | undefined {
  if (press.key !== 'Enter' || press.isComposing || press.keyCode === 229) return undefined
  if (press.shiftKey || press.altKey) return undefined
  return press.metaKey || press.ctrlKey ? 'command-send' : 'send'
}

export function signOffEnter(typed: boolean): 'approve' | 'request-changes' {
  return typed ? 'request-changes' : 'approve'
}

export function sendOnEnter(
  send: (command: boolean) => void,
  ready: (text: string) => boolean = (text) => text.trim() !== '',
) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = enterAction({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    })
    if (action === undefined) return
    event.preventDefault()
    if (!ready(event.currentTarget.value)) return
    send(action === 'command-send')
  }
}
