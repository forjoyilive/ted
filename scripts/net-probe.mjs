import { createServer, get } from 'node:http'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'

const outside = await new Promise((resolve) => {
  const socket = connect(443, '192.0.2.1')
  socket.setTimeout(5000, () => { socket.destroy(); resolve('timed out (not refused)') })
  socket.on('connect', () => { socket.destroy(); resolve('CONNECTED (sandbox did not refuse)') })
  socket.on('error', (error) => resolve(`${error.code}: ${error.message}`))
})
console.log(`probe: outside connect to 192.0.2.1:443 -> ${outside}`)

const dns = await lookup('registry.npmjs.org').then((a) => `resolved ${a.address}`, (e) => `${e.code}: ${e.message}`)
console.log(`probe: DNS lookup registry.npmjs.org -> ${dns}`)

const server = createServer((_, res) => res.end('hello from localhost'))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const local = await new Promise((resolve) => {
  get(`http://127.0.0.1:${port}/`, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve(`HTTP ${res.statusCode} "${body}"`))
  }).on('error', (e) => resolve(`${e.code}: ${e.message}`))
})
server.close()
console.log(`probe: localhost fetch from 127.0.0.1:${port} -> ${local}`)
console.log('probe: failing on purpose so the log is kept (TED-770)')
process.exit(1)
