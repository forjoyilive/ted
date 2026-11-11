import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import type { Duplex } from 'node:stream'

const port = Number(process.env.PORT)
const crashAfter = Number(process.env.STUB_APP_CRASH_AFTER_MS ?? '0')
const workerSockets = new Set<Duplex>()
let workerMessages = 0
const server = http.createServer((req, res) => {
  if (process.env.STUB_APP_BROWSER === '1') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/browser-service-worker.js') {
      res.setHeader('content-type', 'text/javascript')
      res.end(`self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', e => e.waitUntil(clients.claim()));
        self.addEventListener('message', e => e.waitUntil(new Promise(resolve => {
          const socket = new WebSocket('ws://' + self.location.host + '/browser-worker-socket');
          let timer;
          socket.onopen = () => { socket.send('started'); timer = setInterval(() => socket.send('tick'), 50); };
          socket.onclose = () => { clearInterval(timer); resolve(); };
        })));`)
      return
    }
    if (url.pathname === '/browser-worker-traffic') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages: workerMessages, connections: workerSockets.size }))
      return
    }
    if (url.pathname === '/browser-worker.js') {
      res.setHeader('content-type', 'text/javascript')
      const port = Number(url.searchParams.get('port'))
      res.end(
        `const transport = new WebTransport('https://127.0.0.1:${port}/'); transport.closed.catch(()=>{}); transport.ready.then(()=>postMessage('connected'),()=>postMessage('blocked'));`,
      )
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(
      `<!doctype html><title>Browser fixture</title><h1>Project</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector('h1').textContent='Clicked'">Try it</button><input type="file"><script>globalThis.rtcAtLoad=typeof RTCPeerConnection;document.cookie='taskSession=yes';</script>`,
    )
    return
  }
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      pid: process.pid,
      port: process.env.PORT,
      greeting: process.env.GREETING,
      apiUrl: process.env.API_URL,
      webPort: process.env.TED_APP_WEB_PORT,
      task: process.env.TED_TASK,
      run: process.env.TED_RUN ?? null,
      home: process.env.TED_HOME ?? null,
    }),
  )
})
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (process.env.STUB_APP_BROWSER !== '1' || req.url !== '/browser-worker-socket' || !key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  workerSockets.add(socket)
  socket.on('data', (data: Buffer) => {
    const opcode = (data[0] ?? 0) & 15
    if (opcode === 1) workerMessages++
    else if (opcode === 8) socket.end(Buffer.from([0x88, 0]))
  })
  socket.on('close', () => workerSockets.delete(socket))
  socket.on('error', () => socket.destroy())
})
server.listen(port, '127.0.0.1', () => console.log(`stub app listening on ${port}`))
for (const file of (process.env.STUB_APP_TOUCH ?? '').split(':').filter(Boolean)) {
  try {
    writeFileSync(file, '')
    console.log(`wrote ${file}`)
  } catch {
    console.log(`refused ${file}`)
  }
}
const lines = Number(process.env.STUB_APP_LINES ?? '0')
for (let n = 1; n <= lines; n++) console.log(`line ${String(n).padStart(5, '0')}`)
if (crashAfter > 0) {
  setTimeout(() => {
    console.error('stub app is crashing')
    process.exit(3)
  }, crashAfter)
}
