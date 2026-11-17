import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'

export async function startGuestWorker(app: ElectronApplication, url: string) {
  await app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
    if (!guest) throw new Error('No guest')
    await guest.executeJavaScript(`(async () => {
      await navigator.serviceWorker.register('/browser-service-worker.js');
      const registration = await navigator.serviceWorker.ready;
      registration.active.postMessage('start');
    })()`)
  }, url)
  await expect.poll(async () => (await guestWorkerTraffic(url)).messages).toBeGreaterThan(1)
}

export async function guestWorkerTraffic(url: string): Promise<{
  messages: number
  connections: number
}> {
  return (await fetch(new URL('/browser-worker-traffic', url))).json()
}

export async function checkGuestNetwork(app: ElectronApplication, url: string) {
  const certificate = await app.evaluate(({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
    if (!guest) throw new Error('No guest')
    let prevented = false
    const selected: unknown[][] = []
    guest.emit(
      'select-client-certificate',
      {
        preventDefault: () => {
          prevented = true
        },
      },
      url,
      [{ subjectName: 'Fixture identity' }],
      (...args: unknown[]) => selected.push(args),
    )
    return { prevented, selected }
  }, url)
  expect(certificate).toEqual({ prevented: true, selected: [[]] })
  const udp = createSocket('udp4')
  const tcp = createServer((socket) => {
    connections++
    socket.destroy()
  })
  let packets = 0
  let connections = 0
  udp.on('message', () => packets++)
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const address = tcp.address()
  if (!address || typeof address === 'string') throw new Error('No TCP fixture port')
  try {
    const result = await app.evaluate(
      async ({ webContents }, { url, udpPort, tcpPort }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(`(async () => {
        const frame = document.createElement('iframe'); document.body.append(frame);
        globalThis.networkProbe = {frame, peers:[]};
        const results = [];
        for (const win of [window, frame.contentWindow]) {
          const Ctor = win.RTCPeerConnection;
          results.push({peer:typeof Ctor, webkit:typeof win.webkitRTCPeerConnection, transport:typeof win.WebTransport,
            replaceable:Reflect.defineProperty(win,'RTCPeerConnection',{value:function(){}})});
          if (Ctor) {
            const peer = new Ctor({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'},{urls:'turn:127.0.0.1:${tcpPort}?transport=tcp',username:'fixture',credential:'fixture'}]});
            networkProbe.peers.push(peer); peer.createDataChannel('fixture'); await peer.setLocalDescription(await peer.createOffer());
          }
        }
        const worker = new Worker('/browser-worker.js?port=${udpPort}'); networkProbe.worker=worker;
        const workerResult = await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=()=>reject(Error('Worker failed'));});
        return {atLoad:globalThis.rtcAtLoad,results,workerResult};
      })()`)
      },
      { url, udpPort: udp.address().port, tcpPort: address.port },
    )
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(result).toEqual({
      atLoad: 'undefined',
      workerResult: 'blocked',
      results: [0, 1].map(() => ({
        peer: 'undefined',
        webkit: 'undefined',
        transport: 'function',
        replaceable: false,
      })),
    })
    expect(packets).toBe(0)
    expect(connections).toBe(0)
  } finally {
    await app.evaluate(
      async ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)
          ?.executeJavaScript(
            'for(const p of networkProbe.peers)p.close();networkProbe.frame.remove();networkProbe.worker?.terminate();delete globalThis.networkProbe',
          ),
      url,
    )
    udp.close()
    await new Promise<void>((resolve, reject) =>
      tcp.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

type HeldValidation = typeof globalThis & {
  validationProbe?: { held: number; release: () => void }
}
export async function checkModalRace(app: ElectronApplication, window: Page, url: string) {
  await app.evaluate((_electron, modulePath) => {
    const { DaemonClient } = process.getBuiltinModule('module').createRequire(modulePath)(
      modulePath,
    ) as typeof import('../../protocol/src/client.ts')
    const original = DaemonClient.prototype.browserApp
    const waiters: (() => void)[] = []
    const state = {
      held: 0,
      release: () => {
        DaemonClient.prototype.browserApp = original
        for (const release of waiters) release()
      },
    }
    ;(globalThis as HeldValidation).validationProbe = state
    DaemonClient.prototype.browserApp = async function (...args) {
      state.held++
      await new Promise<void>((resolve) => waiters.push(resolve))
      return original.apply(this, args)
    }
  }, path.resolve('packages/protocol/src/client.ts'))
  const attached = () =>
    app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0]?.contentView.children.filter(
          (v) =>
            'webContents' in v &&
            (v.webContents as import('electron').WebContents).getURL() === url,
        ).length ?? 0,
      url,
    )
  try {
    await window.setViewportSize({ width: 1100, height: 760 })
    await expect
      .poll(() => app.evaluate(() => (globalThis as HeldValidation).validationProbe?.held ?? 0))
      .toBeGreaterThan(0)
    await window.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'pending-browser-modal'
      dialog.textContent = 'Modal fixture'
      document.body.append(dialog)
      dialog.showModal()
    })
    await expect.poll(attached).toBe(0)
    await app.evaluate(() => (globalThis as HeldValidation).validationProbe?.release())
    await window.waitForTimeout(100)
    expect(await attached()).toBe(0)
  } finally {
    await app.evaluate(() => {
      const state = globalThis as HeldValidation
      state.validationProbe?.release()
      delete state.validationProbe
    })
    await window.evaluate(() => document.querySelector('#pending-browser-modal')?.remove())
  }
  await expect.poll(attached).toBe(1)
}

type HeldLookup = typeof globalThis & {
  lookupProbe?: { held: boolean; release: () => void; restore: () => void }
}

export async function checkInFlightNavigation(
  app: ElectronApplication,
  url: string,
  command: (
    request: import('@ted/protocol').BrowserRequest,
  ) => Promise<import('@ted/protocol').BrowserResult>,
) {
  const snapshot = await command({ action: 'snapshot' })
  const ref = snapshot.text?.match(/([^\s]+) button Try it/)?.[1]
  if (!ref) throw new Error('No fixture button')
  const id = await app.evaluate(({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
    if (!guest) throw new Error('No guest')
    const original = guest.executeJavaScriptInIsolatedWorld
    const probe = {
      held: false,
      release: () => {},
      restore: () => {
        guest.executeJavaScriptInIsolatedWorld = original
      },
    }
    ;(globalThis as HeldLookup).lookupProbe = probe
    guest.executeJavaScriptInIsolatedWorld = async function (...args) {
      const result = await original.apply(this, args)
      if (args[1][0]?.code.includes('Element is not clickable')) {
        probe.held = true
        await new Promise<void>((resolve) => {
          probe.release = resolve
        })
      }
      return result
    }
    return guest.id
  }, url)
  try {
    const clicking = command({ action: 'click', ref }).then(
      () => 'unexpected success',
      (error: Error) => error.message,
    )
    await expect
      .poll(() => app.evaluate(() => (globalThis as HeldLookup).lookupProbe?.held), {
        timeout: 10_000,
      })
      .toBe(true)
    await app.evaluate(
      async ({ webContents }, { id, url }) => {
        await webContents.fromId(id)?.loadURL(new URL('?next=1', url).href)
      },
      { id, url },
    )
    await app.evaluate(() => (globalThis as HeldLookup).lookupProbe?.release())
    expect(await clicking).toMatch(/page changed/)
    expect(
      await app.evaluate(
        async ({ webContents }, id) =>
          webContents.fromId(id)?.executeJavaScript('document.querySelector("h1").textContent'),
        id,
      ),
    ).toBe('Project')
  } finally {
    await app.evaluate(
      async ({ webContents }, { id, url }) => {
        const state = globalThis as HeldLookup
        state.lookupProbe?.release()
        state.lookupProbe?.restore()
        delete state.lookupProbe
        await webContents.fromId(id)?.loadURL(url)
      },
      { id, url },
    )
  }
}

export async function checkOutsideRequests(
  app: ElectronApplication,
  panel: import('playwright').Locator,
  url: string,
) {
  let connections = 0
  const tcp = createServer((socket) => {
    connections++
    socket.destroy()
  })
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const address = tcp.address() as import('node:net').AddressInfo
  try {
    const results = await app.evaluate(
      async ({ webContents }, { url, port }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(`Promise.all([
          ...['http://127.0.0.1:${port}/art.png', 'http://localhost:${port}/art.png'].map((src) => new Promise((resolve) => {
            const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = src;
          })),
          new Promise((resolve) => {
            const script = document.createElement('script'); script.onload = () => resolve('loaded'); script.onerror = () => resolve('blocked');
            script.src = 'https://cdn.example/app.js'; document.head.append(script);
          }),
        ])`)
      },
      { url, port: address.port },
    )
    expect(results).toEqual(['blocked', 'blocked', 'blocked'])
    expect(connections).toBe(0)
    await expect
      .poll(() => panel.textContent())
      .toMatch(/Blocked [1-9]\d* requests to other sites · Open ↗/)
  } finally {
    await new Promise<void>((resolve, reject) =>
      tcp.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
