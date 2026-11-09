import { appendFileSync } from 'node:fs'
import { isNewer, type MakeSource } from './updates.ts'

const loopbackFeed = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//

export function testFeedSource(
  feed: string,
  { current, log, exit }: { current: string; log: string; exit: () => void },
): MakeSource {
  if (!loopbackFeed.test(feed)) throw new Error('TED_UPDATE_FEED must be a loopback http URL')
  return (emit) => {
    let latest: { version: string; failInstall?: boolean } | undefined
    return {
      async check() {
        emit({ kind: 'checking' })
        try {
          const res = await fetch(new URL('latest.json', feed))
          if (!res.ok) throw new Error(`the test feed answered ${res.status}`)
          latest = (await res.json()) as { version: string; failInstall?: boolean }
        } catch (error) {
          emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          return
        }
        if (!isNewer(latest.version, current)) return emit({ kind: 'none' })
        emit({ kind: 'available', version: latest.version })
        emit({ kind: 'downloaded', version: latest.version })
      },
      install() {
        appendFileSync(log, `install ${latest?.version}\n`)
        if (latest?.failInstall)
          emit({ kind: 'error', message: 'the test feed failed the install' })
        else exit()
      },
    }
  }
}
