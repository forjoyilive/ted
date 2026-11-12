import { parseArgs } from 'node:util'
import { watchExitWith } from '../exit-with.ts'
import { closeInheritedFds } from '../inherited-fds.ts'
import { redactSecrets } from '../redact.ts'
import { executionHome, serveExecution } from './service.ts'

closeInheritedFds()
delete process.env.ELECTRON_RUN_AS_NODE
try {
  const { values } = parseArgs({
    options: { owner: { type: 'string' }, 'no-resume': { type: 'boolean' } },
  })
  const service = await serveExecution(executionHome(), process.env, values.owner)
  const stop = () => {
    void service.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  watchExitWith(stop)
  if (!values['no-resume']) await service.worker.start()
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : 'Execution service failed'))
  process.exitCode = 1
}
