import type { Crash } from '@ted/protocol'
import { crashFrom } from '@ted/protocol/crash-report'
import type { Untyped } from '@ted/protocol/parse'
import { ted } from './ted.ts'

function send(crash: Crash): void {
  ted.reportCrash(crash).catch(() => undefined)
}

export function watchCrashes(target: Window): void {
  target.addEventListener('error', (event) => {
    if (event.error == null && event.message.startsWith('ResizeObserver loop')) return
    send(crashFrom('uncaught', event.error ?? event.message))
  })
  target.addEventListener('unhandledrejection', (event) =>
    send(crashFrom('rejection', event.reason)),
  )
}

export function reportRenderError(error: Untyped): void {
  console.error(error)
  send(crashFrom('render', error))
}
