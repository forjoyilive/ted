import net from 'node:net'

export async function createExecutionRelay(target: { address: string; port: number }) {
  let cut = false
  let dropResponses = false
  const counts = { connections: 0, droppedResponses: 0, refused: 0 }
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    if (cut) {
      counts.refused++
      client.destroy()
      return
    }
    counts.connections++
    const upstream = net.connect(target.port, target.address)
    let serverSpoke = false
    let requestSent = false
    let quiet: NodeJS.Timeout | undefined
    client.once('close', () => clearTimeout(quiet))
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => {
        sockets.delete(socket)
        client.destroy()
        upstream.destroy()
      })
    }
    client.on('data', (chunk) => {
      if (serverSpoke) requestSent = true
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      // TLS 1.3: the server's first flight ends the handshake; what it sends after the client
      // has spoken again is session tickets, then the HTTP response. The server keeps the
      // connection long enough to handle the request before both ends are closed.
      if (dropResponses && requestSent) {
        counts.droppedResponses++
        clearTimeout(quiet)
        quiet = setTimeout(() => {
          client.destroy()
          upstream.destroy()
        }, 400)
        return
      }
      serverSpoke = true
      client.write(chunk)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, target.address, resolve)
  })
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('relay did not bind')
  return {
    port: bound.port,
    counts: () => ({ ...counts }),
    cut() {
      cut = true
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      cut = false
    },
    dropResponses(value: boolean) {
      dropResponses = value
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
export type ExecutionRelay = Awaited<ReturnType<typeof createExecutionRelay>>
