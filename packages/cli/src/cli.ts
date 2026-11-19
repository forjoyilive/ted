import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { withDaemon as connectDaemon } from '@ted/daemon/launch'
import { checkWorkflowPath, NothingToCheckError } from '@ted/daemon/workflow'
import {
  type AgentKind,
  type AgentStageId,
  type AutomationCardKind,
  type AutomationDraftRequest,
  agentKinds,
  type Banner,
  type BrowserRequest,
  type ClarifyDepth,
  type CleanupStepResult,
  type CoordinatorAction,
  type CoordinatorRemovalKind,
  type CoordinatorTaskQuery,
  cleanupStepResults,
  DaemonClient,
  DaemonUnreachableError,
  type DeclaredSendBackCause,
  type DesignFileInput,
  type DesignFileSpec,
  type DesignReviewInput,
  type DeviceAction,
  type DeviceRequest,
  declaredSendBackCauses,
  devicePoint,
  draftBody,
  type Effort,
  efforts,
  type Factory,
  type FindingSeverity,
  filterTedEnv,
  findingSeverities,
  type IntegrationRemedy,
  type IntegrationsHealth,
  isShowing,
  type LocalDesignReviewInput,
  minGhVersion,
  ownershipLine,
  parseAddFailureEvidenceRequest,
  parseAgentDraftInput,
  parseAsanaTaskUrl,
  parseAssessFailureRequest,
  parseAutomationDraftRequest,
  parseBrowserRequest,
  parseCoordinatorCreate,
  parseCoordinatorRemoval,
  parseCoordinatorTaskQuery,
  parseCoordinatorTransfer,
  parseDesignReviewInput,
  parseDeviceRequest,
  parseLinearUrl,
  parseLocalDesignReviewInput,
  parseProposalInput,
  parseRecordFailureRequest,
  parseRegisterTestInvocation,
  parseRoundInput,
  parseVerifyFailureRequest,
  type RepoSetupReport,
  RequestValidationError,
  type RoundInput,
  type RunWithConversation,
  readDaemonInfoFor,
  remoteExecutionOff,
  remoteExecutionOn,
  runOnlyBrowserActions,
  runTokenFrom,
  type SetTaskReposRequest,
  type StartAppRequest,
  type TaskLead,
  taskOnlyBrowserActions,
  tedEnv,
  tedHome,
  tedPaths,
  type ValidateJudgments,
} from '@ted/protocol'
import { executionCapacity, parseWorkerPairRequest } from '@ted/protocol/execution-pairing'
import { type Json, parseJson } from '@ted/protocol/parse'
import { matchReference, shortReference } from '@ted/protocol/reference'
import { agentKindList } from '@ted/protocol/run'
import { isCleanup } from '@ted/protocol/stage'
import { appWaitLine } from './app-wait.ts'
import { asanaImportedText, asanaIntakeText, asanaTreeText } from './asana.ts'
import { AutomationUsageError, automationCommand } from './automation.ts'
import {
  type HandlerName,
  helpText,
  type Options,
  parseInvocation,
  sandboxGroupsText,
  UsageError,
} from './commands.ts'
import { exportCommand } from './export.ts'
import { githubIntakeText } from './github-intake.ts'
import { linearIntakeText } from './linear.ts'
import { formatMemoryUse } from './memory.ts'
import { formatSlowMoments } from './slow.ts'

export interface CliRuntime {
  home?: string
  env?: NodeJS.ProcessEnv
  stdin?: () => Promise<string>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  connect?: typeof connectDaemon
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env
  const home = runtime.home ?? tedHome()
  const withDaemon = runtime.connect ?? connectDaemon
  const write =
    runtime.stdout ??
    ((text: string) => {
      process.stdout.write(text)
    })
  const console = {
    log: (text: string) => write(`${text}\n`),
    error: (text: string) =>
      (
        runtime.stderr ??
        ((value: string) => {
          process.stderr.write(value)
        })
      )(`${text}\n`),
  }
  let exitCode = 0
  let options: Options = {}
  let args: string[] = []
  function taskRef(given?: string): string {
    const ref = given ?? options.task ?? tedEnv('TED_TASK', env)
    if (!ref) throw new UsageError('outside a Run, name the Task with --task <id>')
    return ref
  }
  function severalAllowed(choices: readonly string[]): { multiple?: true } {
    if (!options.multiple) return {}
    if (choices.length < 2) throw new UsageError('--multiple needs at least two --choice answers')
    return { multiple: true }
  }

  async function readStdin(): Promise<string> {
    if (runtime.stdin) return runtime.stdin()
    if (process.stdin.isTTY) return ''
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text
  }

  const mediaTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
  }

  function mediaTypeOf(file: string): string {
    return mediaTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  }

  async function fileContents(file: string) {
    return {
      name: path.basename(file),
      mediaType: mediaTypeOf(file),
      bytes: new Uint8Array(await readFile(file)),
    }
  }

  const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

  async function taskRepos(action: 'set' | 'add' | 'remove', names: string[]): Promise<void> {
    const ref = taskRef()
    const confirm = options.yes === true
    const request: SetTaskReposRequest =
      action === 'set'
        ? { set: names, confirm }
        : action === 'add'
          ? { add: names }
          : { remove: names, confirm }
    const { changed, setups } = await withDaemon(home, async (client) => {
      const changed = await client.setTaskRepos(ref, request)
      const setups: RepoSetupReport[] = []
      if (changed.confirm) return { changed, setups }
      for (const name of changed.added) {
        for (;;) {
          const report = await client.repoSetup(ref, name)
          if (report.state !== 'running') {
            setups.push(report)
            break
          }
          await sleep(500)
        }
      }
      return { changed, setups }
    })
    if (changed.confirm) {
      for (const { name, commits } of changed.confirm) {
        console.error(
          `ted: ${printable(name)}’s worktree has ${commits} ${commits === 1 ? 'commit' : 'commits'} that would be lost. Ask the human first; if they agree, run the command again with --yes.`,
        )
      }
      exitCode = 1
      return
    }
    for (const report of setups) console.log(printable(addedLine(report)))
    for (const name of changed.removed) {
      console.log(`Removed ${printable(name)}; its worktree is gone.`)
    }
    console.log(`${changed.task.displayId}’s repos: ${changed.repos.map(printable).join(', ')}`)
  }

  function addedLine(report: RepoSetupReport): string {
    if (report.worktree === undefined) {
      return `Added ${report.name}. Ted makes its worktree when the Task starts.`
    }
    const added = `Added ${report.name} at ${report.worktree}.`
    if (report.state === 'none' || report.command === undefined) return added
    const how =
      report.state === 'passed'
        ? 'passed'
        : report.state === 'timed-out'
          ? 'timed out'
          : `failed${report.exitCode !== undefined ? ` with exit code ${report.exitCode}` : ''}`
    const output = report.output.trimEnd()
    return [
      `${added} Its setup, \`${report.command}\`, ${how}.`,
      ...(output === '' ? [] : ['Setup output:', output]),
    ].join('\n')
  }

  function judgments(): ValidateJudgments | undefined {
    const one = (name: 'review' | 'visual') => {
      const result = options[name]
      const notes = options[`${name}-notes`]
      if (result === undefined && notes === undefined) return undefined
      if (result !== undefined && result !== 'pass' && result !== 'fail') {
        throw new UsageError(`--${name} must be pass or fail`)
      }
      const count = notes === undefined ? undefined : Number(notes)
      if (count !== undefined && !(Number.isInteger(count) && count >= 0)) {
        throw new UsageError(
          `--${name}-notes takes the number of notes, such as --${name}-notes 2, not their text`,
        )
      }
      return { passed: result !== 'fail', ...(count !== undefined && { notes: count }) }
    }
    const review = one('review')
    const visual = one('visual')
    if (!review && !visual) return undefined
    return { ...(review && { review }), ...(visual && { visual }) }
  }

  async function startSubAgent(): Promise<void> {
    const ref = taskRef()
    const { agent, model, effort, name } = options
    const file = options['prompt-file']
    if (file === undefined)
      throw new UsageError('give the sub-agent’s instructions with --prompt-file <file>')
    if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
      throw new UsageError(`--provider must be ${agentKindList}`)
    }
    if (effort !== undefined && !efforts.includes(effort as Effort)) {
      throw new UsageError(`--effort must be one of ${efforts.join(', ')}`)
    }
    const prompt = await readFile(path.resolve(file), 'utf8')
    if (prompt.trim() === '') throw new UsageError('the prompt file is empty')
    const sub = await withDaemon(home, (client) =>
      client.startSubAgent(ref, {
        prompt,
        ...(agent !== undefined && { agent: agent as AgentKind }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort: effort as Effort }),
        ...(name !== undefined && { name }),
        ...(options['own-worktree'] && { ownWorktree: true }),
        ...(options.reviewer && { reviewer: true }),
      }),
    )
    const when = sub.state === 'queued' ? 'queued for a free slot' : 'started'
    console.log(
      `Started sub-agent “${printable(sub.name)}” (Run ${shortReference(sub.id)}), ${when}.`,
    )
    console.log(`Run \`ted run wait ${shortReference(sub.id)}\` for its final message.`)
  }

  async function waitForSubAgent(id: string): Promise<void> {
    const result = await withDaemon(home, async (client) => {
      for (;;) {
        const current = await client.waitForSubAgent(id)
        if (current.done) return current
      }
    })
    if (result.message !== undefined) write(`${printable(result.message).trimEnd()}\n`)
    if (result.state === 'failed') {
      console.error(`ted: sub-agent “${printable(result.name)}” failed`)
      if (result.error !== undefined) console.error(printable(result.error))
      exitCode = 1
    } else if (result.state === 'stopped') {
      console.error(
        `ted: sub-agent “${printable(result.name)}” was stopped${result.error ? `: ${printable(result.error)}` : ''}`,
      )
      exitCode = 1
    }
  }

  async function restoreBackup(name: string): Promise<void> {
    await withDaemon(home, async (client) => {
      const { backups, activeRuns } = await client.listBackups()
      if (!backups.some((b) => b.name === name)) throw new Error(`no backup ${name}`)
      if (activeRuns > 0 && !options.yes) {
        const runs = activeRuns === 1 ? '1 Run' : `${activeRuns} Runs`
        const them = activeRuns === 1 ? 'it' : 'them'
        write(`Restoring stops ${runs}. Stop ${them} and restore? [y/N] `)
        if (!/^y(es)?$/i.test((await readLine()).trim())) throw new Error('nothing restored')
      }
      const result = await client.restoreBackup({ name, stopRuns: true })
      if (result.stoppedRuns > 0) {
        console.log(`Stopped ${result.stoppedRuns === 1 ? '1 Run' : `${result.stoppedRuns} Runs`}.`)
      }
      console.log(`Restored ${result.restored}.`)
      console.log(`Your data from before the restore is in backup ${result.saved}.`)
    })
  }

  async function readLine(): Promise<string> {
    if (runtime.stdin) return (await runtime.stdin()).split('\n')[0] ?? ''
    let text = ''
    for await (const chunk of process.stdin) {
      text += chunk
      const newline = text.indexOf('\n')
      if (newline >= 0) return text.slice(0, newline)
    }
    return text
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  async function problems(): Promise<{
    pid: number | undefined
    banners: string[]
    stops: boolean
  }> {
    const { banners, factories } = await withDaemon(home, async (client) => ({
      banners: await client.listBanners(),
      factories: await client.listFactories(),
    }))
    const pid = (await readDaemonInfoFor(home, runTokenFrom(env)))?.pid
    return {
      pid,
      banners: formatBanners(banners, factories),
      stops: banners.some((b) => b.severity === 'stops-work'),
    }
  }

  async function openApp(): Promise<void> {
    const info = await readDaemonInfoFor(home, runTokenFrom(env))
    const token = runTokenFrom(env) ?? info?.token
    const result = await (info ? new DaemonClient(info, token).openApp() : undefined)?.catch(
      (error: unknown) => {
        if (error instanceof DaemonUnreachableError) return undefined
        throw error
      },
    )
    if (result?.opened) return void console.log('Opened Ted')
    const app = tedEnv('TED_APP_EXECUTABLE', env)
    if (!app) {
      console.error('ted: Ted isn’t open. Open it from your app launcher.')
      exitCode = 1
      return
    }
    launchApp(app)
    console.log('Opening Ted')
  }

  function launchApp(executable: string): void {
    const { ELECTRON_RUN_AS_NODE: _, ...appEnv } = filterTedEnv(env)
    const bundle = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1]
    const [command, args] = bundle ? ['/usr/bin/open', [bundle]] : [executable, []]
    spawn(command, args, { detached: true, stdio: 'ignore', env: appEnv }).unref()
  }

  async function status(): Promise<void> {
    const { pid, banners } = await problems()
    console.log(`Ted’s background process is running (pid ${pid ?? 'unknown'})`)
    console.log(banners.join('\n'))
  }

  async function doctor(): Promise<void> {
    const health = await withDaemon(home, (client) => client.checkIntegrations())
    const { pid, banners, stops } = await problems()
    console.log(`✓ Ted’s background process is running (pid ${pid ?? 'unknown'})`)
    const lines = integrationLines(health)
    console.log(lines.map((line) => printable(line)).join('\n'))
    console.log(banners.join('\n'))
    if (stops || health.git.state === 'not-installed') exitCode = 1
  }

  function remedyText(fix: IntegrationRemedy | undefined): string {
    return fix === undefined ? '' : 'url' in fix ? fix.url : fix.command
  }

  function integrationLines({ git, github }: IntegrationsHealth): string[] {
    const identity = [git.name, git.email && `<${git.email}>`].filter(Boolean).join(' ')
    const gitLine =
      git.state === 'not-installed'
        ? `✗ git not found · ${remedyText(git.fix)}`
        : git.state === 'no-identity'
          ? `! git ${git.version} has no name or email set · ${(git.copy ?? []).join(' && ')}`
          : `✓ git ${git.version} · ${identity}`
    const { cli } = github
    const ghLine =
      cli.state === 'ready'
        ? `✓ gh ${cli.version} · ${cli.path}`
        : cli.state === 'not-installed'
          ? `✗ gh not found · ${remedyText(cli.fix)}`
          : cli.state === 'too-old'
            ? `✗ gh ${cli.version} is older than ${minGhVersion} · ${remedyText(cli.fix)}`
            : `✗ gh isn’t working · ${cli.error ?? ''}`
    const hostLines =
      cli.state === 'ready'
        ? github.hosts.map((host) => {
            if (host.state === 'ready') return `✓ ${host.host} · signed in as ${host.login ?? '?'}`
            if (host.state === 'missing-workflow-scope') {
              return `! ${host.host} · can’t push changes to GitHub Actions workflows · ${host.fix?.command ?? ''}`
            }
            if (host.state === 'signed-out') {
              return `✗ ${host.host} · signed out · ${host.fix?.command ?? ''}`
            }
            return `✗ ${host.host} · ${host.error ?? 'couldn’t check'}`
          })
        : []
    return [gitLine, ghLine, ...hostLines]
  }

  function formatBanners(banners: Banner[], factories: Factory[]): string[] {
    if (banners.length === 0) return ['No problems.']
    const where = (b: Banner) =>
      b.factoryId === undefined
        ? 'Ted'
        : (factories.find((f) => f.id === b.factoryId)?.name ?? 'a Factory')
    const rows = banners.map((b) => [
      b.severity === 'stops-work' ? 'Stops work' : 'Warning',
      where(b),
      [
        printable(b.text),
        ...(b.action ? [`[${printable(b.action.label)}]`] : []),
        ...(isShowing(b) ? [] : [`(dismissed until ${b.dismissedUntil})`]),
      ].join('  '),
    ])
    const width = (column: number) => Math.max(...rows.map((row) => row[column]?.length ?? 0))
    return [
      `${banners.length} ${banners.length === 1 ? 'problem' : 'problems'}:`,
      ...rows.map(([kind = '', place = '', rest]) =>
        ['  ', kind.padEnd(width(0)), '  ', place.padEnd(width(1)), '  ', rest].join(''),
      ),
    ]
  }

  async function workflowCheck(target: string): Promise<void> {
    const problems = await checkWorkflowPath(path.resolve(target), {
      libraryDir: tedPaths(home).library,
    })
    for (const p of problems) {
      const file = path.relative(process.cwd(), p.path)
      console.log(`${file}:${p.line}:${p.column}: ${p.severity}: ${printable(p.message)}`)
    }
    const count = (severity: string) => problems.filter((p) => p.severity === severity).length
    const errors = count('error')
    const warnings = count('warning')
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    if (problems.length === 0)
      console.log(`No problems in ${path.relative(process.cwd(), path.resolve(target)) || '.'}`)
    else {
      console.log(
        [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
          .filter(Boolean)
          .join(', '),
      )
    }
    if (errors > 0) exitCode = 1
  }

  function describeLead({ agent, model, effort, effortMode }: TaskLead): string {
    return [
      agent,
      model ?? 'default model',
      effortMode === 'stage' ? 'Follow Stage settings' : (effort ?? 'default effort'),
    ].join(' · ')
  }

  function formatRun({ run, conversation }: RunWithConversation): string {
    return [
      `Run ${shortReference(run.id)}  ${run.agent}  ${run.state}${run.problem === 'model-unavailable' ? '  model unavailable' : ''}`,
      `Session ${run.sessionId ?? 'not known yet'}`,
      ...conversation.map((entry) => summarize(entry.line)),
    ].join('\n')
  }

  interface ContentBlock {
    type: string
    text?: string
    name?: string
  }

  function summarize(line: string): string {
    const message = JSON.parse(line) as {
      type?: string
      subtype?: string
      hook_name?: string
      message?: { content?: string | ContentBlock[] }
      id?: unknown
      method?: string
      params?: { item?: { type?: string; text?: string } }
    }
    if (message.method === undefined && message.id !== undefined) {
      return printable(`response ${String(message.id)}`)
    }
    if (message.method !== undefined) {
      const item = message.params?.item
      const detail = item?.text !== undefined ? `: ${item.text}` : item?.type ? ` ${item.type}` : ''
      return printable(`${message.method}${detail}`)
    }
    const content = message.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    const parts = blocks.map((b) =>
      b.type === 'text' ? b.text : b.name ? `${b.type} ${b.name}` : b.type,
    )
    const kind = [message.type, message.subtype, message.hook_name].filter(Boolean).join(' ')
    return printable(parts.length > 0 ? `${kind}: ${parts.join(' | ')}` : kind)
  }

  async function readDesign(file: string): Promise<LocalDesignReviewInput> {
    return readParsedFile(file, 'design', parseLocalDesignReviewInput)
  }

  async function uploadDesign(
    client: DaemonClient,
    ref: string,
    { screenshots, video, prototype, ...rest }: LocalDesignReviewInput,
  ): Promise<DesignReviewInput> {
    const upload = async ({ path: file, caption }: DesignFileSpec): Promise<DesignFileInput> => {
      const bytes = new Uint8Array(await readFile(path.resolve(file)))
      const saved = await client.uploadTaskAttachment(
        ref,
        { name: path.basename(file), mediaType: mediaTypeOf(file) },
        bytes,
      )
      return { ...saved, ...(caption !== undefined && { caption }) }
    }
    const shots = []
    for (const shot of screenshots ?? []) shots.push(await upload(shot))
    return parseDesignReviewInput({
      ...rest,
      ...(shots.length > 0 && { screenshots: shots }),
      ...(video && { video: await upload(video) }),
      ...(prototype && { prototype: await upload(prototype) }),
    })
  }

  function readRound(file: string): Promise<RoundInput> {
    return readParsedFile(file, 'round', parseRoundInput)
  }

  async function readParsedFile<T>(
    file: string,
    what: string,
    parser: (value: unknown) => T,
  ): Promise<T> {
    const text = await readFile(path.resolve(file), 'utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new UsageError(
        `the ${what} file isn’t valid JSON (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    try {
      return parser(value)
    } catch (error) {
      if (error instanceof RequestValidationError) throw new UsageError(error.message)
      throw error
    }
  }

  function appOwner() {
    const runId = tedEnv('TED_RUN', env)
    const automationRun =
      options.task === undefined &&
      !tedEnv('TED_TASK', env) &&
      Boolean(tedEnv('TED_AUTOMATION', env)) &&
      Boolean(runId)
    if (automationRun && runId) {
      return {
        what: 'this Run',
        ends: 'the Run ends',
        list: (client: DaemonClient) => client.listRunApps(runId),
        start: (client: DaemonClient, app: StartAppRequest) => client.startRunApp(runId, app),
        log: (client: DaemonClient, app: { repo: string; name: string }) =>
          client.runAppLog(runId, app),
      }
    }
    const ref = taskRef()
    return {
      what: 'this Task',
      ends: 'the human stops it or the Task ends',
      list: (client: DaemonClient) => client.listApps(ref),
      start: (client: DaemonClient, app: StartAppRequest) => client.startApp(ref, app),
      log: (client: DaemonClient, app: { repo: string; name: string }) => client.appLog(ref, app),
    }
  }

  async function findApp(
    client: DaemonClient,
    owner: ReturnType<typeof appOwner>,
    given: string | undefined,
  ): Promise<{ name: string; repo: string }> {
    const apps = (await owner.list(client)).filter(
      (a) => options.repo === undefined || a.repo === options.repo,
    )
    const matches = given === undefined ? apps : apps.filter((a) => a.name === given)
    const [only] = matches
    if (matches.length !== 1 || only === undefined) {
      throw new UsageError(
        apps.length === 0
          ? `${owner.what} has no Apps`
          : given === undefined
            ? `name the App: ${apps.map((a) => printable(a.name)).join(', ')}`
            : matches.length === 0
              ? `no App named ${printable(given)}. Apps: ${apps.map((a) => printable(a.name)).join(', ')}`
              : `name the repo with --repo: ${matches.map((a) => printable(a.repo)).join(', ')}`,
      )
    }
    return { name: only.name, repo: only.repo }
  }

  async function appList(): Promise<void> {
    const owner = appOwner()
    const apps = await withDaemon(home, (client) => owner.list(client))
    if (apps.length === 0) {
      console.log(`${owner.what === 'this Run' ? 'This Run' : 'This Task'} has no Apps.`)
      return
    }
    for (const app of apps) {
      const where = app.url ?? (app.port !== undefined ? `port ${app.port}` : app.simulator?.device)
      const state = app.state === 'failed' && app.problem ? `failed: ${app.problem}` : app.state
      console.log(
        printable(
          [app.name, app.repo, app.electron ? 'electron' : app.kind, state, where]
            .filter((part) => part !== undefined)
            .join(' · '),
        ),
      )
    }
  }

  async function appLog(given: string): Promise<void> {
    const owner = appOwner()
    const log = await withDaemon(home, async (client) =>
      owner.log(client, await findApp(client, owner, given)),
    )
    console.log(printable(log.text))
  }

  async function runApp(given: string | undefined): Promise<void> {
    const owner = appOwner()
    const { app, log } = await withDaemon(home, async (client) => {
      let wanted: { name: string; repo?: string } | undefined =
        given === undefined
          ? undefined
          : { name: given, ...(options.repo && { repo: options.repo }) }
      if (wanted === undefined) wanted = await findApp(client, owner, undefined)
      let app = await owner.start(client, {
        ...wanted,
        ...(options.reason !== undefined && { reason: options.reason }),
      })
      let said: string | undefined
      const sayWhy = () => {
        const line = appWaitLine(app, owner.what === 'this Run')
        if (line === undefined) return
        const why = printable(line)
        if (why !== said) console.error(why)
        said = why
      }
      sayWhy()
      while (app.state === 'starting' || app.state === 'waiting') {
        await sleep(500)
        const current = app
        const found = (await owner.list(client)).find(
          (a) => a.repo === current.repo && a.name === current.name,
        )
        if (found === undefined || found.removed === true) {
          throw new Error(
            `${printable(current.name)} was removed from the Factory’s settings while Ted waited for it`,
          )
        }
        app = found
        sayWhy()
      }
      const log =
        app.state === 'running'
          ? undefined
          : await owner.log(client, { repo: app.repo, name: app.name })
      return { app, log }
    })
    const name = printable(app.name)
    if (app.state === 'running' && app.simulator !== undefined) {
      console.log(
        `${name} is running on ${printable(app.simulator.device)}. It keeps running until ${owner.ends}.`,
      )
      return
    }
    if (app.state === 'running') {
      console.log(
        app.url !== undefined
          ? `${name} is running at ${printable(app.url)} (port ${app.port}). It keeps running until ${owner.ends}.`
          : `${name} is running on port ${app.port}. It keeps running until ${owner.ends}.`,
      )
      return
    }
    const noSlot = app.state === 'failed' ? app.problem : undefined
    if (noSlot !== undefined && /^No (simulator|emulator) slot/.test(noSlot)) {
      console.error(printable(noSlot))
      exitCode = 1
      return
    }
    const why =
      app.state === 'failed'
        ? `couldn’t start: ${app.problem ?? 'it failed'}`
        : app.exitCode !== undefined
          ? `exited with code ${app.exitCode}`
          : 'stopped'
    const tail = (log?.text ?? '').split('\n').slice(-40).join('\n')
    console.error(
      `${name} ${printable(why)}.${tail.trim() === '' ? '' : ` The end of its log:\n${printable(tail)}`}`,
    )
    exitCode = 1
  }

  function printable(text: string): string {
    return [...stripVTControlCharacters(text)].filter((c) => !isControl(c)).join('')
  }

  function isControl(char: string): boolean {
    const code = char.codePointAt(0) ?? 0
    return (code < 0x20 && char !== '\t' && char !== '\n') || (code >= 0x7f && code <= 0x9f)
  }

  function ordinal(n: number): string {
    const tens = n % 100
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
    return `${n}${suffix}`
  }

  function offset(): number {
    const value = Number(options.offset ?? '0')
    if (!Number.isSafeInteger(value) || value < 0)
      throw new UsageError('offset must be a nonnegative integer')
    return value
  }

  async function coordinatorRemove(kind: CoordinatorRemovalKind): Promise<void> {
    const { operation } = options
    if (!operation || !options.versions) throw new UsageError('operation and versions are required')
    const versions = jsonOption('versions')
    if (typeof versions !== 'object' || versions === null || Array.isArray(versions))
      throw new UsageError('--versions must map each Task ID to its version')
    const input = parseCoordinatorRemoval(
      {
        operation,
        tasks: args.map((id) => ({ id, version: (versions as Record<string, unknown>)[id] })),
        ...(options.children !== undefined && { children: options.children }),
        ...(options['close-pull-requests'] === true && { closePullRequests: true }),
      },
      kind,
    )
    console.log(
      JSON.stringify(await withDaemon(home, (client) => client.coordinatorRemove(kind, input))),
    )
  }

  function jsonOption(name: 'answers' | 'skip-rows' | 'neighbours' | 'versions'): unknown {
    const raw = options[name]
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new UsageError(`--${name} must be JSON`)
    }
  }

  async function coordinatorAutomationDraft(kind: AutomationCardKind): Promise<void> {
    const { operation } = options
    if (!operation) throw new UsageError('operation is required')
    let fields: Json | undefined
    if (kind !== 'delete') {
      const raw = options.fields ?? (await readStdin())
      fields = parseJson(raw)
      if (fields === undefined) throw new UsageError('the fields must be JSON')
    }
    let input: AutomationDraftRequest
    try {
      input = parseAutomationDraftRequest({
        operation,
        kind,
        ...(kind !== 'create' && { automation: args[0] ?? '' }),
        ...(fields !== undefined && { fields }),
      })
    } catch (error) {
      if (error instanceof RequestValidationError) throw new UsageError(error.message)
      throw error
    }
    console.log(
      JSON.stringify(await withDaemon(home, (client) => client.draftAutomation(draftBody(input)))),
    )
  }

  async function coordinatorAct(command: 'start' | 'move'): Promise<void> {
    const { operation, version } = options
    if (!operation || !version) throw new UsageError('operation and version are required')
    const neighbours = options.neighbours ? jsonOption('neighbours') : undefined
    const input: CoordinatorAction = {
      operation,
      version,
      ...(options.after && { after: options.after }),
      ...(options.before && { before: options.before }),
      ...(neighbours !== undefined && { neighbours: neighbours as Record<string, string> }),
    }
    const receipt = await withDaemon(home, (client) =>
      client.coordinatorAct(args[0] ?? '', command, input),
    )
    console.log(JSON.stringify(receipt))
  }

  async function coordinatorMessage(command: 'tell' | 'answer'): Promise<void> {
    const { operation, version } = options
    if (!operation || !version) throw new UsageError('operation and version are required')
    const choices = options.choice ?? []
    const decided = options.approve || options['request-changes']
    const round = options.answers !== undefined || options.recommended
    if (command === 'tell' && (options.request || choices.length > 0 || decided || round))
      throw new UsageError('tell takes only --message')
    if (command === 'answer' && !options.request)
      throw new UsageError('name the request with --request <comment-id>')
    if (options.approve && options['request-changes'])
      throw new UsageError('give --approve or --request-changes, not both')
    if (options['close-pull-requests'] && options['keep-pull-requests'])
      throw new UsageError('give --close-pull-requests or --keep-pull-requests, not both')
    const given = choices.length > 0 || options.approve || round
    const typed = options.message ?? (command === 'tell' || !given ? await readStdin() : '')
    const message = typed.trim() === '' ? undefined : typed.trim()
    if (message === undefined && (command === 'tell' || !given))
      throw new UsageError(
        command === 'tell'
          ? 'give the message with --message "<text>" or on stdin'
          : options['request-changes']
            ? 'give the changes to ask for with --message "<text>" or on stdin'
            : 'give --choice, --approve, --request-changes, --answers, --recommended or --message',
      )
    const answers = jsonOption('answers')
    const skipRows = jsonOption('skip-rows')
    const input: CoordinatorAction = {
      operation,
      version,
      ...(message !== undefined && { message }),
      ...(command === 'answer' && { request: options.request }),
      ...(choices.length > 1 ? { choices } : choices[0] !== undefined && { choice: choices[0] }),
      ...(options.approve && { decision: 'approve' as const }),
      ...(options['request-changes'] && { decision: 'request-changes' as const }),
      ...(answers !== undefined && {
        answers: answers as { answer: string; choices?: string[]; note?: string }[],
      }),
      ...(options.recommended && { recommended: true }),
      ...(skipRows !== undefined && { skipRows: skipRows as number[] }),
      ...(options['start-unblocked'] && { startUnblocked: true }),
      ...(options['close-pull-requests'] && { closePullRequests: true }),
      ...(options['keep-pull-requests'] && { closePullRequests: false }),
    }
    const receipt = await withDaemon(home, (client) =>
      client.coordinatorAct(args[0] ?? '', command, input),
    )
    console.log(JSON.stringify(receipt))
  }

  async function failureResult(
    work: (client: DaemonClient, ref: string) => Promise<unknown>,
  ): Promise<void> {
    const ref = taskRef()
    console.log(
      printable(
        JSON.stringify(
          await withDaemon(home, (client) => work(client, ref)),
          (_key, value: unknown) => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
            const record = value as Record<string, unknown>
            return {
              ...record,
              ...(typeof record.id === 'string' &&
                ('source' in record || 'fingerprint' in record || 'disposition' in record) && {
                  reference: shortReference(record.id),
                }),
              ...(typeof record.recordedBy === 'string' && {
                recordedByReference: shortReference(record.recordedBy),
              }),
              ...(typeof record.runId === 'string' && {
                runReference: shortReference(record.runId),
              }),
              ...(typeof record.contextId === 'string' && {
                contextReference: shortReference(record.contextId),
              }),
            }
          },
          2,
        ),
      ),
    )
  }

  async function browser(action: BrowserRequest['action']): Promise<void> {
    const request: BrowserRequest = { action }
    if (action === 'open')
      request.app = { name: args[0] ?? '', ...(options.repo && { repo: options.repo }) }
    if (action === 'click' || action === 'fill') request.ref = args[0] ?? ''
    if (action === 'fill') request.value = args[1] ?? (await readStdin())
    if (['press', 'navigate', 'resize', 'color-scheme'].includes(action))
      request.value = args[0] ?? ''
    if (action === 'size') {
      const given = args[0] ?? ''
      if (options.landscape && !['tablet', 'mobile'].includes(given))
        throw new UsageError('--landscape works only with tablet or mobile')
      request.value = options.landscape ? `${given}-landscape` : given
    }
    const owner = browserOwner()
    let parsed: BrowserRequest
    try {
      parsed = parseBrowserRequest(request)
    } catch (error) {
      if (error instanceof RequestValidationError) throw new UsageError(error.message)
      throw error
    }
    if (!owner.run && runOnlyBrowserActions.includes(action))
      throw new UsageError(`ted browser ${action} works only in an Automation Run`)
    if (owner.run && taskOnlyBrowserActions.includes(action))
      throw new UsageError(`ted browser ${action} works only in a Task; use ted browser resize`)
    const browserClient = await withDaemon(home, async (client) => {
      await owner.check(client)
      return client
    })
    const result = await owner.command(browserClient, parsed)
    console.log(printable(result.text ?? result.url ?? 'Done'))
    if (result.attachment) {
      const attachment = result.attachment
      const bytes = await withDaemon(home, (client) => owner.capture(client, attachment.hash))
      const file = path.resolve(`ted-browser-${randomUUID()}.png`)
      await writeFile(file, Buffer.from(bytes.data, 'base64'), { flag: 'wx', mode: 0o600 })
      console.log(
        owner.run
          ? `Saved ${printable(file)}. Attach with ted task create --attach <path>.`
          : `Saved ${printable(file)}. Attach with ted comment --attach <path>.`,
      )
    }
  }

  async function device(action: DeviceAction): Promise<void> {
    const runId = tedEnv('TED_RUN', env)
    if (
      options.task !== undefined ||
      tedEnv('TED_TASK', env) ||
      !tedEnv('TED_AUTOMATION', env) ||
      !runId
    )
      throw new UsageError(`ted app ${action} works only in an Automation Run`)
    const request: Record<string, unknown> = {
      action,
      app: { name: args[0] ?? '', ...(options.repo && { repo: options.repo }) },
    }
    const point = (value: string | undefined) => {
      const found = devicePoint(value ?? '')
      if (!found) throw new UsageError(`give a point as x,y, such as 540,1200`)
      return found
    }
    if (action === 'tap') {
      const given = args[1] ?? ''
      if (/^\d{1,3}$/.test(given)) request.ref = given
      else request.point = point(given)
    }
    if (action === 'swipe') {
      request.point = point(args[1])
      request.to = point(args[2])
    }
    if (action === 'type') request.text = args[1] ?? (await readStdin()).replace(/\r?\n$/, '')
    if (action === 'key') request.key = args[1]
    if (action === 'appearance') request.appearance = args[1]
    if (action === 'size') {
      request.size = args[1]
      if (options.density !== undefined) {
        if (!/^\d{1,4}$/.test(options.density))
          throw new UsageError('--density takes a whole number of dpi, such as 420')
        request.density = Number(options.density)
      }
    }
    let parsed: DeviceRequest
    try {
      parsed = parseDeviceRequest(request)
    } catch (error) {
      if (error instanceof RequestValidationError) throw new UsageError(error.message)
      throw error
    }
    const result = await withDaemon(home, (client) => client.runDeviceCommand(runId, parsed))
    console.log(printable(result.text))
    if (result.attachment) {
      const attachment = result.attachment
      const bytes = await withDaemon(home, (client) =>
        client.readRunBrowserCapture(runId, attachment.hash),
      )
      const file = path.resolve(`ted-app-${randomUUID()}.png`)
      await writeFile(file, Buffer.from(bytes.data, 'base64'), { flag: 'wx', mode: 0o600 })
      console.log(`Saved ${printable(file)}. Attach with ted task create --attach <path>.`)
    }
  }

  function browserOwner() {
    const runId = tedEnv('TED_RUN', env)
    if (
      options.task === undefined &&
      !tedEnv('TED_TASK', env) &&
      tedEnv('TED_AUTOMATION', env) &&
      runId
    )
      return {
        run: true,
        check: (client: DaemonClient) => client.listRunApps(runId),
        command: (client: DaemonClient, request: BrowserRequest) =>
          client.runBrowserCommand(runId, request),
        capture: (client: DaemonClient, hash: string) => client.readRunBrowserCapture(runId, hash),
      }
    const ref = taskRef()
    return {
      run: false,
      check: (client: DaemonClient) => client.listApps(ref),
      command: (client: DaemonClient, request: BrowserRequest) =>
        client.browserCommand(ref, request),
      capture: (client: DaemonClient, hash: string) => client.readBrowserCapture(ref, hash),
    }
  }

  // Imported only here: the module reaches node:sqlite, whose warning would be on every command.
  const execution = () => import('@ted/daemon/execution')
  async function workerHome(): Promise<string> {
    if (!remoteExecutionOn(env)) throw new UsageError(remoteExecutionOff)
    if (
      ['TED_RUN', 'TED_RUN_CAPABILITY', 'TED_RUN_TOKEN', 'TED_TASK', 'TED_PLAN', 'TED_CHAT'].some(
        (name) => tedEnv(name, env),
      )
    )
      throw new UsageError('Execution service control is not available inside a Run')
    return (await execution()).executionHome(env)
  }
  async function workerOutput(operation: 'start' | 'status' | 'stop' | 'pair'): Promise<void> {
    const root = await workerHome()
    const { startExecutionService, stopExecutionService, workerRequest } = await execution()
    let status: import('@ted/protocol').WorkerStatus
    if (operation === 'start') {
      await startExecutionService(root, env)
      status = await workerRequest(root, 'start')
    } else if (operation === 'pair') {
      const details = (await readStdin()).trim()
      const input = parseWorkerPairRequest({
        details,
        capacity: executionCapacity(Number(options.capacity ?? 2)),
      })
      await startExecutionService(root, env, undefined, { resume: false })
      status = await workerRequest(root, 'pair', input)
    } else if (operation === 'stop') {
      await stopExecutionService(root)
      status = {
        state: 'stopped',
        message: 'Execution service stopped; pairing retained.',
        scopes: [],
      }
    } else status = await workerRequest(root, 'status')
    console.log(JSON.stringify(status, null, 2))
  }
  const handlers = {
    executionStart: () => workerOutput('start'),
    executionStop: () => workerOutput('stop'),
    executionStatus: () => workerOutput('status'),
    executionPair: () => workerOutput('pair'),
    executionServe: async () => {
      const { serveExecution } = await execution()
      const service = await serveExecution(await workerHome(), env)
      const close = () => void service.close()
      process.once('SIGTERM', close)
      process.once('SIGINT', close)
      try {
        await service.worker.start()
        console.log('Execution worker running; close with Ctrl-C.')
        await service.closed
      } finally {
        process.removeListener('SIGTERM', close)
        process.removeListener('SIGINT', close)
        await service.close()
      }
    },
    failureList: () => failureResult((client, ref) => client.listFailures(ref)),
    failureContext: () => failureResult((client, ref) => client.captureFailureContext(ref)),
    failureObligations: () => failureResult((client, ref) => client.validationObligations(ref)),
    failureShow: () =>
      failureResult(async (client, ref) => {
        const values = await client.listFailures(ref)
        const match = matchReference(
          args[0] ?? '',
          values.map((value) => value.id),
        )
        if (match.kind === 'ambiguous')
          throw new UsageError(
            'More than one failure case matches. Use more characters or the full ID.',
          )
        const found =
          match.kind === 'found' ? values.find((value) => value.id === match.id) : undefined
        if (!found) throw new UsageError('no such failure on this Task')
        return found
      }),
    failureRecord: async () => {
      const ref = taskRef()
      const input = await readParsedFile(options.file ?? '', 'failure', parseRecordFailureRequest)
      await failureResult((client) => client.recordFailure(ref, input))
    },
    failureEvidence: async () => {
      const ref = taskRef()
      const input = await readParsedFile(
        options.file ?? '',
        'failure evidence',
        parseAddFailureEvidenceRequest,
      )
      await failureResult((client) => client.addFailureEvidence(ref, args[0] ?? '', input))
    },
    failureAssess: async () => {
      const ref = taskRef()
      const input = await readParsedFile(
        options.file ?? '',
        'failure assessment',
        parseAssessFailureRequest,
      )
      await failureResult((client) => client.assessFailure(ref, args[0] ?? '', input))
    },
    failureVerify: async () => {
      const ref = taskRef()
      const input = await readParsedFile(
        options.file ?? '',
        'failure verification',
        parseVerifyFailureRequest,
      )
      await failureResult((client) =>
        client.verifyFailure(ref, args[0] ?? '', input.evidence, input.fixedBy),
      )
    },
    failureFix: () =>
      failureResult((client, ref) => client.chooseFailureFix(ref, args[0] ?? '', args[1] ?? '')),
    failureAsk: () =>
      failureResult((client, ref) => client.requestFailureDecision(ref, args[0] ?? '')),
    browserOpen: async () => {
      await browser('open')
    },
    browserSnapshot: async () => {
      await browser('snapshot')
    },
    browserClick: async () => {
      await browser('click')
    },
    browserFill: async () => {
      await browser('fill')
    },
    browserPress: async () => {
      await browser('press')
    },
    browserNavigate: async () => {
      await browser('navigate')
    },
    browserBack: async () => {
      await browser('back')
    },
    browserForward: async () => {
      await browser('forward')
    },
    browserReload: async () => {
      await browser('reload')
    },
    browserResize: async () => {
      await browser('resize')
    },
    browserColorScheme: async () => {
      await browser('color-scheme')
    },
    browserSize: async () => {
      await browser('size')
    },
    browserScreenshot: async () => {
      await browser('screenshot')
    },

    export: async () => {
      console.log(await exportCommand(home, options))
    },
    coordinatorParent: async () => {
      const { operation, version } = options
      const revision = options['hierarchy-revision']
      if (!operation || !version || !revision)
        throw new UsageError('operation, version and hierarchy-revision are required')
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) =>
            client.coordinatorAct(args[0] ?? '', 'parent', {
              operation,
              version,
              parentId: args[1] === 'none' ? null : (args[1] ?? ''),
              hierarchyRevision: revision,
            }),
          ),
        ),
      )
    },
    coordinatorArchive: () => coordinatorRemove('archive'),
    coordinatorUnarchive: () => coordinatorRemove('unarchive'),
    coordinatorDelete: () => coordinatorRemove('delete'),
    coordinatorTransfer: async () => {
      const { operation, version, factory, reason } = options
      if (!operation || !version || !factory || !reason)
        throw new UsageError('operation, version, factory and reason are required')
      const input = parseCoordinatorTransfer({
        operation,
        task: { id: args[0] ?? '', version },
        factory,
        reason,
      })
      console.log(
        JSON.stringify(await withDaemon(home, (client) => client.coordinatorTransfer(input))),
      )
    },
    coordinatorDone: async () => {
      const { operation, version } = options
      if (!operation || !version) throw new UsageError('operation and version are required')
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) =>
            client.coordinatorAct(args[0] ?? '', 'done', { operation, version }),
          ),
        ),
      )
    },
    coordinatorResume: async () => {
      if (!options.operation || !options.version)
        throw new UsageError('operation and version are required')
      const { operation, version } = options
      const message = options.message?.trim()
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) =>
            client.coordinatorAct(args[0] ?? '', 'resume', {
              operation,
              version,
              ...(message && { message }),
            }),
          ),
        ),
      )
    },
    help: async () => {
      console.log(helpText())
    },
    status: async () => {
      await status()
    },
    doctor: async () => {
      await doctor()
    },
    open: async () => {
      await openApp()
    },
    automationComment: async () => {
      const body = args.filter((s) => s !== undefined).join(' ') || (await readStdin())
      if (body.trim() === '') throw new UsageError('give the comment as text or on stdin')
      const choices = options.choice ?? []
      const comment = await withDaemon(home, (client) =>
        client.postAutomationComment({ body, ...(choices.length > 0 && { choices }) }),
      )
      console.log(
        comment.kind === 'question'
          ? `Asked the human (request ${comment.id}). Ted sends you their answer.`
          : 'Posted',
      )
    },
    autopilotAnswer: async () => {
      const [id = '', ...words] = args
      const text = words.join(' ') || (await readStdin())
      if (!text.trim()) throw new UsageError('give a decision and explanation')
      const picked = options.choice ?? []
      await withDaemon(home, (client) =>
        client.answerAutopilot(taskRef(), id, {
          action: 'answer',
          text,
          ...(picked.length > 1
            ? { choices: picked }
            : picked[0] !== undefined && { choice: picked[0] }),
        }),
      )
      console.log('Autopilot answered the question')
    },
    comment: async () => {
      const ref = taskRef()
      const files = options.attach ?? []
      const text = args.filter((s) => s !== undefined).join(' ')
      const body = text || (await readStdin())
      if (body.trim() === '' && files.length === 0) {
        throw new UsageError('give the comment as text or on stdin')
      }
      const choices = options.choice ?? []
      if (files.length > 0 && choices.length > 0) {
        throw new UsageError('a question can’t carry files; post them in a note first')
      }
      const multiple = severalAllowed(choices)
      const contents = await Promise.all(files.map(fileContents))
      const comment = await withDaemon(home, async (client) => {
        const attachments = []
        for (const { bytes, ...file } of contents) {
          attachments.push(await client.uploadTaskAttachment(ref, file, bytes))
        }
        return client.postComment(ref, {
          body,
          ...(choices.length > 0 && { choices }),
          ...multiple,
          ...(attachments.length > 0 && { attachments }),
        })
      })
      console.log(
        comment.kind === 'question'
          ? `Asked the human (request ${comment.id}). Ted sends you their answer.${heldNote(comment)}`
          : 'Posted',
      )
    },
    closeRound: async () => {
      const ref = taskRef()
      const summary = await readFile(path.resolve(options.summary ?? ''), 'utf8')
      if (summary.trim() === '') throw new UsageError('the summary file is empty')
      const round = await withDaemon(home, (client) => client.closeRound(ref, { summary }))
      console.log(
        `Closed Round ${round.round?.number ?? ''} as answered in Talk it through and posted your summary. If anything is still open, ask it in a new round with \`ted ask --round <file>\`.`,
      )
    },
    round: async () => {
      const ref = taskRef()
      const round = await readRound(options.round ?? '')
      const supersedes = options.supersedes
      const request = await withDaemon(home, (client) =>
        client.postComment(ref, { round, ...(supersedes !== undefined && { supersedes }) }),
      )
      console.log(
        `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} Round ${request.round?.number ?? ''} (request ${request.id}). Ted sends you the human’s answers.${heldNote(request)}`,
      )
    },
    depth: async () => {
      const ref = taskRef()
      const [depth = '', ...why] = args
      if (!['none', 'few', 'grilling'].includes(depth)) {
        throw new UsageError('the depth is none, few or grilling')
      }
      const reason = why.join(' ')
      if (reason.trim() === '') throw new UsageError('say why you picked this depth')
      const task = await withDaemon(home, (client) =>
        client.setClarifyDepth(ref, { depth: depth as ClarifyDepth, why: reason }),
      )
      console.log(`${task.displayId}’s Clarify depth is ${depth}`)
    },
    tooBig: async () => {
      const ref = taskRef()
      const why = args.join(' ') || (await readStdin())
      if (why.trim() === '') throw new UsageError('say why the Task is too big')
      const settle = options.settle ?? []
      if (settle.length === 0) {
        throw new UsageError('name what a plan must settle with --settle "<point>"')
      }
      const supersedes = options.supersedes
      const request = await withDaemon(home, (client) =>
        client.postComment(ref, {
          sizeCheck: { why, settle },
          ...(supersedes !== undefined && { supersedes }),
        }),
      )
      console.log(
        `Asked the human what to do with this Task (request ${request.id}). Ted sends you their answer.`,
      )
    },
    proposal: async () => {
      const ref = taskRef()
      if (options.file === undefined) throw new UsageError('give the proposal with --file <file>')
      const proposal = await readParsedFile(options.file, 'proposal', parseProposalInput)
      const supersedes = options.supersedes
      const request = await withDaemon(home, (client) =>
        client.postComment(ref, { proposal, ...(supersedes !== undefined && { supersedes }) }),
      )
      const rows = request.proposal?.rows.length ?? 0
      console.log(
        `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} a proposal of ${rows} rows (request ${request.id}). Ted sends you the human’s answer.${heldNote(request)}`,
      )
    },
    replaceRequest: async () => {
      const ref = taskRef()
      const supersedes = options.supersedes ?? ''
      const body = args.filter((s) => s !== undefined).join(' ') || (await readStdin())
      if (body.trim() === '') throw new UsageError('give the new request as text or on stdin')
      const choices = options.choice ?? []
      const multiple = severalAllowed(choices)
      const request = await withDaemon(home, (client) =>
        client.postComment(ref, {
          body,
          supersedes,
          ...(choices.length > 0 && { choices }),
          ...multiple,
        }),
      )
      console.log(
        `Replaced request ${supersedes} with request ${request.id}. Ted sends you their answer.`,
      )
    },
    activity: async () => {
      const ref = taskRef()
      const text = args.join(' ')
      await withDaemon(home, (client) => client.setActivity(ref, text))
      console.log('Activity line set')
    },
    advance: async () => {
      const ref = taskRef()
      const skip = options.skip === true
      const judged = judgments()
      const changes = options.changes
      const review = options.design === undefined ? undefined : await readDesign(options.design)
      const result = await withDaemon(home, async (client) => {
        const design = review && (await uploadDesign(client, ref, review))
        return client.reportOutcome(ref, {
          outcome: 'advance',
          ...(skip && { skip }),
          ...(judged && { judged }),
          ...(changes !== undefined && { changes }),
          ...(design && { design }),
        })
      })
      console.log(result.message)
    },
    back: async () => {
      const ref = taskRef()
      const to = options.to?.toLowerCase()
      if (to === undefined) throw new UsageError('name the Stage to go back to with --to <Stage>')
      if (options.findings === undefined) {
        throw new UsageError('give the findings file with --findings <file>')
      }
      const findings = await readFile(path.resolve(options.findings), 'utf8')
      if (findings.trim() === '') throw new UsageError('the findings file is empty')
      const judged = judgments()
      const cause = options.cause
      if (cause !== undefined && !declaredSendBackCauses.includes(cause as DeclaredSendBackCause)) {
        throw new UsageError(`--cause takes ${declaredSendBackCauses.join(', ')}`)
      }
      const severity = options.severity?.toLowerCase()
      if (severity !== undefined && !findingSeverities.includes(severity as FindingSeverity)) {
        throw new UsageError(`--severity takes ${findingSeverities.join(', ')}`)
      }
      const result = await withDaemon(home, (client) =>
        client.reportOutcome(ref, {
          outcome: 'back',
          to: to as AgentStageId,
          findings,
          ...(judged && { judged }),
          ...(cause !== undefined && { cause: cause as DeclaredSendBackCause }),
          ...(severity !== undefined && { severity: severity as FindingSeverity }),
        }),
      )
      console.log(result.message)
    },
    question: async () => {
      const ref = taskRef()
      const question = args.join(' ') || (await readStdin())
      if (question.trim() === '') throw new UsageError('give the question as text or on stdin')
      const choices = options.choice ?? []
      const multiple = severalAllowed(choices)
      const result = await withDaemon(home, (client) =>
        client.reportOutcome(ref, {
          outcome: 'ask',
          question,
          ...(choices.length > 0 && { choices }),
          ...multiple,
        }),
      )
      console.log(result.message)
    },
    startSubAgent: async () => {
      await startSubAgent()
    },
    waitSubAgent: async () => {
      await waitForSubAgent(args[0] ?? '')
    },
    sendSubAgent: async () => {
      const [id = '', ...words] = args
      const text = words.join(' ') || (await readStdin())
      if (text.trim() === '') throw new UsageError('give the message as text or on stdin')
      const sub = await withDaemon(home, (client) => client.sendSubAgent(id, text))
      console.log(
        `Sent to sub-agent “${printable(sub.name)}”. Run \`ted run wait ${shortReference(sub.id)}\` for its answer.`,
      )
    },
    boundary: async () => {
      const runId = tedEnv('TED_RUN', env)
      if (!runId) throw new UsageError('ted run boundary only works inside a Run')
      await withDaemon(home, (client) => client.reachedBoundary(runId))
    },
    stopSubAgent: async () => {
      const sub = await withDaemon(home, (client) => client.stopSubAgent(args[0] ?? ''))
      console.log(`Stopped sub-agent “${printable(sub.name)}”`)
    },
    appList,
    appLog: () => appLog(args[0] ?? ''),
    runApp: async () => {
      await runApp(args[0])
    },
    appScreen: () => device('screen'),
    appTap: () => device('tap'),
    appType: () => device('type'),
    appKey: () => device('key'),
    appSwipe: () => device('swipe'),
    appAppearance: () => device('appearance'),
    appSize: () => device('size'),
    screenshot: async () => {
      if (
        options.task === undefined &&
        !tedEnv('TED_TASK', env) &&
        tedEnv('TED_AUTOMATION', env) &&
        tedEnv('TED_RUN', env)
      ) {
        await device('screenshot')
        return
      }
      const ref = taskRef()
      const app = { name: args[0] ?? '', ...(options.repo && { repo: options.repo }) }
      const shot = await withDaemon(home, (client) => client.screenshotApp(ref, app))
      console.log(`Saved ${printable(shot.attachment?.name ?? 'the screenshot')} to the Task`)
    },
    record: async () => {
      if (options.start === options.stop) throw new UsageError('say --start or --stop')
      const ref = taskRef()
      const app = { name: args[0] ?? '', ...(options.repo && { repo: options.repo }) }
      const action = options.start ? 'start' : 'stop'
      const capture = await withDaemon(home, (client) => client.recordApp(ref, { ...app, action }))
      console.log(
        action === 'start'
          ? `Recording ${printable(app.name)}. Stop with ted app record ${printable(app.name)} --stop.`
          : `Saved ${printable(capture.attachment?.name ?? 'the recording')} to the Task`,
      )
    },
    testInvocations: async () => {
      const ref = taskRef()
      const result = await withDaemon(home, (client) => client.testInvocations(ref))
      console.log(JSON.stringify(result, null, 2))
    },
    registerTestInvocation: async () => {
      const ref = taskRef()
      const text =
        options.file === undefined
          ? await readStdin()
          : await readFile(path.resolve(options.file), 'utf8')
      const input = parseRegisterTestInvocation(JSON.parse(text))
      const result = await withDaemon(home, (client) => client.registerTestInvocation(ref, input))
      console.log(JSON.stringify(result))
    },
    checks: async () => {
      const ref = taskRef()
      const name = options.name
      const { checkRun, report } = await withDaemon(home, async (client) => {
        const started = await client.runChecks(ref, name === undefined ? {} : { name })
        for (;;) {
          const current = await client.getCheckRun(started.id)
          if (current.checkRun.finishedAt !== undefined) return current
          await sleep(500)
        }
      })
      console.log(printable(report ?? ''))
      if (checkRun.outcome !== 'passed') exitCode = 1
    },
    writeBrief: async () => {
      const ref = taskRef()
      const text =
        options.file === undefined
          ? await readStdin()
          : await readFile(path.resolve(options.file), 'utf8')
      if (text.trim() === '') throw new UsageError('give the Task brief with --file or on stdin')
      const brief = await withDaemon(home, (client) => client.writeBrief(ref, text))
      console.log(`Wrote version ${brief.version} of the Task brief`)
    },
    showBrief: async () => {
      const ref = taskRef()
      const brief = await withDaemon(home, (client) => client.getBrief(ref))
      write(printable(brief.text))
    },
    asanaIntake: async () => {
      const { factory } = options
      const result = await withDaemon(home, (client) =>
        client.runAsanaIntake(factory === undefined ? {} : { factory }),
      )
      write(`${asanaIntakeText(result)}\n`)
    },
    githubIntake: async () => {
      const result = await withDaemon(home, (client) => client.runGitHubIntake())
      write(`${githubIntakeText(result)}\n`)
    },
    linearIntake: async () => {
      const { factory } = options
      const result = await withDaemon(home, (client) =>
        client.runLinearIntake(factory === undefined ? {} : { factory }),
      )
      write(`${linearIntakeText(result)}\n`)
    },
    createTask: async () => {
      const title = args.join(' ')
      const { factory, source, start, description } = options
      const followUp = options['follow-up']
      const sentryId = options['sentry-id']
      const files = options.attach ?? []
      const child = options.child === true
      const asanaImport =
        source !== undefined &&
        parseAsanaTaskUrl(source) !== undefined &&
        !(runTokenFrom(env) && tedEnv('TED_TASK', env))
      if (files.length > 0 && (followUp !== undefined || asanaImport)) {
        throw new UsageError('files can’t be attached to a Follow-up or an Asana import')
      }
      if (child && followUp !== undefined) {
        throw new UsageError('a Follow-up Task can’t be created as a child')
      }
      if (asanaImport && followUp === undefined) {
        const request = {
          url: source,
          ...(title !== '' && { title }),
          ...(factory !== undefined && { factory }),
          ...(start !== undefined && { start }),
        }
        if (options['dry-run'] === true) {
          const preview = await withDaemon(home, (client) => client.previewAsanaImport(request))
          write(
            `${asanaTreeText(preview)}\n${ownershipLine(preview)}. Nothing created (--dry-run).\n`,
          )
          if (preview.refusal !== undefined) throw new Error(printable(preview.refusal))
          return
        }
        const result = await withDaemon(home, (client) => client.importAsana(request))
        write(`${asanaTreeText(result.preview)}\n${asanaImportedText(result)}\n`)
        return
      }
      if (options['dry-run'] === true)
        throw new UsageError('--dry-run works only with an Asana task URL as --source')
      const contents = await Promise.all(files.map(fileContents))
      const task = await withDaemon(home, async (client) => {
        const attachments = []
        for (const { bytes, ...file } of contents) {
          attachments.push(await client.uploadAttachment(file, bytes))
        }
        if (source !== undefined && parseLinearUrl(source) && !runTokenFrom(env)) {
          const lookup = await client.lookupLinear(source)
          if (lookup.state === 'no-key') {
            console.error(
              'No Linear API key, so the Task was created with the link only. Add one in Settings → Integrations.',
            )
          } else if (lookup.state === 'failed') {
            console.error(printable(lookup.error))
          }
        }
        return client.createTask({
          ...(title !== '' && { title }),
          ...(factory !== undefined && { factory }),
          ...(source !== undefined && { source }),
          ...(sentryId !== undefined && { sentryId }),
          ...(description !== undefined && { description }),
          ...(followUp !== undefined && { followUp }),
          ...(start !== undefined && { start }),
          ...(child && { child }),
          ...(attachments.length > 0 && { attachments }),
        })
      })
      console.log(`Created ${task.displayId}  ${printable(task.title)}`)
      if (task.reminder !== undefined) console.log(printable(task.reminder))
    },
    listTasks: async () => {
      const tasks = await withDaemon(home, (client) => client.listTasks())
      console.log(
        tasks.length === 0
          ? 'No Tasks yet.'
          : tasks.map((t) => `${t.displayId}  ${stageName(t.stage)}  ${t.title}`).join('\n'),
      )
    },
    startTask: async () => {
      const ref = args[0] ?? ''
      const task = await withDaemon(home, (client) => client.startTask(ref))
      console.log(
        task.status?.kind === 'queued'
          ? `Queued ${task.displayId} · ${'place' in task.status ? `${ordinal(task.status.place)} in line for a slot` : task.status.hold}`
          : `Started ${task.displayId} on branch ${task.branch}`,
      )
    },
    block: async () => {
      const ref = taskRef(args[0])
      const by = options.by
      if (by === undefined) throw new UsageError('name the blocker with --by <id>')
      const task = await withDaemon(home, (client) => client.blockTask(ref, by))
      console.log(`${task.displayId} waits for ${by}`)
    },
    taskArchive: async () => {
      const ref = tedEnv('TED_TASK', env)
      if (!ref) throw new UsageError('ted task archive works only inside a Task Lead’s Run')
      const reason = options.reason ?? ''
      const close = options['close-pull-requests'] === true
      const keep = options['keep-pull-requests'] === true
      if (close && keep)
        throw new UsageError('give --close-pull-requests or --keep-pull-requests, not both')
      const why = options['pull-request-reason']
      if ((close || keep) !== (why !== undefined))
        throw new UsageError(
          'give --pull-request-reason "<why>" together with --close-pull-requests or --keep-pull-requests',
        )
      const asked = await withDaemon(home, (client) =>
        client.requestArchive(ref, {
          reason,
          ...(why !== undefined && {
            pullRequests: { recommend: close ? 'close' : 'keep', why },
          }),
        }),
      )
      console.log(
        `Asked the human to archive ${ref} (request ${asked.id}). End your turn now; Ted sends you their answer.`,
      )
    },
    taskMove: async () => {
      const ref = tedEnv('TED_TASK', env)
      if (!ref) throw new UsageError('ted task move works only inside a Task Lead’s Run')
      const asked = await withDaemon(home, (client) =>
        client.requestMove(ref, { factory: options.factory ?? '', reason: options.reason ?? '' }),
      )
      console.log(
        `Asked the human: “${asked.title ?? `Move ${ref}?`}” (request ${asked.id}). End your turn now; Ted sends you their answer.`,
      )
    },
    factories: async () => {
      const others = await withDaemon(home, (client) => client.otherFactories())
      if (others.length === 0) {
        console.log('There are no other Factories.')
        return
      }
      for (const factory of others) {
        console.log(`${factory.key}  ${factory.name}`)
        if (factory.repos !== undefined)
          console.log(
            factory.repos
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
          )
      }
    },
    taskPullRequest: async () => {
      const ref = tedEnv('TED_TASK', env)
      if (!ref) throw new UsageError('ted task pr works only inside a Task Lead’s Run')
      const file = options['body-file']
      const body = file === undefined ? undefined : await readFile(path.resolve(file), 'utf8')
      const set = await withDaemon(home, (client) =>
        client.setPullRequestTitle(ref, {
          title: args[0] ?? '',
          ...(body !== undefined && { body }),
        }),
      )
      console.log(set.message)
    },
    taskDone: async () => {
      const ref = tedEnv('TED_TASK', env)
      if (!ref) throw new UsageError('ted task done works only inside a Task Lead’s Run')
      const task = await withDaemon(home, (client) => client.leadDone(ref))
      console.log(
        isCleanup(task.stage)
          ? `${task.displayId}’s pull requests have merged; it moved to Cleanup`
          : `${task.displayId} is Done`,
      )
    },
    cleanupReport: async () => {
      const ref = tedEnv('TED_TASK', env)
      if (!ref) throw new UsageError('ted cleanup report works only inside a Task Lead’s Run')
      const [step = '', result = '', text = ''] = args
      if (!(cleanupStepResults as readonly string[]).includes(result))
        throw new UsageError(`the result must be one of ${cleanupStepResults.join(', ')}`)
      const reports = await withDaemon(home, (client) =>
        client.reportCleanupStep(ref, {
          step,
          result: result as CleanupStepResult,
          text,
        }),
      )
      const left = reports.length
      console.log(
        `Reported “${step}” as ${result} · ${left} ${left === 1 ? 'step' : 'steps'} reported so far`,
      )
    },
    unblock: async () => {
      const ref = taskRef(args[0])
      const by = options.by
      const task = await withDaemon(home, (client) => client.unblockTask(ref, by))
      console.log(
        by === undefined
          ? `${task.displayId} no longer waits for any Task`
          : `${task.displayId} no longer waits for ${by}`,
      )
    },
    listBackups: async () => {
      const { backups } = await withDaemon(home, (client) => client.listBackups())
      console.log(
        backups.length === 0
          ? 'No backups yet.'
          : backups.map((b) => `${b.name}  ${b.kind}  ${formatDate(b.takenAt)}`).join('\n'),
      )
    },
    restoreBackup: async () => {
      await restoreBackup(args[0] ?? '')
    },
    defaultModel: async () => {
      const ref = args[0] ?? ''
      const task = await withDaemon(home, (client) => client.useDefaultModel(ref))
      console.log(`${task.displayId}’s Task Lead now runs on the default model`)
    },
    lead: async () => {
      const [ref = '', agent = ''] = args
      const { model, effort } = options
      if (options['stage-effort'] && effort !== undefined)
        throw new UsageError('choose --stage-effort or --effort')
      if (!agentKinds.includes(agent as AgentKind))
        throw new UsageError(`the Provider must be ${agentKindList}`)
      if (effort !== undefined && !efforts.includes(effort as Effort)) {
        throw new UsageError(`--effort must be one of ${efforts.join(', ')}`)
      }
      const lead: TaskLead = {
        agent: agent as AgentKind,
        ...(options['stage-effort'] && { effortMode: 'stage' as const }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort: effort as Effort }),
      }
      const task = await withDaemon(home, async (client) => {
        const saved = options['stage-effort']
          ? (await client.listTasks()).find((task) => task.id === ref || task.displayId === ref)
              ?.lead?.effort
          : undefined
        return client.setTaskLead(ref, {
          ...lead,
          ...(saved !== undefined && { effort: saved }),
        })
      })
      console.log(`${task.displayId}’s Task Lead is ${describeLead(task.lead ?? lead)}`)
    },
    workflowCheck: async () => {
      await workflowCheck(args[0] ?? '.ted')
    },
    sandboxGroups: async () => {
      console.log(sandboxGroupsText())
    },
    seedDemo: async () => {
      if (
        tedEnv('TED_RUN', env) ||
        tedEnv('TED_TASK', env) ||
        tedEnv('TED_PLAN', env) ||
        runTokenFrom(env)
      )
        throw new UsageError('Run demo seeding from a local terminal, outside a Run.')
      const started = Date.now()
      const { demoHome, seedDemoFromCli } = await import('@ted/daemon/demo')
      const demo = runtime.home ?? demoHome(env)
      await seedDemoFromCli(demo, options.reset)
      console.log(`Demo ready in ${demo} (${Date.now() - started} ms)`)
    },
    stopDemo: async () => {
      if (
        tedEnv('TED_RUN', env) ||
        tedEnv('TED_TASK', env) ||
        tedEnv('TED_PLAN', env) ||
        runTokenFrom(env)
      )
        throw new UsageError('Stop the demo from a local terminal, outside a Run.')
      const { demoHome, stopDemoFromCli } = await import('@ted/daemon/demo')
      const demo = runtime.home ?? demoHome(env)
      await stopDemoFromCli(demo)
      console.log(`Demo stopped in ${demo}`)
    },
    showMemory: async () => {
      console.log(formatMemoryUse(await withDaemon(home, (client) => client.getMemoryUse())))
    },
    showSlow: async () => {
      console.log(formatSlowMoments(await withDaemon(home, (client) => client.getSlowMoments())))
    },
    showRun: async () => {
      const id = args[0] ?? ''
      console.log(formatRun(await withDaemon(home, (client) => client.getRun(id))))
    },
    planRound: async () => {
      const supersedes = options.supersedes
      const input = { round: await readRound(options.round ?? '') }
      const request = await withDaemon(home, (client) =>
        client.postPlanRequest({ ...input, ...(supersedes !== undefined && { supersedes }) }),
      )
      const what =
        request.kind === 'round'
          ? `Round ${request.round?.number ?? ''}`
          : `a proposal of ${request.proposal?.rows.length ?? 0} rows`
      console.log(
        `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} ${what} (request ${request.id}). Ted sends you the human’s answer.`,
      )
    },
    chatQuestion: async () => {
      const text = args.join(' ').trim()
      if (text === '') throw new UsageError('give the question as text')
      const choices = options.choice ?? []
      const supersedes = options.supersedes
      const request = await withDaemon(home, (client) =>
        client.postChatRequest({
          question: {
            text,
            ...(choices.length > 0 && { choices }),
            ...(options.multiple === true && { multiple: true as const }),
          },
          ...(supersedes !== undefined && { supersedes }),
        }),
      )
      console.log(
        `Asked the human (request ${request.id}). End your turn; Ted sends you their answer.`,
      )
    },
    agentRun: async () => {
      const name = args[0] ?? ''
      const result = await withDaemon(home, async (client) => {
        let current = await client.runChatCommand({ name })
        while (current.output === undefined) current = await client.waitForChatCommand(current.id)
        return current
      })
      console.log(printable(result.output ?? ''))
      if (result.state !== 'passed')
        exitCode = result.exitCode !== undefined && result.exitCode > 0 ? result.exitCode : 1
    },
    agentRunOutside: async () => {
      const name = args[0] ?? ''
      const argument = args[1]
      const result = await withDaemon(home, (client) =>
        client.runOutsideCommand({ name, ...(argument !== undefined && { argument }) }),
      )
      console.log(result.message)
    },
    chatRound: async () => {
      const supersedes = options.supersedes
      const round = await readRound(options.round ?? '')
      const request = await withDaemon(home, (client) =>
        client.postChatRequest({ round, ...(supersedes !== undefined && { supersedes }) }),
      )
      console.log(
        `Posted Round ${request.round?.number ?? ''} (request ${request.id}). End your turn; Ted sends you the human’s answers.`,
      )
    },
    chatProposal: async () => {
      if (options.file === undefined) throw new UsageError('give the proposal with --file <file>')
      const supersedes = options.supersedes
      const proposal = await readParsedFile(options.file, 'proposal', parseProposalInput)
      const request = await withDaemon(home, (client) =>
        client.postChatRequest({ proposal, ...(supersedes !== undefined && { supersedes }) }),
      )
      console.log(
        `Proposed ${request.proposal?.rows.length ?? 0} Tasks (request ${request.id}). End your turn; Ted sends you the human’s answer.`,
      )
    },
    planProposal: async () => {
      const supersedes = options.supersedes
      if (options.file === undefined) {
        throw new UsageError('give the proposal with --file <file>')
      }
      const input = {
        proposal: await readParsedFile(options.file ?? '', 'proposal', parseProposalInput),
      }
      const request = await withDaemon(home, (client) =>
        client.postPlanRequest({ ...input, ...(supersedes !== undefined && { supersedes }) }),
      )
      const what =
        request.kind === 'round'
          ? `Round ${request.round?.number ?? ''}`
          : `a proposal of ${request.proposal?.rows.length ?? 0} rows`
      console.log(
        `${supersedes === undefined ? 'Posted' : `Replaced request ${supersedes} with`} ${what} (request ${request.id}). Ted sends you the human’s answer.`,
      )
    },
    reposSet: async () => {
      await taskRepos('set', args)
    },
    reposAdd: async () => {
      await taskRepos('add', args)
    },
    reposRemove: async () => {
      await taskRepos('remove', args)
    },
    peers: async () => {
      const page = offset()
      console.log(JSON.stringify(await withDaemon(home, (client) => client.peers(page))))
    },
    peerShow: async () => {
      console.log(JSON.stringify(await withDaemon(home, (client) => client.peer(args[0] ?? ''))))
    },
    peerInbox: async () => {
      const page = offset()
      console.log(JSON.stringify(await withDaemon(home, (client) => client.peerInbox(page))))
    },
    peerWatch: async () => {
      const timeout = Number(options.timeout ?? '25')
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 25)
        throw new UsageError('timeout must be between 0 and 25 seconds')
      await withDaemon(home, async (client) => {
        const cursor = options.cursor ?? (await client.peers()).cursor
        console.log(JSON.stringify(await client.watchPeers(cursor, timeout)))
      })
    },
    peerSend: async () => {
      const operation = options.operation
      if (!operation) throw new UsageError('operation is required for replay-safe sending')
      const text = args.slice(1).join(' ') || (await readStdin())
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) => client.sendPeer(args[0] ?? '', { operation, text })),
        ),
      )
    },
    coordinatorAutomations: async () => {
      console.log(
        JSON.stringify(await withDaemon(home, (client) => client.coordinatorAutomations())),
      )
    },
    coordinatorAutomationShow: async () => {
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) => client.coordinatorAutomation(args[0] ?? '')),
        ),
      )
    },
    coordinatorAutomationDraft: () => coordinatorAutomationDraft('create'),
    coordinatorAutomationChange: () => coordinatorAutomationDraft('edit'),
    coordinatorAutomationDelete: () => coordinatorAutomationDraft('delete'),
    coordinatorTasks: async () => {
      const params = new URLSearchParams({ offset: String(offset()) })
      if (options.all) params.set('all', '1')
      for (const stage of options.stage ?? []) params.append('stage', stage)
      for (const status of options.status ?? []) params.append('status', status)
      if (options.waiting) params.set('waiting', '1')
      if (options.search !== undefined) params.set('search', options.search)
      let query: CoordinatorTaskQuery
      try {
        query = parseCoordinatorTaskQuery(params.toString())
      } catch (error) {
        if (error instanceof RequestValidationError) throw new UsageError(error.message)
        throw error
      }
      console.log(
        JSON.stringify(await withDaemon(home, (client) => client.coordinatorTasks(query))),
      )
    },
    coordinatorTask: async () => {
      const page = offset()
      console.log(
        JSON.stringify(
          await withDaemon(home, (client) => client.coordinatorTask(args[0] ?? '', page)),
        ),
      )
    },
    coordinatorAgents: async () => {
      console.log(JSON.stringify(await withDaemon(home, (client) => client.coordinatorAgents())))
    },
    chatAgentDraft: async () => {
      if (options.file === undefined) throw new UsageError('give the draft with --file <file>')
      const supersedes = options.supersedes
      const agent = await readParsedFile(options.file, 'Agent draft', parseAgentDraftInput)
      const request = await withDaemon(home, (client) =>
        client.postChatRequest({ agent, ...(supersedes !== undefined && { supersedes }) }),
      )
      console.log(
        `Drafted ${request.title ?? 'the Agent'} (request ${request.id}). End your turn; Ted sends you what the human did.`,
      )
    },
    coordinatorCreate: async () => {
      const { operation } = options
      if (!operation) throw new UsageError('operation is required')
      const typed = options.description === '-' ? await readStdin() : (options.description ?? '')
      const neighbours = jsonOption('neighbours')
      const lead =
        options.agent !== undefined
          ? {
              agent: options.agent,
              ...(options.model !== undefined && { model: options.model }),
              ...(options.effort !== undefined && { effort: options.effort }),
            }
          : undefined
      if (lead === undefined && (options.model !== undefined || options.effort !== undefined))
        throw new UsageError('--model and --effort need --provider')
      const input = {
        operation,
        title: args.join(' '),
        ...(typed.trim() !== '' && { description: typed }),
        ...(options.parent !== undefined && { parentId: options.parent }),
        ...(options['blocked-by'] !== undefined && { blockedBy: options['blocked-by'] }),
        ...(options.source !== undefined && { source: options.source }),
        ...(options.priority !== undefined && { priority: options.priority }),
        ...(options['clarify-depth'] !== undefined && {
          clarifyDepth: options['clarify-depth'],
        }),
        ...(lead !== undefined && { lead }),
        ...(options.after !== undefined && { after: options.after }),
        ...(options.before !== undefined && { before: options.before }),
        ...(neighbours !== undefined && { neighbours }),
        ...(options.start && { start: true }),
      }
      let parsed: ReturnType<typeof parseCoordinatorCreate>
      try {
        parsed = parseCoordinatorCreate(input)
      } catch (error) {
        if (error instanceof RequestValidationError) throw new UsageError(error.message)
        throw error
      }
      const receipt = await withDaemon(home, (client) => client.coordinatorCreate(parsed))
      console.log(JSON.stringify(receipt))
    },
    coordinatorStart: async () => coordinatorAct('start'),
    coordinatorMove: async () => coordinatorAct('move'),
    coordinatorTell: async () => coordinatorMessage('tell'),
    coordinatorAnswer: async () => coordinatorMessage('answer'),
    automationList: async () => {
      await automationCommand(home, 'list', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationShow: async () => {
      await automationCommand(home, 'show', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationHistory: async () => {
      await automationCommand(home, 'history', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationCreate: async () => {
      await automationCommand(home, 'create', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationEdit: async () => {
      await automationCommand(home, 'edit', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationEnable: async () => {
      await automationCommand(home, 'enable', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationDisable: async () => {
      await automationCommand(home, 'disable', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationRun: async () => {
      await automationCommand(home, 'run', args, options, { connect: withDaemon, log: console.log })
    },
    automationDelete: async () => {
      await automationCommand(home, 'delete', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationOutput: async () => {
      const runId = tedEnv('TED_RUN', env)
      await automationCommand(home, 'output', args, options, {
        connect: withDaemon,
        log: console.log,
        ...(runId && { runId }),
      })
    },
    automationNote: async () => {
      await automationCommand(home, 'note', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationStart: async () => {
      await automationCommand(home, 'start', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
    automationReport: async () => {
      await automationCommand(home, 'report', args, options, {
        connect: withDaemon,
        log: console.log,
      })
    },
  } satisfies Record<HandlerName, () => Promise<void>>

  try {
    const invocation = parseInvocation(argv, env)
    options = invocation.options
    args = invocation.args
    await handlers[invocation.handler]()
  } catch (error) {
    if (error instanceof NothingToCheckError) {
      console.error(`ted: ${error.message}`)
      exitCode = 1
    } else if (error instanceof AutomationUsageError) {
      console.error(error.message === '' ? helpText() : `ted: ${error.message}`)
      exitCode = 2
    } else if (error instanceof UsageError) {
      console.error(error.message === '' ? helpText() : `ted: ${error.message}`)
      exitCode = 2
    } else {
      console.error(`ted: ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
  }

  return exitCode
}

function heldNote(comment: { held?: true }): string {
  return comment.held
    ? ' The human sees it when your turn ends, below anything else you post before then.'
    : ''
}
