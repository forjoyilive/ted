import { createInterface } from 'node:readline'
import { type BrowserRequest, browserViewport, tedEnv } from '@ted/protocol'
import { app, BrowserWindow, net, session } from 'electron'
import { closeGuest, type GuestPage, openGuest, runOnPage } from './browser-page.ts'
import { guestProxyRules } from './browser-proxy.ts'
import { openRemote, type RemotePage } from './remote-page.ts'

export interface HelperCommand {
  id: string
  url: string
  port?: number
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
  const proxy = guestProxyRules(app, net)
  let page: GuestPage | undefined
  let remote: RemotePage | undefined
  let size = { width: 1280, height: 800 }
  let sized = false
  let scheme: 'light' | 'dark' = 'light'
  const drop = () => {
    if (page) closeGuest(page)
    page = undefined
    remote?.close()
    remote = undefined
  }
  const execute = async (command: HelperCommand) => {
    const check = () => {
      if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    }
    if (command.request.action === 'open' && command.port !== undefined) {
      drop()
      const opened = await openRemote(command.port, {
        check,
        gone: (gone) => {
          if (remote === gone) drop()
        },
      })
      remote = opened
      if (sized) await opened.resize(size.width, size.height)
      await opened.driver.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      })
      return { url: opened.driver.url() }
    }
    if (command.request.action === 'open') {
      drop()
      await ses.clearStorageData()
      check()
      const opened = await openGuest(ses, command.url, {
        check,
        proxy,
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
      await opened.contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      })
      return { url: opened.contents.getURL(), ...(opened.error && { text: opened.error }) }
    }
    const current =
      command.port !== undefined
        ? remote?.port === command.port
          ? remote
          : undefined
        : page?.ready && page.url === command.url
          ? page
          : undefined
    if (!current) throw new Error('Open the App with ted browser open first')
    const result = await runOnPage(current, command, {
      check,
      current: () => page === current || remote === current,
      closeAfterPartialInput: drop,
    })
    if (command.request.action === 'resize') {
      const viewport = browserViewport(command.request.value ?? '')
      if (typeof viewport !== 'string') {
        size = viewport
        sized = true
      }
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
