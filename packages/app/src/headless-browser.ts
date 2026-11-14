import { createInterface } from 'node:readline'
import { type BrowserRequest, browserViewport, tedEnv } from '@ted/protocol'
import { app, BrowserWindow, session } from 'electron'
import { closeGuest, type GuestPage, openGuest, runOnPage } from './browser-page.ts'

export interface HelperCommand {
  id: string
  url: string
  expiresAt: number
  request: BrowserRequest
}

export interface HelperReply {
  id: string
  url?: string
  text?: string
  capture?: string
  error?: string
}

const profile = tedEnv('TED_BROWSER_PROFILE')
if (!profile) {
  console.error('TED_BROWSER_PROFILE is not set')
  process.exit(1)
}
app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined)

const send = (reply: HelperReply) => {
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

void app.whenReady().then(() => {
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  const ses = session.fromPartition('ted-run-browser')
  let page: GuestPage | undefined
  let size = { width: 1280, height: 800 }
  let scheme: 'light' | 'dark' | undefined
  const drop = () => {
    if (page) closeGuest(page)
    page = undefined
  }
  const execute = async (command: HelperCommand) => {
    const check = () => {
      if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    }
    if (command.request.action === 'open') {
      drop()
      await ses.clearStorageData()
      check()
      const opened = await openGuest(ses, command.url, {
        check,
        host: (webPreferences) => {
          // A page outside any window can’t be captured or clicked; an offscreen window can.
          const window = new BrowserWindow({
            show: false,
            useContentSize: true,
            ...size,
            webPreferences: { ...webPreferences, offscreen: true },
          })
          return {
            contents: window.webContents,
            resize: (width, height) => window.setContentSize(width, height),
            close: () => {
              if (!window.isDestroyed()) window.destroy()
            },
          }
        },
        created: (guest) => {
          page = guest
        },
        gone: (guest) => {
          if (page === guest) drop()
        },
      })
      if (scheme)
        await opened.contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        })
      return { url: opened.contents.getURL(), ...(opened.error && { text: opened.error }) }
    }
    const current = page
    if (!current?.ready || current.url !== command.url)
      throw new Error('Open a web App with ted browser open first')
    const result = await runOnPage(current, command, {
      check,
      current: () => page === current,
      closeAfterPartialInput: drop,
    })
    if (command.request.action === 'resize') {
      const viewport = browserViewport(command.request.value ?? '')
      if (typeof viewport !== 'string') size = viewport
    }
    if (command.request.action === 'color-scheme')
      scheme = command.request.value === 'dark' ? 'dark' : 'light'
    return result
  }
  let queue = Promise.resolve()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let command: HelperCommand
    try {
      command = JSON.parse(line) as HelperCommand
    } catch {
      return
    }
    queue = queue.then(async () => {
      try {
        const { capture, ...result } = await execute(command)
        send({
          id: command.id,
          ...result,
          ...(capture && { capture: Buffer.from(capture).toString('base64') }),
        })
      } catch (error) {
        send({
          id: command.id,
          error: error instanceof Error ? error.message.slice(0, 1000) : 'Browser command failed',
        })
      }
    })
  })
  lines.on('close', () => app.exit(0))
  send({ id: 'ready' })
})
