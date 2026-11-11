#!/usr/bin/env node
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  console.log('1.5.6')
  process.exit(0)
}
if (process.argv.includes('--help')) {
  console.log('Start the Agent Client Protocol (ACP) stdio server')
  process.exit(0)
}
const send = (value: unknown) =>
  console.log(JSON.stringify({ jsonrpc: '2.0', ...(value as object) }))
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
          authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
        }
      : message.method === 'session/new'
        ? { sessionId: 'stub-session', configOptions: [] }
        : message.method === 'session/prompt'
          ? { stopReason: 'end_turn' }
          : {}
  if (message.id !== undefined && message.method !== undefined) send({ id: message.id, result })
}
