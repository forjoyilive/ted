import { createServer } from 'node:net'

const server = createServer((socket) => {
  socket.resetAndDestroy()
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address && typeof address === 'object') process.stdout.write(`${address.port}\n`)
})
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
