import type { JsonObject } from '@ted/protocol/parse'

export interface LinearComment {
  id: string
  body: string
  createdAt: string
  parentId?: string | null
  user?: { name?: string | null } | null
  externalUser?: { name?: string | null } | null
  botActor?: { name?: string | null } | null
}

interface CommentPage {
  comments: {
    nodes: LinearComment[]
    pageInfo: { hasNextPage: boolean; endCursor?: string | null }
  }
}

type Query = <T>(text: string, variables: JsonObject) => Promise<T>

const maxComments = 100
const maxCharacters = 40_000
const pageSize = 50
const commentQuery = `query TedIssueComments($id: ID!, $after: String) {
  comments(filter: { issue: { id: { eq: $id } } }, first: 50, after: $after, orderBy: createdAt) {
    nodes { id body createdAt parentId user { name } externalUser { name } botActor { name } }
    pageInfo { hasNextPage endCursor }
  }
}`

export async function fetchDiscussion(
  query: Query,
  issueId: string,
): Promise<{ text?: string; warning?: string }> {
  const comments = new Map<string, LinearComment>()
  const cursors = new Set<string>()
  let after: string | undefined
  let warning: string | undefined
  try {
    for (let page = 0; page < maxComments / pageSize; page++) {
      const data = await query<CommentPage>(commentQuery, { id: issueId, after })
      const connection = data.comments
      if (!Array.isArray(connection?.nodes) || !connection.pageInfo) {
        throw new Error('Missing comment page')
      }
      for (const comment of connection.nodes.slice(0, pageSize)) {
        if (
          typeof comment?.id !== 'string' ||
          typeof comment.body !== 'string' ||
          typeof comment.createdAt !== 'string'
        ) {
          warning = 'Some Linear comments could not be read.'
          continue
        }
        comments.set(comment.id, comment)
      }
      if (!connection.pageInfo.hasNextPage) break
      if (page === maxComments / pageSize - 1) {
        warning = `Older comments may be omitted. TED imports at most ${maxComments} comments and replies.`
      }
      const cursor = connection.pageInfo.endCursor
      if (!cursor || cursors.has(cursor)) throw new Error('Missing comment cursor')
      cursors.add(cursor)
      after = cursor
    }
  } catch {
    warning = 'TED couldn’t fetch all Linear comments. The discussion may be incomplete.'
  }

  const newest = [...comments.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  )
  const retained: string[] = []
  let remaining = maxCharacters
  for (const comment of newest) {
    const author = oneLine(
      comment.user?.name ??
        comment.externalUser?.name ??
        comment.botActor?.name ??
        'Unknown author',
    )
    const header = `### Comment ${oneLine(comment.id)} · ${author} · ${oneLine(comment.createdAt)}`
    const parent = comment.parentId ? `\nReply to comment ${oneLine(comment.parentId)}.` : ''
    const text = `${header}${parent}\n\n${comment.body}`
    const separator = retained.length === 0 ? 0 : 2
    if (text.length + separator > remaining) {
      warning = `Some discussion was omitted or shortened. TED imports at most ${maxCharacters.toLocaleString('en-US')} characters of discussion.`
      const available = remaining - separator
      const marker = '\n[Comment shortened by TED]'
      if (available > header.length + parent.length + marker.length + 2) {
        retained.push(text.slice(0, available - marker.length) + marker)
      }
      break
    }
    retained.push(text)
    remaining -= text.length + separator
  }
  if (retained.length === 0 && !warning) return {}
  return {
    text: [
      '## Linear discussion',
      ...(warning ? [`[${warning}]`] : []),
      ...retained.reverse(),
    ].join('\n\n'),
    ...(warning && { warning }),
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}
