import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import path from 'node:path'
import { scriptLiteral } from '@ted/protocol'
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
    const images = [
      `http://127.0.0.1:${address.port}/art.png`,
      `http://localhost:${address.port}/art.png`,
    ]
      .map(scriptLiteral)
      .join(', ')
    const script = `Promise.all([
      ...[${images}].map((src) => new Promise((resolve) => {
        const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = src;
      })),
      new Promise((resolve) => {
        const script = document.createElement('script'); script.onload = () => resolve('loaded'); script.onerror = () => resolve('blocked');
        script.src = ${scriptLiteral('https://cdn.example/app.js')}; document.head.append(script);
      }),
    ])`
    const results = await app.evaluate(
      async ({ webContents }, { url, script }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(script)
      },
      { url, script },
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

export async function checkRefusedNames(
  app: ElectronApplication,
  panel: import('playwright').Locator,
  url: string,
  reload?: () => Promise<object>,
) {
  const guestScript = (script: string) =>
    app.evaluate(
      async ({ webContents }, { url, script }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(script)
      },
      { url, script },
    )
  if (reload) {
    await expect
      .poll(() => guestScript('globalThis.beforeReload = true').catch(() => false))
      .toBe(true)
    await reload()
    await expect
      .poll(() =>
        guestScript(`!globalThis.beforeReload && document.readyState === 'complete'`).catch(
          () => false,
        ),
      )
      .toBe(true)
  }
  await expect.poll(() => panel.textContent()).not.toContain('Blocked')
  const images = ['http://private.example/art.png', 'https://private.example/art.png']
    .map(scriptLiteral)
    .join(', ')
  const script = `Promise.all([${images}].map((src) => new Promise((resolve) => {
    const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('refused'); image.src = src;
  })))`
  expect(await guestScript(script)).toEqual(['refused', 'refused'])
  await expect.poll(() => panel.textContent()).toContain('Blocked 2 requests to other sites')
}

export async function checkHeldRefusal(
  app: ElectronApplication,
  panel: import('playwright').Locator,
  url: string,
  navigate: (url: string) => Promise<object>,
  blocked: () => Promise<number | undefined>,
) {
  const guestScript = (url: string, script: string) =>
    app.evaluate(
      async ({ webContents }, { url, script }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(script)
      },
      { url, script },
    )
  const loaded = (url: string) =>
    expect.poll(() => guestScript(url, 'document.readyState').catch(() => '')).toBe('complete')
  const next = new URL('?after-held', url).href
  await navigate(next)
  await loaded(next)
  expect(await blocked()).toBe(0)
  await guestScript(
    next,
    `globalThis.heldImage = new Image(); heldImage.src = ${scriptLiteral('http://held.example/art.png')}; true`,
  )
  await expect
    .poll(() => app.evaluate(() => globalThis.tedHeldLookups?.waiting ?? []))
    .toEqual(['held.example'])
  await navigate(url)
  await loaded(url)
  expect(
    await app.evaluate(async () => {
      globalThis.tedHeldLookups?.release()
      await new Promise((resolve) => setImmediate(resolve))
      return globalThis.tedHeldLookups?.waiting
    }),
  ).toEqual([])
  expect(await blocked()).toBe(0)
  expect(
    await guestScript(
      url,
      `new Promise((resolve) => {
        const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('refused');
        image.src = ${scriptLiteral('http://private.example/art.png?after-held')};
      })`,
    ),
  ).toBe('refused')
  expect(await blocked()).toBe(1)
  await expect.poll(() => panel.textContent()).toContain('Blocked 1 request to other sites')
}

export async function checkWorkerMedia(
  app: ElectronApplication,
  panel: import('playwright').Locator,
  url: string,
) {
  const guestScript = (script: string) =>
    app.evaluate(
      async ({ webContents }, { url, script }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL() === url)
        if (!guest) throw new Error('No guest')
        return guest.executeJavaScript(script)
      },
      { url, script },
    )
  const before = Number((await panel.textContent())?.match(/Blocked (\d+) requests?/)?.[1] ?? 0)
  const passed = scriptLiteral('http://private.example/art.png?through-worker')
  const fetched = scriptLiteral('http://private.example/art.png?from-worker')
  try {
    const result = await guestScript(`(async () => {
      const registration = await navigator.serviceWorker.register('/media/worker.js', { scope: '/media/' });
      const worker = registration.installing || registration.waiting || registration.active;
      if (worker.state !== 'activated')
        await new Promise((resolve) => worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()));
      const ask = (data) => new Promise((resolve) => {
        const channel = new MessageChannel(); channel.port1.onmessage = (e) => resolve(e.data);
        worker.postMessage(data, [channel.port2]);
      });
      const frame = document.createElement('iframe'); frame.src = '/media/page';
      globalThis.workerMediaFrame = frame;
      await new Promise((resolve) => { frame.onload = resolve; document.body.append(frame); });
      const through = await new Promise((resolve) => {
        const image = frame.contentDocument.createElement('img');
        image.onload = () => resolve('loaded'); image.onerror = () => resolve('refused');
        image.src = ${passed}; frame.contentDocument.body.append(image);
      });
      const fromWorker = await ask({ fetch: ${fetched} });
      return { controlled: !!frame.contentWindow.navigator.serviceWorker.controller, seen: await ask({}), through, fromWorker };
    })()`)
    expect(result).toEqual({
      controlled: true,
      seen: ['http://private.example/art.png?through-worker'],
      through: 'refused',
      fromWorker: 'refused',
    })
    await expect
      .poll(() => panel.textContent())
      .toContain(`Blocked ${before + 2} requests to other sites`)
  } finally {
    await guestScript(`(async () => {
      globalThis.workerMediaFrame?.remove(); delete globalThis.workerMediaFrame;
      for (const registration of await navigator.serviceWorker.getRegistrations())
        if (registration.scope.endsWith('/media/')) await registration.unregister();
    })()`)
  }
}
