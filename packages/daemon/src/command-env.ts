const agentCredentials = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]

export function worktreeCommandEnv(
  repoEnv: Record<string, string>,
  set: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(base).filter(([name]) => {
      const upper = name.toUpperCase()
      return (
        !upper.startsWith('TED_') &&
        upper !== 'ELECTRON_RUN_AS_NODE' &&
        !agentCredentials.includes(upper)
      )
    }),
  )
  return { ...inherited, ...repoEnv, ...set }
}
