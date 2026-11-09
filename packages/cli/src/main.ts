#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { tedHome } from '@ted/protocol'
import { withDaemon } from './connect.ts'

const usage = `Usage:
  ted task create "<title>"   Create a Task
  ted task list               List Tasks`

function parse(): string[] | undefined {
  try {
    return parseArgs({ allowPositionals: true, strict: true }).positionals
  } catch {
    return undefined
  }
}

const [group, command, ...rest] = parse() ?? []
const home = tedHome()

try {
  if (group === 'task' && command === 'create' && rest.length > 0) {
    const task = await withDaemon(home, (client) => client.createTask({ title: rest.join(' ') }))
    console.log(`Created ${task.displayId}  ${task.title}`)
  } else if (group === 'task' && command === 'list' && rest.length === 0) {
    const tasks = await withDaemon(home, (client) => client.listTasks())
    console.log(
      tasks.length === 0
        ? 'No Tasks yet.'
        : tasks.map((t) => `${t.displayId}  ${t.title}`).join('\n'),
    )
  } else {
    console.error(usage)
    process.exitCode = 2
  }
} catch (error) {
  console.error(`ted: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
