import { tedPaths } from '@ted/protocol'
import type { Json } from '@ted/protocol/parse'
import { expect } from 'vitest'
import { loadRunTokens } from '../../src/run-token.ts'
import { api } from '../helpers.ts'
import { ctx } from '../merge-harness.ts'

export async function leadFor(taskId: string, runId: string) {
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(runId))
  const post = async <T>(suffix: string, body: Json = {}): Promise<T> => {
    const response = await lead.call('POST', `/tasks/${taskId}${suffix}`, body)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
    return response.body as T
  }
  return { lead, post }
}
