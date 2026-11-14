import { foldText, matchesTerms, searchTerms } from '@ted/protocol/search'
import { type SettingsSectionId, shownSettingsSectionIds } from './navigation.ts'

export const settingsPageNames: Record<SettingsSectionId, string> = {
  general: 'General',
  notifications: 'Notifications',
  machines: 'Machines',
  agents: 'Agents',
  limits: 'Limits',
  integrations: 'Integrations',
  library: 'Library',
  storage: 'Storage',
  developer: 'Developer',
}

export const factorySections = [
  ['general', 'General'],
  ['linear-intake', 'Linear intake'],
  ['asana-intake', 'Asana intake'],
  ['repos', 'Repos'],
  ['workflow', 'Workflow'],
  ['checks', 'Checks'],
  ['cleanup', 'Cleanup'],
  ['agents', 'Agents'],
  ['permissions', 'Permissions'],
  ['notifications', 'Notifications'],
  ['notes', 'Factory notes'],
  ['danger-zone', 'Danger zone'],
] as const

export type FactorySectionId = (typeof factorySections)[number][0]

export function factorySectionOf(id: SettingId): FactorySectionId {
  const section = id.split('.')[1]
  return factorySections.find(([key]) => key === section)?.[0] ?? 'general'
}

export type SettingsPlatform = 'mac' | 'linux' | 'other'

interface Entry {
  name: string
  keywords?: string
  help?: string
  detail?: string
  heading?: true
  platform?: SettingsPlatform
}

const entries = {
  'app.general.profile': { name: 'Profile', heading: true },
  'app.general.profile.picture': {
    name: 'Profile picture',
    help: 'Shown beside your Comments. TED keeps it on this computer only.',
  },
  'app.general.display': { name: 'Display', heading: true },
  'app.general.display.appearance': { name: 'Appearance' },
  'app.general.display.text-size': {
    name: 'Text size',
    detail: 'Changes text throughout TED. Terminal font size is separate.',
  },
  'app.general.display.terminal-font-size': {
    name: 'Terminal font size',
    help: 'The size of text in terminals and logs, in points.',
  },
  'app.general.date-and-time': { name: 'Date and time', heading: true },
  'app.general.date-and-time.time-format': {
    name: 'Time format',
    detail: 'Used throughout TED.',
  },
  'app.general.date-and-time.time-zone': {
    name: 'Time zone',
    detail: 'Used for displayed times and all Automation schedules.',
  },
  'app.general.date-and-time.current-time': { name: 'Current time' },
  'app.general.autopilot': { name: 'Autopilot', keywords: 'overnight mode', heading: true },
  'app.general.autopilot.mode': {
    name: 'Autopilot across all Factories',
    keywords: 'overnight mode',
    help: 'Carry started work through Merge without routine questions or sign-offs. It starts no Backlog Tasks; each Factory’s Start Backlog Tasks automatically setting does that. Task overrides take precedence. Enabling also handles waiting routine requests. Permissions, failed Checks needing your decision, setup and Workflow safeguards, missing access or information, and size or split decisions still wait for you.',
    detail:
      'Stays on until you turn it off, on this computer only. Turning it off leaves started work running.',
  },
  'app.general.startup': { name: 'Startup and quitting', heading: true },
  'app.general.startup.login': {
    name: 'Start TED in the background when you log in',
    help: 'TED starts with no window, so notifications and Automations work. It keeps running until you choose Quit TED completely.',
  },
  'app.general.startup.quit': {
    name: 'When you quit with work running',
    help: 'Work running means Runs going or Automations on. Keeping TED running in the background lets them carry on with no window open.',
  },
  'app.general.startup.tray': {
    name: 'Show tray icon',
    help: 'Shows TED’s waiting count and problems in the system tray. Some desktops, such as stock GNOME, don’t show tray icons.',
    platform: 'linux',
  },
  'app.general.startup.stay-awake': {
    name: 'Stay Awake while Runs are working',
    help: 'Keeps this computer from going to sleep on its own while any Run is working. Automations don’t keep it awake.',
  },
  'app.general.editor': { name: 'Editor and command line', heading: true },
  'app.general.editor.editor': {
    name: 'Editor',
    help: 'Open in editor opens the Task’s worktree, or a file at a line from a diff, in this editor. TED lists the editors it finds on your login shell’s PATH.',
  },
  'app.general.editor.custom-command': { name: 'Custom command' },
  'app.general.editor.ted-command': {
    name: 'The ted command',
    help: 'Lets you use ted in any terminal. Agents always have it in their Runs.',
  },
  'app.general.editor.path': {
    name: 'Add ~/.local/bin to your PATH',
    detail: 'Your login shell doesn’t look there yet. Add this line to your shell’s profile:',
  },
  'app.general.about': { name: 'About and updates', heading: true },
  'app.general.about.licenses': {
    name: 'Third-party licenses',
    help: 'The open-source code TED is built from, and the license for each part.',
  },

  'app.notifications.send': { name: 'Send a notification for', heading: true },
  'app.notifications.send.inbox': {
    name: 'Inbox items',
    help: 'One notification per new Inbox item: Failed Tasks, permission requests, sign-offs and the idle ask. Clicking it opens the Task.',
  },
  'app.notifications.send.problems': {
    name: 'Problems that stop work',
    help: 'One notification when such a problem starts, never when it clears. Warnings never notify. Clicking it opens the Settings section.',
  },
  'app.notifications.send.merged': {
    name: 'Task merged',
    help: 'One notification when a Task reaches Done. Clicking it opens the Task.',
  },
  'app.notifications.by-factory': {
    name: 'By Factory',
    keywords: 'factory inbox merged count badge',
    help: 'A notification is sent only when it is on above and ticked for the Factory. These are the same choices as Notifications in each Factory’s Settings. With Inbox items unticked, a Factory’s requests stay in the Inbox but leave its count and the Dock badge.',
    heading: true,
  },
  'app.notifications.sound': { name: 'Sound', heading: true },
  'app.notifications.sound.play': {
    name: 'Play a sound',
    help: 'Play the system sound with each notification.',
  },

  'app.machines.connect': { name: 'Connect another Mac', heading: true },
  'app.machines.connect.address': { name: 'This Mac’s local address' },
  'app.machines.connect.port': { name: 'Port' },
  'app.machines.execution': { name: 'Execution Macs', heading: true },

  'app.agents.defaults': {
    name: 'Defaults for all Factories',
    help: 'Saved in your Library’s workflow.yaml. A Factory can override each one in its own settings.',
    heading: true,
  },
  'app.agents.restart-idle-runs': {
    name: 'Restart idle Runs onto new agent versions',
    help: 'When an agent updates, TED restarts each idle Run on the new version and resumes its conversation. Working Runs restart once they go idle.',
  },

  'app.limits.working-runs': {
    name: 'Max working Runs on this machine',
    help: 'A new Run starts only when a slot is free. Runs waiting on you, Paused Runs, Apps and Checks don’t take a slot; a Task setting up its worktree does. A Factory’s own max_working_runs can lower it further.',
  },
  'app.limits.busy': {
    name: 'Start fewer Runs when this computer is busy',
    help: 'While this computer is busy, TED starts no new Run unless none is working. Runs already working carry on. The limit above is still the most TED runs at once.',
  },
  'app.limits.simulators': {
    name: 'Simulators booted at once',
    help: 'iOS simulator Apps share these slots. When they’re all taken, TED asks which simulator to shut down; it never shuts one down on its own to make room.',
    platform: 'mac',
  },
  'app.limits.emulators': {
    name: 'Android emulators running at once',
    help: 'Android emulator Apps share these slots, separately from iOS simulators. When they’re all taken, TED asks which emulator to shut down; it never shuts one down on its own to make room.',
  },
  'app.limits.checks': {
    name: 'Checks running at once',
    help: 'A Task’s Checks run one after another and count as one. When this many Tasks are running Checks, the next waits its turn; a Check you try with Run now in Factory settings waits too. Lowering the limit doesn’t stop Checks that are running.',
  },
  'app.limits.low-priority': {
    name: 'Run agents and Checks at low priority',
    help: 'For agents, Checks, worktree setup and teardown, and Apps an agent starts. On macOS they run at the system’s “utility” priority, so they give way to your other apps and may run slower. On Linux they run at a lower scheduling priority. Apps you start with ▶ and Task shells keep normal priority.',
    detail:
      'Applies to work started after you change it. A Run that is already going keeps its priority.',
  },

  'app.integrations.github': {
    name: 'GitHub',
    help: 'TED uses the GitHub CLI’s own login and never reads its token. One row for each host your Factories use.',
    heading: true,
  },
  'app.integrations.git': { name: 'Git', heading: true },
  'app.integrations.linear': {
    name: 'Linear',
    help: 'TED uses the key to fill in a Task from a pasted Linear issue URL and to keep that issue’s status in step with the Task. It never gives the key to an agent.',
    heading: true,
  },
  'app.integrations.linear.key': {
    name: 'API key',
    help: 'A personal API key from Linear’s Settings → Security & access.',
  },
  'app.integrations.linear.sync': {
    name: 'Sync status with Linear',
    help: 'When a Task comes from a Linear issue, TED moves the issue to In Progress when the Task starts, to In Review at the Review sign-off and to Done when it merges, and links the pull requests. If someone closes the issue in Linear, TED archives a Task that hasn’t started, or asks you.',
  },
  'app.integrations.asana': {
    name: 'Asana',
    help: 'Connect one account for this installation to import Asana tasks and keep them in step through Task Sync. Agents never receive your credentials.',
    heading: true,
  },
  'app.integrations.asana.sync': {
    name: 'Task Sync',
    help: 'For each Task allowed to sync, TED comments on its Asana task with each pull request it opens, and completes the Asana task once they all merge. When a task is completed in Asana, TED archives its Task or asks you.',
  },

  'app.library.workflow': { name: 'Workflow', heading: true },
  'app.library.stage-files': { name: 'Stage files', heading: true },

  'app.storage.space': { name: 'Space used', heading: true },
  'app.storage.worktrees': {
    name: 'Largest worktrees',
    help: 'The ten Task worktrees using the most space. A worktree is deleted when its Task is archived or done.',
    heading: true,
  },
  'app.storage.clean-up': { name: 'Clean up', heading: true },
  'app.storage.clean-up.clones': { name: 'Remove clones of removed Factories' },
  'app.storage.clean-up.simulators': { name: 'Erase simulators not used by a running Task' },
  'app.storage.run-output': { name: 'Run output', heading: true },
  'app.storage.run-output.days': {
    name: 'Keep Run output after a Task is done',
    help: 'A Run’s chat is kept for as long as its Task is open. TED deletes it this long after the Task is done or archived. A Run without a Task, such as a planning chat or an Automation Run, is deleted this long after it finishes.',
  },
  'app.storage.export': { name: 'Export a Factory', heading: true },
  'app.storage.export.factory': { name: 'Factory' },
  'app.storage.export.format': { name: 'Format' },
  'app.storage.export.save': {
    name: 'Tasks, Comments, briefs and Run metadata',
    detail: 'Includes Done and archived Tasks, answers and saved versions.',
  },
  'app.storage.backups': { name: 'Backups', heading: true },

  'app.developer.mode': {
    name: 'Developer mode',
    help: 'Shows a compact CPU and memory readout at the bottom left of the main screen, with detailed Run and daemon process readings and logs here. Readings refresh every two seconds while visible.',
  },
  'app.developer.folder': { name: 'TED’s folder' },
  'app.developer.report': {
    name: 'Copy report',
    help: 'Copies TED’s version, your Runs and the end of the daemon’s log to the clipboard, for you to paste into a bug report. Nothing is uploaded. TED sends no telemetry.',
  },
  'app.developer.profile': {
    name: 'Record a CPU profile',
    keywords:
      'Records where TED’s background process spends its time and saves a .cpuprofile file in TED’s folder, under logs/profiles. Open it in Chrome DevTools or VS Code. The file lists TED’s own functions and file paths, with no Task content, prompts or tokens. TED keeps the newest five. Nothing is uploaded.',
  },
  'app.developer.diagnostics': { name: 'Diagnostics', heading: true },
  'app.developer.diagnostics.memory': {
    name: 'System memory usage',
    help: 'Memory in use across this computer, including other apps. This is separate from the memory used by TED’s processes below.',
  },
  'app.developer.logs': { name: 'Log', keywords: 'logs daemon log raw output', heading: true },

  'factory.general': { name: 'General', heading: true },
  'factory.general.icon': {
    name: 'Icon',
    keywords: 'emoji image picture symbol colour color logo',
    help: 'Shown in the sidebar, the Inbox, ⌘K and Task details. An emoji also starts the Factory’s notifications.',
  },
  'factory.general.name': {
    name: 'Name',
    help: 'Shown in the sidebar and the Inbox. Task IDs don’t change.',
  },
  'factory.general.auto-start': {
    name: 'Start Backlog Tasks automatically',
    detail:
      'Start the next eligible Task when a working-Run slot is free. Uses Priority and manual order, skips blocked Tasks, and gives Queued work precedence. Takes effect immediately. Turning this off leaves started Tasks running.',
  },
  'factory.linear-intake': {
    name: 'Linear intake',
    detail:
      'Choose which Linear issues Automations can bring into this Factory. The built-in Linear Automation brings in issues assigned to you that haven’t started yet. Changes apply immediately to automatic intake. You can still paste any Linear issue into a new Task. Existing Tasks and status-sync consent stay as they are.',
    heading: true,
  },
  'factory.linear-intake.scope': { name: 'Scope', keywords: 'team project' },
  'factory.asana-intake': {
    name: 'Asana intake',
    detail:
      'Choose which Asana tasks Automations can bring into this Factory: one workspace, one project and, optionally, one section. Asana intake imports unfinished tasks assigned to you there, with the tasks under them, when its Automation runs.',
    heading: true,
  },
  'factory.asana-intake.scope': {
    name: 'Asana workspace, project and section',
    keywords: 'asana workspace project section intake',
  },
  'factory.repos': { name: 'Repos', heading: true },
  'factory.repos.base-branch': { name: 'Base branch' },
  'factory.repos.merge-method': { name: 'Merge method' },
  'factory.repos.worktree': { name: 'Worktree', heading: true },
  'factory.repos.worktree.setup': {
    name: 'Setup command',
    help: 'Runs once in each new worktree, after copying files, before any Run uses it.',
  },
  'factory.repos.worktree.teardown': {
    name: 'Teardown command',
    help: 'Runs before TED removes a worktree. If it fails, TED logs it and removes the worktree anyway.',
  },
  'factory.repos.env': {
    name: 'Environment variables',
    help: 'Committed to the repo, so no secrets. Put secrets in a file to copy.',
  },
  'factory.repos.copy': {
    name: 'Files to copy from the local folder',
    help: 'Untracked files such as .env, copied into each new worktree. Paths or globs.',
  },
  'factory.repos.apps': { name: 'Apps', heading: true },
  'factory.workflow': {
    name: 'Workflow',
    help: 'The Stages a Task moves through, saved in .ted/workflow.yaml. Stage files hold each Stage’s instructions; Override copies one into .ted/stages/ for this Factory. Task Lead effort applies at Stage entry unless the Task has its own effort.',
    heading: true,
  },
  'factory.workflow.p1-only': {
    name: 'Send back only for P1 Findings',
    help: 'Off: every blocking Finding sends the Task back to Work. From a round: in that round of Validate and every later one, a new Finding sends it back only if it is P1. P1 means lost or corrupted data, a security hole, or broken behaviour the Task asks for. A Finding from an earlier round that is still not fixed sends it back too. Every other new Finding stays unfixed and is listed as a note for you at Review. You get fewer rounds, and problems Validate found can merge if you approve without reading the notes.',
  },
  'factory.workflow.validate-sub-agents': {
    name: 'Other sub-agents in Validate',
    help: 'Off: in Validate the Task Lead can start only TED’s reviewer, one per visit. On: it can also start other sub-agents, for example to run slow tests. Each one takes a working Run, and a sub-agent that reviews the diff adds Findings that can cost another round. The one-reviewer rule stays either way.',
  },
  'factory.workflow.lead-closes-failures': {
    name: 'Task Lead closes its own fixed failures',
    help: 'Off: when a test the Task Lead ran itself failed outside Validate and it recorded the failure, only you can close it, from a question in your Inbox. On: once the Task Lead runs the test again and it passes, it closes the failure itself with that evidence, and you get a line in the thread and no question. TED doesn’t run the test, so you are trusting the Task Lead’s report. Failed Checks and failures found in Validate still need your decision, and only you can accept a failure that still happens.',
  },
  'factory.checks': {
    name: 'Checks',
    help: 'Commands TED runs at Validate, one after another, before the agent’s own checks. Run now tries one on the base branch in a scratch worktree.',
    heading: true,
  },
  'factory.agents': {
    name: 'Agents',
    help: 'Which agent, model and effort each role uses in this Factory. Rows marked Default or Library are inherited; Override sets them here.',
    heading: true,
  },
  'factory.permissions': {
    name: 'Permission mode',
    keywords: 'auto bypass',
    help: 'Permission mode is saved only on this computer, separately for each Factory.',
    detail:
      'Saved here immediately. Applies to new and restarted Task Leads, sub-agents and reviewers, and new Checks and agent-started Apps. Running processes keep their current permissions; stop them to end existing access. Planning, Automation and Coordinator Runs always use Auto.',
    heading: true,
  },
  'factory.permissions.working-run-limit': {
    name: 'Working Run limit',
    help: 'This Factory’s limit follows its Workflow.',
    heading: true,
  },
  'factory.notifications': {
    name: 'Notifications',
    keywords: 'inbox merged count badge',
    help: 'Which of this Factory’s events notify you. The same choices are in Settings → Notifications, under By Factory.',
    heading: true,
  },
  'factory.cleanup': {
    name: 'Cleanup',
    keywords: 'after merge steps commands',
    help: 'Steps that run after a Task’s pull requests merge and before it moves to Done. TED runs the command steps itself, then the Task Lead does the instruction steps.',
    heading: true,
  },
  'factory.cleanup.enabled': {
    name: 'Turn on Cleanup',
    keywords: 'after merge',
    help: 'Adds a Cleanup column between Merge and Done. Cleanup stays off until it has at least one step.',
  },
  'factory.notes': {
    name: 'Factory notes',
    help: 'Facts about the product, given to every Run in this Factory: how to run it, conventions, risky areas. Stage instructions belong in Stage files.',
    heading: true,
  },
  'factory.danger-zone': { name: 'Danger zone', heading: true },
  'factory.danger-zone.remove': {
    name: 'Remove Factory',
    help: 'Stops its Runs and deletes its Tasks and worktrees from this computer. Its .ted/ folder stays in the repo.',
  },
} as const satisfies Record<string, Entry>

export type SettingId = keyof typeof entries

export const settingIds = Object.keys(entries) as SettingId[]

export function settingEntry(id: SettingId): Entry {
  return entries[id]
}

export function parentSetting(id: string): SettingId | undefined {
  const parent = id.slice(0, id.lastIndexOf('.'))
  return parent in entries ? (parent as SettingId) : undefined
}

export type SettingTarget =
  | { kind: 'app'; section: SettingsSectionId }
  | { kind: 'factory'; factoryId: string; section: FactorySectionId }

export interface SettingHit {
  id: SettingId
  name: string
  where: string
  target: SettingTarget
}

interface Place {
  kind: 'app' | 'factory'
  page: string
  section: string
  group: string | undefined
  top: boolean
}

function placeOf(id: SettingId): Place {
  const [kind, section = '', ...rest] = id.split('.')
  const parent = rest.length > 1 ? parentSetting(id) : undefined
  return {
    kind: kind === 'app' ? 'app' : 'factory',
    section,
    page:
      kind === 'app'
        ? settingsPageNames[section as SettingsSectionId]
        : (factorySections.find(([key]) => key === section)?.[1] ?? ''),
    group: parent === undefined ? undefined : entries[parent].name,
    top: rest.length === 0,
  }
}

export function searchFactory<T extends { id: string }>(
  factories: readonly T[],
  currentId: string | undefined,
): T | undefined {
  return factories.find((factory) => factory.id === currentId) ?? factories[0]
}

export function platformOf(userAgent: string): SettingsPlatform {
  if (userAgent.includes('Mac')) return 'mac'
  if (userAgent.includes('Linux')) return 'linux'
  return 'other'
}

export function findSettings(
  query: string,
  options: {
    factory?: { id: string; name: string } | undefined
    platform: SettingsPlatform
    limit: number
  },
): SettingHit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const { factory } = options
  const found: { hit: SettingHit; rank: number }[] = []
  for (const id of settingIds) {
    const entry: Entry = entries[id]
    if (entry.platform !== undefined && entry.platform !== options.platform) continue
    const place = placeOf(id)
    if (place.kind === 'factory' && !factory) continue
    if (place.kind === 'app' && !shownSettingsSectionIds.some((shown) => shown === place.section))
      continue
    const text = [
      entry.name,
      entry.keywords,
      place.group,
      place.page,
      entry.help,
      entry.detail,
    ].join(' ')
    if (!matchesTerms(terms, text)) continue
    const inName = matchesTerms(terms, entry.name)
    const where =
      place.kind === 'app'
        ? `Settings › ${place.page}`
        : place.top
          ? `${factory?.name} › Settings`
          : `${factory?.name} › Settings › ${place.page}`
    found.push({
      rank: (inName ? 0 : 2) + (entry.heading ? 1 : 0),
      hit: {
        id,
        name: entry.name,
        where,
        target:
          place.kind === 'app'
            ? { kind: 'app', section: place.section as SettingsSectionId }
            : { kind: 'factory', factoryId: factory?.id ?? '', section: factorySectionOf(id) },
      },
    })
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .slice(0, options.limit)
    .map(({ hit }) => hit)
}

export function matchedParts(name: string, query: string): { text: string; matched: boolean }[] {
  const folded = foldText(name)
  if (folded.length !== name.length) return [{ text: name, matched: false }]
  const marks = new Array<boolean>(name.length).fill(false)
  for (const term of searchTerms(query)) {
    const at = folded.indexOf(term)
    if (at >= 0) marks.fill(true, at, at + term.length)
  }
  const parts: { text: string; matched: boolean }[] = []
  for (let i = 0; i < name.length; i++) {
    const matched = marks[i] === true
    const last = parts.at(-1)
    if (last && last.matched === matched) last.text += name[i]
    else parts.push({ text: name[i] ?? '', matched })
  }
  return parts
}
