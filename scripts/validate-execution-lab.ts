import { parseArgs } from 'node:util'
import { redactSecrets } from '../packages/daemon/src/redact.ts'
import { readConfig } from './execution-lab/config.ts'
import { bootstrap, checkoutRoot, type LabOptions, runLab } from './execution-lab/runner.ts'

try {
  const { values } = parseArgs({
    options: {
      'opt-in': { type: 'boolean' },
      config: { type: 'string' },
      action: { type: 'string', default: 'acceptance' },
      scenario: { type: 'string', multiple: true },
      'run-id': { type: 'string' },
    },
  })
  if (!values['opt-in']) throw new Error('--opt-in required before reading configuration')
  if (!values.config) throw new Error('--config must explicitly name external lab configuration')
  if (values.action === 'bootstrap') {
    console.log(
      redactSecrets(JSON.stringify(await bootstrap(await readConfig(values.config, checkoutRoot)))),
    )
  } else {
    const actions = [
      'dry-run',
      'preflight',
      'acceptance',
      'deploy',
      'build',
      'probe',
      'start',
      'observe',
      'stop',
      'restart',
      'cleanup',
      'verify',
      'scenario',
      'connect',
      'disconnect',
    ]
    if (!actions.includes(values.action)) throw new Error('unknown lab action')
    const result = await runLab({
      optIn: true,
      configFile: values.config,
      root: checkoutRoot,
      action: values.action as LabOptions['action'],
      scenarios: values.scenario ?? [],
      ...(values['run-id'] ? { runId: values['run-id'] } : {}),
    })
    console.log(
      redactSecrets(
        JSON.stringify(
          result.directory
            ? { report: `${result.directory}/summary.md`, runId: result.runId, code: result.code }
            : result,
        ),
      ),
    )
    process.exitCode = result.code
  }
} catch (error) {
  console.error(redactSecrets(String(error)))
  process.exitCode = 1
}
