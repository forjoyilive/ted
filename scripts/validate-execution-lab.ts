import { redactSecrets } from '../packages/daemon/src/redact.ts'
import { validationCli } from './validate-execution.ts'

try {
  process.exitCode = await validationCli(process.argv.slice(2), true)
} catch (error) {
  console.error(redactSecrets(String(error)))
  process.exitCode = 1
}
