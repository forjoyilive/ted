import { type StdioOptions, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { createInterface } from 'node:readline'
import { Readable, Writable } from 'node:stream'
import { firstBindFd, forwardingFds } from './sandbox.ts'

// The command is unshare running bwrap, which reports on statusFd and waits on blockFd. Pasta must join
// unshare's namespaces, not bwrap's child's: bwrap nests a user namespace that doesn't own the network one.
delete process.env.ELECTRON_RUN_AS_NODE
const [pasta, count, ...rest] = process.argv.slice(2)
const split = rest.indexOf('--')
const pastaArgs = rest.slice(0, split)
const [command, ...commandArgs] = rest.slice(split + 1)
const bindFds = Number(count)
if (
  pasta === undefined ||
  command === undefined ||
  split < 0 ||
  !Number.isInteger(bindFds) ||
  bindFds < 0
) {
  console.error('usage: forward-ports.ts <pasta> <bind fds> <pasta args…> -- <command> <args…>')
  process.exit(2)
}

const { status: statusFd, block: blockFd } = forwardingFds(bindFds)
const stdio: StdioOptions = [
  'inherit',
  'inherit',
  'inherit',
  ...Array.from({ length: bindFds }, (_, i) => firstBindFd + i),
  'pipe',
  'pipe',
]
const child = spawn(command, commandArgs, { stdio })
let sandboxPid: number | undefined
let released = false
// Until bwrap's sandboxed child reads blockFd it has no die-with-parent, and closing blockFd releases it.
const stopSandbox = () => {
  if (!released && sandboxPid !== undefined) {
    try {
      process.kill(sandboxPid, 'SIGKILL')
    } catch {}
  }
  child.kill('SIGKILL')
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => {})
child.once('error', (error) => {
  console.error(`Ted couldn’t start the App’s sandbox: ${error.message}`)
  process.exit(1)
})
const status = child.stdio[statusFd]
const block = child.stdio[blockFd]
if (!(status instanceof Readable) || !(block instanceof Writable)) {
  stopSandbox()
  throw new Error('bwrap’s status and block pipes didn’t open')
}

const started = new Promise<boolean>((resolve) => {
  const lines = createInterface({ input: status })
  lines.on('line', (line) => {
    const found = /"child-pid"\s*:\s*(\d+)/.exec(line)
    if (found?.[1] === undefined) return
    sandboxPid = Number(found[1])
    resolve(true)
    lines.close()
  })
  lines.once('close', () => resolve(false))
})
child.once('exit', async (code, signal) => {
  if (!released) {
    await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 1000))])
  }
  stopSandbox()
  process.exit(code ?? (signal === null ? 1 : 128 + constants.signals[signal]))
})
status.resume()
if (!(await started) || child.pid === undefined) {
  console.error('bwrap stopped before it set up the App’s network namespace')
  stopSandbox()
} else {
  const failure = await runPasta(pasta, [...pastaArgs, String(child.pid)])
  if (failure === undefined) {
    released = true
    block.end('1')
  } else {
    console.error(`Ted couldn’t forward the App’s ports into its sandbox: ${failure}`)
    stopSandbox()
  }
}

function runPasta(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = ''
    const pastaChild = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-1000)
    }
    pastaChild.stdout.on('data', collect)
    pastaChild.stderr.on('data', collect)
    pastaChild.once('error', (error) => resolve(error.message))
    pastaChild.once('exit', (code, signal) => {
      if (code === 0) return resolve(undefined)
      const why = output.trim()
      resolve(
        why !== ''
          ? why
          : `pasta exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
      )
    })
  })
}
