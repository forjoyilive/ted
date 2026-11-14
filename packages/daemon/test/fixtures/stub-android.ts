import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface StubAvd {
  image: string
  hardware?: string
}

export interface StubEmulator {
  avd: string
  pid: number
  window: boolean
  snapshot?: string
}

export interface StubScreenState {
  screen: 'home' | 'details'
  night?: boolean
  size?: string
  density?: string
  typed?: string
}

export interface StubAndroidState {
  sdk?: boolean
  avds?: Record<string, StubAvd>
  running?: Record<string, StubEmulator>
  snapshots?: Record<string, string[]>
  ui?: Record<string, StubScreenState>
}

interface StubNode {
  kind: string
  text?: string
  id?: string
  clickable?: boolean
  bounds: [number, number, number, number]
}

const stubScreens: Record<StubScreenState['screen'], StubNode[]> = {
  home: [
    { kind: 'android.widget.TextView', text: 'Widgets', bounds: [80, 200, 1000, 320] },
    {
      kind: 'android.widget.Button',
      text: 'Open details',
      id: 'com.example.widgets:id/open',
      clickable: true,
      bounds: [80, 600, 1000, 760],
    },
  ],
  details: [
    { kind: 'android.widget.TextView', text: 'Details', bounds: [80, 200, 1000, 320] },
    {
      kind: 'android.widget.TextView',
      text: 'Price: 10 widgets for $5 & free <delivery>',
      bounds: [80, 500, 1000, 620],
    },
    {
      kind: 'android.widget.Button',
      text: 'Buy',
      id: 'com.example.widgets:id/buy',
      clickable: true,
      bounds: [80, 560, 1000, 700],
    },
    {
      kind: 'android.widget.Button',
      text: 'Back',
      id: 'com.example.widgets:id/back',
      clickable: true,
      bounds: [80, 2200, 400, 2340],
    },
  ],
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function dump(state: StubScreenState): string {
  const nodes = stubScreens[state.screen].map((n, index) => {
    const [l, t, r, b] = n.bounds
    return `<node index="${index}" text="${escapeXml(n.text ?? '')}" resource-id="${n.id ?? ''}" class="${n.kind}" package="com.example.widgets" content-desc="" clickable="${n.clickable === true}" bounds="[${l},${t}][${r},${b}]" />`
  })
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.widgets" content-desc="" clickable="false" bounds="[0,0][1080,2400]">${nodes.join('')}</node></hierarchy>UI hierchary dumped to: /dev/tty`
}

function tapped(state: StubScreenState, x: number, y: number): StubScreenState['screen'] {
  const hit = stubScreens[state.screen].find(
    (n) =>
      n.clickable && x >= n.bounds[0] && x < n.bounds[2] && y >= n.bounds[1] && y < n.bounds[3],
  )
  if (hit?.text === 'Open details') return 'details'
  if (hit?.text === 'Back') return 'home'
  return state.screen
}

const file = process.env.TED_STUB_ANDROID

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function locked<T>(work: () => T): T {
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (tries > 400) throw new Error('stub-android: state is locked')
      sleep(10)
    }
  }
  try {
    return work()
  } finally {
    rmdirSync(lock)
  }
}

function read(): StubAndroidState {
  if (!file) return { sdk: false }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StubAndroidState
  } catch {
    return { sdk: false }
  }
}

function write(state: StubAndroidState): void {
  if (!file) return
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function live(state: StubAndroidState): Record<string, StubEmulator> {
  return Object.fromEntries(Object.entries(state.running ?? {}).filter(([, e]) => alive(e.pid)))
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

function adb(args: string[]): void {
  if (args[0] === 'version') return void console.log('Android Debug Bridge version 1.0.41')
  if (args[0] === 'devices') {
    const lines = Object.keys(live(read())).map((serial) => `${serial}\tdevice`)
    return void console.log(['List of devices attached', ...lines, ''].join('\n'))
  }
  if (args[0] !== '-s') fail(`stub adb: unknown command ${args.join(' ')}`)
  const serial = args[1] ?? ''
  const rest = args.slice(2)
  const target = live(read())[serial]
  if (!target) fail(`adb: device '${serial}' not found`)
  const command = rest.join(' ')
  if (command === 'emu avd name') return void console.log(`${target.avd}\nOK`)
  if (command === 'shell getprop sys.boot_completed') return void console.log('1')
  if (command === 'exec-out screencap -p') {
    return void process.stdout.write(Buffer.from(`PNG of ${target.avd}`))
  }
  if (command.startsWith('emu avd snapshot save ')) {
    const name = rest.at(-1) ?? ''
    locked(() => {
      const state = read()
      const snapshots = state.snapshots ?? {}
      snapshots[target.avd] = [...(snapshots[target.avd] ?? []), name]
      write({ ...state, snapshots })
    })
    return void console.log('OK')
  }
  const ui = (change?: (current: StubScreenState) => StubScreenState): StubScreenState => {
    if (!change) return read().ui?.[target.avd] ?? { screen: 'home' }
    return locked(() => {
      const state = read()
      const next = change(state.ui?.[target.avd] ?? { screen: 'home' })
      write({ ...state, ui: { ...state.ui, [target.avd]: next } })
      return next
    })
  }
  if (command === 'exec-out uiautomator dump /dev/tty') return void console.log(dump(ui()))
  if (command === 'shell wm size') {
    const { size } = ui()
    return void console.log(
      ['Physical size: 1080x2400', ...(size ? [`Override size: ${size}`] : [])].join('\n'),
    )
  }
  const shell = rest[0] === 'shell' ? rest.slice(1) : []
  if (shell[0] === 'wm' && (shell[1] === 'size' || shell[1] === 'density') && shell[2]) {
    const field = shell[1]
    const value = shell[2] === 'reset' ? undefined : shell[2]
    ui((current) => {
      const { [field]: _, ...others } = current
      return value === undefined ? others : { ...others, [field]: value }
    })
    return
  }
  if (shell.join(' ').startsWith('cmd uimode night ')) {
    const night = shell[3] === 'yes'
    ui((current) => ({ ...current, night }))
    return void console.log(`Night mode: ${night ? 'yes' : 'no'}`)
  }
  if (shell[0] === 'input' && shell[1] === 'tap' && shell.length === 4) {
    ui((current) => ({ ...current, screen: tapped(current, Number(shell[2]), Number(shell[3])) }))
    return
  }
  if (shell[0] === 'input' && shell[1] === 'keyevent' && shell.length === 3) {
    if (shell[2] === '4') ui((current) => ({ ...current, screen: 'home' }))
    return
  }
  if (shell[0] === 'input' && shell[1] === 'text' && shell.length === 3) {
    ui((current) => ({ ...current, typed: `${current.typed ?? ''}${shell[2]}` }))
    return
  }
  if (shell[0] === 'input' && shell[1] === 'swipe' && shell.length === 7) return
  if (command === 'emu kill') {
    locked(() => {
      const state = read()
      delete state.running?.[serial]
      write(state)
    })
    try {
      process.kill(target.pid, 'SIGTERM')
    } catch {}
    return void console.log('OK: killing emulator, bye bye')
  }
  fail(`stub adb: unknown command ${command}`)
}

function emulator(args: string[]): void {
  const state = read()
  if (args[0] === '-list-avds') {
    return void console.log(Object.keys(state.avds ?? {}).join('\n'))
  }
  const avd = option(args, '-avd') ?? fail('stub emulator: no -avd')
  const port = option(args, '-port') ?? '5554'
  if (!state.avds?.[avd])
    fail(`PANIC: Unknown AVD name [${avd}], use -list-avds to see valid list.`)
  const serial = `emulator-${port}`
  const snapshot = option(args, '-snapshot')
  locked(() => {
    const current = read()
    current.running = {
      ...live(current),
      [serial]: {
        avd,
        pid: process.pid,
        window: !args.includes('-no-window'),
        ...(snapshot !== undefined && { snapshot }),
      },
    }
    write(current)
  })
  console.log(`INFO: boot completed for ${avd}`)
  const stop = () => process.exit(0)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  setInterval(() => {
    if (read().running?.[serial]?.pid !== process.pid) process.exit(0)
  }, 100)
}

function avdmanager(args: string[]): void {
  const verb = args.slice(0, 2).join(' ')
  if (verb === 'list avd') {
    const avds = read().avds ?? {}
    if (args.includes('-c')) return void console.log(Object.keys(avds).join('\n'))
    const blocks = Object.entries(avds).map(([name, avd]) => {
      const dir = path.join(`${file}.avd`, `${name}.avd`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, 'config.ini'),
        [
          `image.sysdir.1=${avd.image.split(';').join('/')}/`,
          ...(avd.hardware !== undefined ? [`hw.device.name=${avd.hardware}`] : []),
          '',
        ].join('\n'),
      )
      return [`    Name: ${name}`, `    Path: ${dir}`, '  Target: Google APIs'].join('\n')
    })
    return void console.log(
      ['Available Android Virtual Devices:', blocks.join('\n---------\n')].join('\n'),
    )
  }
  if (verb === 'create avd') {
    const name = option(args, '--name') ?? fail('stub avdmanager: no --name')
    const image = option(args, '--package') ?? fail('stub avdmanager: no --package')
    const hardware = option(args, '--device')
    locked(() => {
      const state = read()
      state.avds = {
        ...state.avds,
        [name]: { image, ...(hardware !== undefined && { hardware }) },
      }
      write(state)
    })
    return
  }
  if (verb === 'delete avd') {
    const name = option(args, '--name') ?? fail('stub avdmanager: no --name')
    if (!read().avds?.[name]) fail(`Error: There is no Android Virtual Device named '${name}'.`)
    locked(() => {
      const state = read()
      delete state.avds?.[name]
      write(state)
    })
    return void console.log(`AVD '${name}' deleted.`)
  }
  fail(`stub avdmanager: unknown command ${args.join(' ')}`)
}

export function runStub(tool: 'adb' | 'emulator' | 'avdmanager'): void {
  const args = process.argv.slice(2)
  if (file) appendFileSync(`${file}.calls`, `${JSON.stringify([tool, ...args])}\n`)
  if (read().sdk === false) fail(`${tool}: command not found`, 127)
  if (tool === 'adb') adb(args)
  else if (tool === 'emulator') emulator(args)
  else avdmanager(args)
}
