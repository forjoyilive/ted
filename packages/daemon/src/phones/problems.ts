import {
  type Banner,
  bannerOrder,
  type DaemonEvent,
  type PhoneProblem,
  type PhoneProblemsBody,
  phoneProblemFactoryMax,
  phoneProblemsMax,
  phoneProblemTextMax,
  phoneReplyBodyMax,
} from '@ted/protocol'
import { redactSecrets } from '../redact.ts'

export interface PhoneProblemSource {
  banners(): Banner[]
  factoryName(factoryId: string): string | undefined
  subscribe(listener: (event: DaemonEvent) => void): () => void
}

export const everyFactoryTitle = 'Ted'

function cutChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

export function stopsWork(source: Pick<PhoneProblemSource, 'banners'>): Banner[] {
  return source.banners().filter((banner) => banner.severity === 'stops-work')
}

export function phoneProblems(
  source: Pick<PhoneProblemSource, 'banners' | 'factoryName'>,
): PhoneProblemsBody {
  const problems: PhoneProblem[] = []
  for (const banner of stopsWork(source).sort(bannerOrder).slice(0, phoneProblemsMax)) {
    const factory =
      banner.factoryId === undefined ? undefined : source.factoryName(banner.factoryId)
    const problem: PhoneProblem = {
      id: banner.id,
      ...(banner.factoryId !== undefined && {
        factory: cutChars(factory ?? 'A removed Factory', phoneProblemFactoryMax),
      }),
      text: cutChars(redactSecrets(banner.text), phoneProblemTextMax),
      raisedAt: banner.raisedAt,
    }
    if (jsonBytes({ problems: [...problems, problem] }) > phoneReplyBodyMax) break
    problems.push(problem)
  }
  return { problems }
}

function jsonBytes(body: PhoneProblemsBody): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}

export function problemNotificationKey(banner: Pick<Banner, 'id'>): string {
  return `problem:${banner.id}`
}
