import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

export const loadWorkerCount = (cpus: number) => Math.ceil(cpus / 2)

export async function startLoad(count = loadWorkerCount(availableParallelism())) {
  const workers: Worker[] = []
  let stopping = false
  const stop = async () => {
    stopping = true
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
  let rejectFailure: (error: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  void failed.catch(() => {})
  try {
    await Promise.race([
      Promise.all(
        Array.from(
          { length: count },
          () =>
            new Promise<void>((resolve, reject) => {
              const worker = new Worker(
                `const { parentPort } = require('node:worker_threads')
               parentPort.postMessage('ready')
               let n = 1
               for (;;) { n = Math.sqrt(n + 1); if (n > 10) n = 1 }`,
                { eval: true },
              )
              workers.push(worker)
              worker.once('message', () => resolve())
              worker.once('error', (error) => {
                reject(error)
                rejectFailure(error)
              })
              worker.once('exit', (code) => {
                if (!stopping) rejectFailure(new Error(`CPU workload worker exited (${code})`))
              })
            }),
        ),
      ),
      failed,
    ])
    return { stop, failed }
  } catch (error) {
    await stop()
    throw error
  }
}

if (import.meta.main) {
  const count = Number(process.argv[2])
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Expected a positive worker count')
  const load = await startLoad(count)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await load.stop()
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  console.log('READY')
  await load.failed
}
