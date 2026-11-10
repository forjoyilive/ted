import { writeFileSync } from 'node:fs'
import http from 'node:http'

const port = Number(process.env.PORT)
const crashAfter = Number(process.env.STUB_APP_CRASH_AFTER_MS ?? '0')
const server = http.createServer((req, res) => {
  if (process.env.STUB_APP_BROWSER === '1') {
    const url = new URL(req.url ?? '/', 'http://localhost')
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
