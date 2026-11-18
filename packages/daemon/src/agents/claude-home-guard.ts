import { homedir } from 'node:os'
import { text } from 'node:stream/consumers'
import { homeGuardMessage, refusesUnsandboxedCommand } from '../protected-folders.ts'

const home = process.env.HOME?.startsWith('/') ? process.env.HOME : homedir()
if (refusesUnsandboxedCommand(await text(process.stdin), home)) {
  process.stderr.write(`${homeGuardMessage}\n`)
  process.exitCode = 2
}
