import { DaemonClient, DaemonUnreachableError } from '@ted/protocol'

const port = Number(process.argv[2])
const attempts = Number(process.argv[3])
const uncaught: string[] = []
process.on('uncaughtException', (error) => {
  uncaught.push(String(error))
})

const client = new DaemonClient({ port, token: 'token', pid: 0, version: '0' })
const failures = new Map<string, number>()
const pending: Promise<void>[] = []
for (let i = 0; i < attempts; i++) {
  pending.push(
    client.listTasks().then(
      () => {
        failures.set('resolved', (failures.get('resolved') ?? 0) + 1)
      },
      (error: unknown) => {
        const kind = error instanceof DaemonUnreachableError ? 'unreachable' : String(error)
        failures.set(kind, (failures.get(kind) ?? 0) + 1)
      },
    ),
  )
  for (let tick = 0; tick < 20; tick++) await null
  const until = Date.now() + 20
  while (Date.now() < until) {}
  await new Promise((resolve) => setTimeout(resolve, 1))
}
await Promise.all(pending)
process.stdout.write(`${JSON.stringify({ uncaught, failures: Object.fromEntries(failures) })}\n`)
