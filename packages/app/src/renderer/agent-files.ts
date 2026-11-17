import {
  type AgentCommand,
  type AgentFileChange,
  type AgentFileRow,
  type AgentSettingsInput,
  blankAgentInstructions,
  isAgentId,
  maxAgentCommandLength,
  maxAgentCommands,
  maxAgentId,
  maxAgentName,
} from '@ted/protocol/agent-files'
import { maxOutsideCommands, outsideCommandWords } from '@ted/protocol/outside-command'
import type { AgentKind } from '@ted/protocol/run'

export interface AgentDraft {
  id: string
  added?: true
  settings: AgentSettingsInput | null
  instructions: string | null
}

export function agentDrafts(rows: readonly AgentFileRow[]): AgentDraft[] {
  return rows.flatMap((row) =>
    row.own
      ? [
          {
            id: row.id,
            settings: row.own.settings ? { ...row.own.settings } : null,
            instructions: row.own.instructions ?? null,
          },
        ]
      : [],
  )
}

function settingsKey(settings: AgentSettingsInput | null): string {
  if (!settings) return 'null'
  const name = settings.name?.trim()
  const description = settings.description?.trim()
  const model = settings.model?.trim()
  return JSON.stringify({
    name: name || undefined,
    description: description || undefined,
    agent: settings.agent,
    model: model || undefined,
    powers: settings.powers,
    commands: settings.commands && cleanCommands(settings.commands),
    outsideCommands: settings.outsideCommands && cleanCommands(settings.outsideCommands),
  })
}

function cleanCommands(commands: readonly AgentCommand[]): AgentCommand[] {
  return commands.flatMap((c) => {
    const name = c.name.trim()
    const command = c.command.trim()
    if (name === '' && command === '') return []
    return [{ name, command, ...(c.repo !== undefined && { repo: c.repo }) }]
  })
}

function cleanSettings(settings: AgentSettingsInput | null): AgentSettingsInput | null {
  if (!settings) return null
  const name = settings.name?.trim()
  const description = settings.description?.trim()
  const model = settings.model?.trim()
  return {
    ...(name && { name }),
    ...(description && { description }),
    ...(settings.agent && { agent: settings.agent }),
    ...(model && { model }),
    ...(settings.powers && { powers: settings.powers }),
    ...(settings.commands && { commands: cleanCommands(settings.commands) }),
    ...(settings.outsideCommands && {
      outsideCommands: cleanCommands(settings.outsideCommands),
    }),
  }
}

export function agentChanges(
  draft: readonly AgentDraft[],
  loaded: readonly AgentDraft[],
): AgentFileChange[] {
  const changes: AgentFileChange[] = []
  for (const agent of draft) {
    const before = loaded.find((a) => a.id === agent.id)
    const change: AgentFileChange = { id: agent.id }
    if (settingsKey(agent.settings) !== settingsKey(before?.settings ?? null)) {
      change.settings = cleanSettings(agent.settings)
    }
    if (agent.instructions !== (before?.instructions ?? null)) {
      change.instructions = agent.instructions
    }
    if (change.settings !== undefined || change.instructions !== undefined) changes.push(change)
  }
  for (const agent of loaded) {
    if (!draft.some((a) => a.id === agent.id)) {
      changes.push({ id: agent.id, settings: null, instructions: null })
    }
  }
  return changes
}

export function agentFileEdited(
  draft: readonly AgentDraft[],
  loaded: readonly AgentDraft[],
  id: string,
): boolean {
  const now = draft.filter((a) => a.id === id)
  const before = loaded.filter((a) => a.id === id)
  return agentChanges(now, before).length > 0
}

export function agentChangedFiles(changes: readonly AgentFileChange[], folder: string): string[] {
  const files = new Set<string>()
  for (const change of changes) {
    if (change.settings !== undefined || change.instructions === null) {
      files.add(`${folder}agents.yaml`)
    }
    if (change.instructions !== undefined) files.add(`${folder}agents/${change.id}.md`)
  }
  return [...files]
}

export function overrideDraft(row: AgentFileRow): AgentDraft {
  return {
    id: row.id,
    settings: row.inherited ? { ...row.inherited.settings } : null,
    instructions: row.inherited?.instructions ?? '',
  }
}

export const agentRecipes = ['blank', 'release'] as const

export type AgentRecipe = (typeof agentRecipes)[number]

export const agentRecipeText: Readonly<Record<AgentRecipe, { name: string; help: string }>> = {
  blank: { name: 'Blank', help: 'No powers and an outline of the instructions to fill in.' },
  release: {
    name: 'Release',
    help: 'Drafts release notes, checks readiness, then runs your build and publish commands outside the sandbox, asking you between them. Write the build command so its argument can only be a version, never another action such as publish.',
  },
}

export const releaseRecipeInstructions = `# What this Agent is for

You release this repo: you build a new version on the user’s Mac, show them what is in it, and publish it only when they say so.

# How you work

1. Ask the user which version to release if they didn’t say.
2. In your copy of the code, read what merged since the last release tag (\`git describe --tags --abbrev=0\`, then \`git log --merges --first-parent <tag>..HEAD\`). Write a short draft of the release notes in the chat, grouped as Features, Fixes and Other, one line per change.
3. Check the code is ready with this Agent’s commands (\`ted agent run <name>\`). If one fails, show the user what failed and stop.
4. Build with \`ted agent run-outside build <version>\`, then end your turn and wait for Ted’s message with the output.
5. When the build passed, ask the user whether to publish, with Publish and Discard the build as choices, and end your turn.
6. Only when the user answers Publish, run \`ted agent run-outside publish\`. If they answer Discard the build, run \`ted agent run-outside discard\`. Never publish without their answer in this chat.
7. When a command fails, show the user the last lines of its output in plain words and ask what to do. Don’t run it again on your own.

# Rules

- Outside commands run on the user’s Mac, outside the sandbox, and can push and publish. Run only the ones this file names, only in this order, and only for the version the user gave.
- Never change files in the user’s folder yourself.
`

export function newAgentDraft(taken: readonly string[], recipe: AgentRecipe = 'blank'): AgentDraft {
  const wanted = recipe === 'release' ? 'release' : 'new-agent'
  let id = wanted
  for (let n = 2; taken.includes(id); n++) id = `${wanted}-${n}`
  if (recipe === 'release')
    return {
      id,
      added: true,
      settings: {
        name: 'Release',
        powers: ['ask', 'read_code', 'run_commands', 'run_outside'],
        commands: [{ name: 'check', command: '' }],
        outsideCommands: [
          { name: 'build', command: '' },
          { name: 'publish', command: '' },
          { name: 'discard', command: '' },
        ],
      },
      instructions: releaseRecipeInstructions,
    }
  return {
    id,
    added: true,
    settings: { name: '', powers: [] },
    instructions: blankAgentInstructions,
  }
}

export function agentIdFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxAgentId)
    .replace(/-+$/, '')
}

export function agentProblem(agent: AgentDraft, taken: readonly string[]): string | undefined {
  if (agent.added) {
    if (!isAgentId(agent.id)) {
      return `The id must be lowercase letters, digits and hyphens, up to ${maxAgentId} characters.`
    }
    if (taken.includes(agent.id)) return `Another Agent already uses the id ${agent.id}.`
  }
  const name = agent.settings?.name?.trim() ?? ''
  if (agent.added && name === '') return 'Give the Agent a name.'
  if (name.length > maxAgentName) return `The name can be up to ${maxAgentName} characters.`
  if (agent.instructions !== null && agent.instructions.trim() === '') {
    return 'The instructions can’t be empty.'
  }
  return (
    commandsProblem(cleanCommands(agent.settings?.commands ?? [])) ??
    outsideCommandsProblem(cleanCommands(agent.settings?.outsideCommands ?? []))
  )
}

export function outsideCommandsProblem(commands: readonly AgentCommand[]): string | undefined {
  if (commands.length > maxOutsideCommands)
    return `An Agent can have up to ${maxOutsideCommands} outside commands.`
  const named = commandsProblem(commands, 'outside command')
  if (named !== undefined) return named
  for (const { name, command } of commands) {
    const words = outsideCommandWords(command)
    if ('problem' in words) return `The outside command ${name} ${words.problem}.`
  }
  return undefined
}

export function commandsProblem(
  commands: readonly AgentCommand[],
  what = 'command',
): string | undefined {
  if (commands.length > maxAgentCommands)
    return `An Agent can have up to ${maxAgentCommands} ${what}s.`
  const seen = new Set<string>()
  for (const { name, command } of commands) {
    if (!isAgentId(name)) {
      return `\`${name || '(no name)'}\` isn’t ${what === 'command' ? 'a' : 'an'} ${what} name. Use lowercase letters, digits and hyphens.`
    }
    if (seen.has(name)) return `Two ${what}s are named ${name}.`
    seen.add(name)
    if (command === '') return `Give the ${name} ${what} something to run.`
    if (command.length > maxAgentCommandLength) {
      return `The ${name} ${what} can be up to ${maxAgentCommandLength} characters.`
    }
  }
  return undefined
}

export interface ResolvedChoice {
  agent?: AgentKind
  model?: string
}

export function resolvedChoice(
  own: AgentSettingsInput | null | undefined,
  inherited: AgentSettingsInput | undefined,
): ResolvedChoice {
  const agent = own?.agent ?? inherited?.agent
  const keepsModel = own?.agent === undefined || own.agent === inherited?.agent
  const model = own?.model ?? (keepsModel ? inherited?.model : undefined)
  return { ...(agent !== undefined && { agent }), ...(model !== undefined && { model }) }
}
