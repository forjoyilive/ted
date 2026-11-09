import http from 'node:http'

const port = Number(process.env.PORT)
const crashAfter = Number(process.env.STUB_APP_CRASH_AFTER_MS ?? '0')
const server = http.createServer((_, res) => {
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
const lines = Number(process.env.STUB_APP_LINES ?? '0')
for (let n = 1; n <= lines; n++) console.log(`line ${String(n).padStart(5, '0')}`)
if (crashAfter > 0) {
  setTimeout(() => {
    console.error('stub app is crashing')
    process.exit(3)
  }, crashAfter)
}
