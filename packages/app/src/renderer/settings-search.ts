import { foldText, matchesTerms, searchTerms } from '@ted/protocol/search'
import { type SettingsSectionId, shownSettingsSectionIds } from './navigation.ts'
import { reportingHelp, reportingLabel } from './reporting.ts'

export const settingsPageNames: Record<SettingsSectionId, string> = {
  general: 'General',
  notifications: 'Notifications',
  machines: 'Machines',
  agents: 'Providers',
  limits: 'Limits',
  integrations: 'Integrations',
  library: 'Library',
  storage: 'Storage',
  developer: 'Developer',
}

export const factorySections = [
  ['general', 'General'],
  ['intake', 'Intake'],
  ['repos', 'Repos'],
  ['workflow', 'Workflow'],
  ['checks', 'Checks'],
  ['cleanup', 'Cleanup'],
  ['agent-files', 'Agents'],
  ['agents', 'Providers'],
  ['permissions', 'Permissions'],
  ['notifications', 'Notifications'],
  ['notes', 'Factory notes'],
  ['danger-zone', 'Danger zone'],
] as const

const settingsPageAliases: Partial<Record<SettingsSectionId, string>> = { agents: 'agent' }

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
    help: 'Shown beside your comments. Ted keeps it on this computer only.',
  },
  'app.general.display': { name: 'Display', heading: true },
  'app.general.display.appearance': { name: 'Appearance' },
  'app.general.display.text-size': {
    name: 'Text size',
    detail: 'Changes text throughout Ted. Terminal font size is separate.',
  },
  'app.general.display.terminal-font-size': {
    name: 'Terminal font size',
    help: 'The size of text in terminals and logs, in points.',
  },
  'app.general.date-and-time': { name: 'Date and time', heading: true },
  'app.general.date-and-time.time-format': {
    name: 'Time format',
    detail: 'Used throughout Ted.',
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
    help: 'Carry started work through Merge without routine questions or sign-offs. It starts no Backlog Tasks; Backlog starts below does that. Task overrides take precedence. Enabling also handles waiting routine requests. Permissions, failed checks needing your decision, setup and Workflow safeguards, missing access or information, and size or split decisions still wait for you.',
    detail:
      'Stays on until you turn it off, on this computer only. Turning it off leaves started work running.',
  },
  'app.general.autopilot.unvetted': {
    name: 'Review Tasks from Automations and public issues',
    keywords: 'overnight mode review gate sign-off automation github issue outsider',
    help: 'While Autopilot is on, Tasks an Automation created and Tasks from a GitHub issue with text from outsiders still wait for your Review sign-off, and merge only the code you approved.',
  },
  'app.general.backlog-starts': {
    name: 'Backlog starts',
    keywords: 'auto start automatic backlog queue',
    heading: true,
  },
  'app.general.backlog-starts.enabled': {
    name: 'Start Backlog Tasks automatically',
    keywords: 'auto start automatic backlog queue',
    detail:
      'When a working-Run slot is free, start the next Backlog Task: highest Priority first, then the order in All Tasks. Skips blocked Tasks; Queued work goes first. Turning this off leaves started Tasks running.',
  },
  'app.general.backlog-starts.from': {
    name: 'Start from',
    keywords: 'auto start automatic backlog factories groups',
    detail:
      'Tick a group to include every Factory in it, now and later. A snoozed Task starts when its snooze ends, whichever Factories are ticked.',
  },
  'app.general.startup': { name: 'Startup and quitting', heading: true },
  'app.general.startup.login': {
    name: 'Start Ted in the background when you log in',
    help: 'Ted starts with no window, so notifications and Automations work. It keeps running until you choose Quit Ted completely.',
  },
  'app.general.startup.quit': {
    name: 'When you quit with work running',
    help: 'Work running means Runs going or Automations on. Keeping Ted running in the background lets them carry on with no window open.',
  },
  'app.general.startup.tray': {
    name: 'Show tray icon',
    help: 'Shows Ted’s waiting count and problems in the system tray. Some desktops, such as stock GNOME, don’t show tray icons.',
    platform: 'linux',
  },
  'app.general.startup.stay-awake': {
    name: 'Stay awake while Runs are working',
    help: 'Keeps this computer from going to sleep on its own while any Run is working. Automations don’t keep it awake.',
  },
  'app.general.privacy': { name: 'Privacy', heading: true },
  'app.general.privacy.reporting': {
    name: reportingLabel,
    keywords: 'telemetry crash error usage sentry diagnostics',
    help: reportingHelp,
  },
  'app.general.editor': { name: 'Editor and command line', heading: true },
  'app.general.editor.editor': {
    name: 'Editor',
    help: 'Open in editor opens the Task’s worktree, or a file at a line from a diff, in this editor. Ted lists the editors it finds on your login shell’s PATH.',
  },
  'app.general.editor.custom-command': { name: 'Custom command' },
  'app.general.editor.ted-command': {
    name: 'The ted command',
    help: 'Lets you use ted in any terminal. Runs always have it.',
  },
  'app.general.editor.path': {
    name: 'Add ~/.local/bin to your PATH',
    detail: 'Your login shell doesn’t look there yet. Add this line to your shell’s profile:',
  },
  'app.general.about': { name: 'About and updates', heading: true },
  'app.general.about.licenses': {
    name: 'Third-party licenses',
    help: 'The open-source code Ted is built from, and the license for each part.',
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
    name: 'Defaults for each role',
    keywords: 'Task Lead reviewer Planner Provider model effort',
    help: 'Saved in your Library’s workflow.yaml. A Factory can override each one in its own settings.',
    heading: true,
  },
  'app.agents.restart-idle-runs': {
    name: 'Restart idle Runs onto new Provider versions',
    help: 'When a Provider updates, Ted restarts each idle Run on the new version and resumes its conversation. Working Runs restart once they go idle.',
  },

  'app.limits.working-runs': {
    name: 'Max working Runs on this machine',
    help: 'A new Run starts only when a slot is free. Runs waiting on you, Paused Runs, Apps and checks don’t take a slot; a Task setting up its worktree does. A Factory’s own max_working_runs can lower it further.',
  },
  'app.limits.busy': {
    name: 'Wait to start new work when this computer is busy',
    help: 'While the CPU is busy or memory is low, Ted starts no new Run, sub-agent, simulator or emulator unless none is working, and scheduled checks wait. Work already running carries on. The limit above is still the most Ted runs at once.',
  },
  'app.limits.devices': {
    name: 'Simulators and emulators at once',
    help: 'iOS simulator and Android emulator Apps share these slots. When they’re all taken, Ted asks which simulator or emulator to shut down; it never shuts one down on its own to make room.',
  },
  'app.limits.build-one-device': {
    name: 'Build one simulator or emulator App at a time',
    help: 'The next App waits until the current one is built. Turn off when a Task needs an iOS and an Android device built at once.',
  },
  'app.limits.checks': {
    name: 'Checks running at once',
    help: 'A Task’s checks run one after another and count as one. When this many Tasks are running checks, the next waits its turn; a check you try with Run now in Factory settings waits too. Lowering the limit doesn’t stop checks that are running.',
  },
  'app.limits.check-cpus': {
    name: 'CPU a check may use',
    help: 'Ted tells each check how many of this computer’s cores it may use: this share of them, divided between the checks running at once, and never fewer than 1. A lower share leaves more room for Runs and makes checks slower.',
    detail:
      'Ted doesn’t enforce it. A check’s command has to pass the number, TED_CHECK_CPUS, to its test runner. Applies to checks started after you change it.',
  },
  'app.limits.scheduled-check-cpus': {
    name: 'Limit the CPU scheduled checks use too',
    help: 'When this is off, a scheduled check isn’t told a number and may use the whole computer. It finishes sooner, but new Runs may wait until it ends.',
  },
  'app.limits.sleep-idle': {
    name: 'End idle agents to free memory',
    help: 'An agent that is only waiting (a Task Lead, a sub-agent, or a Coordinator or planning chat) keeps itself and the tools it started in memory, about 1 GB each. With this on, Ted ends an idle agent and starts it again, in the same conversation, when there is something for it to do.',
    detail:
      'The first message after a wait takes a few seconds longer. Anything the agent left running in the background ends with it. While new work waits because the computer is busy, Ted ends idle agents after 2 minutes.',
  },
  'app.limits.sleep-idle-after': {
    name: 'End an agent after it has been idle for',
    help: 'How long an agent has done nothing before Ted ends it.',
  },
  'app.limits.low-priority': {
    name: 'Run agents and checks at low priority',
    help: 'For agents, checks, worktree setup and teardown, and Apps an agent starts. On macOS they run at the system’s “utility” priority, so they give way to your other apps and may run slower. On Linux they run at a lower scheduling priority. Apps you start with ▶ and Task shells keep normal priority.',
    detail:
      'Applies to work started after you change it. A Run that is already going keeps its priority.',
  },

  'app.integrations.github': {
    name: 'GitHub',
    help: 'Ted uses the GitHub CLI’s own login and never reads its token. One row for each host your Factories use.',
    heading: true,
  },
  'app.integrations.github.sync': {
    name: 'Keep issues up to date',
    help: 'When a Task comes from an issue in one of its Factory’s repos, Ted comments on the issue when work starts, links it from each pull request, and comments and closes it once every pull request merges. It writes as your GitHub account, so what it writes can be public. If someone closes the issue on GitHub, Ted archives a Task that hasn’t started, or asks you.',
    keywords: 'github issue sync close comment fixes',
  },
  'app.integrations.git': { name: 'Git', heading: true },
  'app.integrations.linear': {
    name: 'Linear',
    help: 'Ted uses the key to fill in a Task from a pasted Linear issue URL and to keep that issue’s status in step with the Task. It never gives the key to an agent.',
    heading: true,
  },
  'app.integrations.linear.key': {
    name: 'API key',
    help: 'A personal API key from Linear’s Settings → Security & access.',
  },
  'app.integrations.linear.sync': {
    name: 'Sync status with Linear',
    help: 'When a Task comes from a Linear issue, Ted moves the issue to In Progress when the Task starts, to In Review at the Review sign-off and to Done when it merges, and links the pull requests. If someone closes the issue in Linear, Ted archives a Task that hasn’t started, or asks you.',
  },
  'app.integrations.asana': {
    name: 'Asana',
    help: 'Connect one account for this installation to import Asana tasks and keep them in step through Task Sync. Agents never receive your credentials.',
    heading: true,
  },
  'app.integrations.asana.sync': {
    name: 'Task Sync',
    help: 'For each Task allowed to sync, Ted comments on its Asana task with each pull request it opens, and completes the Asana task once they all merge. When a task is completed in Asana, Ted archives its Task or asks you.',
  },

  'app.library.workflow': { name: 'Workflow', heading: true },
  'app.library.workflow.cleanup': {
    name: 'Cleanup',
    keywords: 'after merge stage',
    help: 'Turns Cleanup on for every Factory that doesn’t say otherwise. A Factory runs it only once it has at least one step, set in that Factory’s settings under Cleanup.',
  },
  'app.library.stage-files': { name: 'Stage files', heading: true },
  'app.library.agents': {
    name: 'Agents',
    keywords: 'coordinator planner chat powers instructions agents.yaml',
    help: 'Agents every Factory gets, saved in the Library’s agents.yaml and agents/. Override copies a built-in Agent into the Library.',
    heading: true,
  },
  'app.library.agents.new': {
    name: 'New Agent',
    keywords: 'add create custom agent blank',
  },

  'app.storage.space': { name: 'Space used', heading: true },
  'app.storage.worktrees': {
    name: 'Largest worktrees',
    help: 'The ten Task worktrees using the most space. A worktree is deleted when its Task is archived or done.',
    heading: true,
  },
  'app.storage.store': {
    name: 'Store and backups',
    help: 'The store holds every Task, comment and Run Ted knows about: the event log is its record of every change, and the state database is built from it. Backups are copies of the store.',
    heading: true,
  },
  'app.storage.store.event-log': { name: 'Event log' },
  'app.storage.store.state': { name: 'State database' },
  'app.storage.store.backups': { name: 'Backups' },
  'app.storage.clean-up': { name: 'Clean up', heading: true },
  'app.storage.clean-up.clones': { name: 'Remove clones of removed Factories' },
  'app.storage.clean-up.simulators': { name: 'Erase simulators not used by a running Task' },
  'app.storage.run-output': { name: 'Delete automatically', heading: true },
  'app.storage.run-output.days': {
    name: 'Delete agent chats',
    help: 'Only the chats go. The Task, its comments and its Task brief stay. Counted from when the Task is Done or archived, or for a chat with no Task, from when it ends.',
  },
  'app.storage.archived-tasks': {
    name: 'Delete archived Tasks',
    help: 'The whole Task goes, with its comments, Task brief and chats. Counted from when it was archived. Done Tasks that aren’t archived stay. This can’t be undone.',
  },
  'app.storage.archived-chats': {
    name: 'Delete archived Agent chats',
    help: 'Archived Coordinator and planning chats go with their conversations. Tasks they created stay. Counted from when the chat was archived. This can’t be undone.',
  },
  'app.storage.export': { name: 'Export a Factory', heading: true },
  'app.storage.export.factory': { name: 'Factory' },
  'app.storage.export.format': { name: 'Format' },
  'app.storage.export.save': {
    name: 'Tasks, comments, briefs and Run metadata',
    detail: 'Includes Done and archived Tasks, answers and saved versions.',
  },
  'app.storage.backups': { name: 'Backups', heading: true },

  'app.developer.mode': {
    name: 'Developer mode',
    help: 'Shows a compact CPU and memory readout at the bottom left of the main screen, with detailed Run and daemon process readings and logs here. Readings refresh every two seconds while visible.',
  },
  'app.developer.memory': {
    name: 'Ted’s memory use',
    help: 'Memory used by Ted and everything it started: the app, the daemon and Run hosts, the agents and the tools and MCP servers they run, checks and Apps. Refreshes every five seconds while this page is open.',
    keywords: 'RAM usage daemon app agents Run hosts',
  },
  'app.developer.folder': { name: 'Ted’s folder' },
  'app.developer.report': {
    name: 'Copy report',
    help: 'Copies Ted’s version, your Runs and the end of the daemon’s log to the clipboard, for you to paste into a bug report. Nothing is uploaded. Ted sends no telemetry.',
  },
  'app.developer.profile': {
    name: 'Record a CPU profile',
    keywords:
      'Records where Ted’s background process spends its time and saves a .cpuprofile file in Ted’s folder, under logs/profiles. Open it in Chrome DevTools or VS Code. The file lists Ted’s own functions and file paths, with no Task content, prompts or tokens. Ted keeps the newest five. Nothing is uploaded.',
  },
  'app.developer.onboarding': {
    name: 'Show onboarding again',
    detail:
      'Shows the first-launch steps from the start the next time Ted opens, and gives the next Factory added the setup guide. Factories, Tasks and settings stay as they are.',
    keywords: 'first launch welcome set up Ted reset guide',
  },
  'app.developer.diagnostics': { name: 'Diagnostics', heading: true },
  'app.developer.diagnostics.memory': {
    name: 'System memory usage',
    help: 'Memory in use across this computer, including other apps. This is separate from the memory used by Ted’s processes below.',
  },
  'app.developer.processes': {
    name: 'Processes',
    keywords: 'memory CPU PID Activity Monitor MCP servers agents checks Apps',
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
  'factory.intake': {
    name: 'Intake',
    detail: 'Choose which issues and tasks Automations can bring into this Factory.',
    heading: true,
  },
  'factory.intake.github': {
    name: 'GitHub intake',
    detail:
      'Choose which GitHub issues Automations can bring into this Factory: any open issue in its repos, or only issues with a label you name. Ted reads each issue itself and refuses the rest. Tasks you create yourself aren’t affected.',
    heading: true,
  },
  'factory.intake.github.scope': {
    name: 'Issues Automations can bring in',
    keywords: 'github issue label intake triage',
  },
  'factory.intake.linear': {
    name: 'Linear intake',
    detail:
      'Choose which Linear issues Automations can bring into this Factory. The built-in Linear Automation brings in issues assigned to you that haven’t started yet. Changes apply immediately to automatic intake. You can still paste any Linear issue into a new Task. Existing Tasks and status-sync consent stay as they are.',
    heading: true,
  },
  'factory.intake.linear.scope': { name: 'Scope', keywords: 'team project' },
  'factory.intake.asana': {
    name: 'Asana intake',
    detail:
      'Choose which Asana tasks Automations can bring into this Factory: one workspace, one project and, optionally, one section. Asana intake imports unfinished tasks assigned to you there, with the tasks under them, when its Automation runs.',
    heading: true,
  },
  'factory.intake.asana.scope': {
    name: 'Asana workspace, project and section',
    keywords: 'asana workspace project section intake',
  },
  'factory.repos': { name: 'Repos', heading: true },
  'factory.repos.base-branch': { name: 'Base branch' },
  'factory.repos.merge-method': { name: 'Merge method' },
  'factory.repos.pull-request-ci': {
    name: 'Pull request CI',
    help: 'Whether Ted waits for CI checks on this repo’s pull requests before it merges.',
    keywords: 'ci checks wait merge github actions',
  },
  'factory.repos.worktree': { name: 'Worktree', heading: true },
  'factory.repos.worktree.setup': {
    name: 'Setup command',
    help: 'Runs once in each new worktree, after copying files, before any Run uses it.',
  },
  'factory.repos.worktree.teardown': {
    name: 'Teardown command',
    help: 'Runs before Ted removes a worktree. If it fails, Ted logs it and removes the worktree anyway.',
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
  'factory.workflow.cleanup': {
    name: 'Cleanup',
    keywords: 'after merge stage steps',
    help: 'The Stage between Merge and Done. Turn it on here; its steps are under Cleanup. It runs only once it has at least one step.',
  },
  'factory.workflow.p1-only': {
    name: 'Send back only for P1 findings',
    help: 'Off: every blocking finding sends the Task back to Work. From a round: in that round of Validate and every later one, a new finding sends it back only if it is P1. P1 means lost or corrupted data, a security hole, or broken behaviour the Task asks for. A finding from an earlier round that is still not fixed sends it back too. Every other new finding stays unfixed and is listed as a note for you at Review. You get fewer rounds, and problems Validate found can merge if you approve without reading the notes.',
  },
  'factory.workflow.validate-sub-agents': {
    name: 'Other sub-agents in Validate',
    help: 'Off: in Validate the Task Lead can start only Ted’s reviewer, one per visit. On: it can also start other sub-agents, for example to run slow tests. Each one takes a working Run, and a sub-agent that reviews the diff adds findings that can cost another round. The one-reviewer rule stays either way.',
  },
  'factory.workflow.lead-closes-failures': {
    name: 'Task Lead closes its own fixed failures',
    help: 'Off: when a test the Task Lead ran itself failed outside Validate and it recorded the failure, only you can close it, from a question in your Inbox. On: once the Task Lead runs the test again and it passes, it closes the failure itself with that evidence, and you get a line in the thread and no question. Ted doesn’t run the test, so you are trusting the Task Lead’s report. Failed checks and failures found in Validate still need your decision, and only you can accept a failure that still happens.',
  },
  'factory.workflow.commit-titles': {
    name: 'Task Lead writes the merge commit',
    help: 'On: at Merge the Task Lead gives each pull request a Conventional Commits title, such as “fix(app): keep the sidebar open (TED-12)”, and a short description. Ted uses them as the merge commit’s subject and body. If the Task Lead writes none, Ted keeps the Task’s title and GitHub’s own merge message. Off: Ted keeps the Task’s title and GitHub’s merge message.',
  },
  'factory.checks': {
    name: 'Checks',
    help: 'Commands Ted runs at Validate, one after another, before the agent’s own checks. Run now tries one on the base branch in a scratch worktree.',
    heading: true,
  },
  'factory.agent-files': {
    name: 'Agents',
    keywords: 'coordinator planner chat powers instructions agents.yaml',
    help: 'The Agents you can start chats with in this Factory, saved in .ted/agents.yaml and .ted/agents/. Override copies an inherited Agent into .ted/ for this Factory.',
    heading: true,
  },
  'factory.agent-files.new': {
    name: 'New Agent',
    keywords: 'add create custom agent blank',
  },
  'factory.agents': {
    name: 'Providers',
    help: 'Which Provider, model and effort each role uses in this Factory. Rows marked Default or Library are inherited; Override sets them here.',
    heading: true,
  },
  'factory.permissions': {
    name: 'Permission mode',
    keywords: 'auto bypass',
    help: 'Permission mode is saved only on this computer, separately for each Factory.',
    detail:
      'Saved here immediately. Applies to new and restarted Task Leads, sub-agents and reviewers, and new checks and agent-started Apps. Running processes keep their current permissions; stop them to end existing access. Planning, Automation and Coordinator Runs always use Auto.',
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
    help: 'Steps that run after a Task’s pull requests merge and before it moves to Done. Ted runs the command steps itself, then the Task Lead does the instruction steps.',
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
      place.kind === 'app' ? settingsPageAliases[place.section as SettingsSectionId] : undefined,
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
