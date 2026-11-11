import type {
  AgentHealth,
  Automation,
  Banner,
  DriftCounts,
  Factory,
  ListFilters,
  Task,
} from '@ted/protocol'
import { simulatorsLine } from '@ted/protocol/app'
import { runsPaused } from '@ted/protocol/health'
import { allTasksScope } from '@ted/protocol/list-view'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { MenuCommand } from '../background.ts'
import { updateBanner, updateChip, updateFailedProblem } from '../updates.ts'
import styles from './App.module.css'
import { type ArmAction, ArmedContext } from './armed.ts'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  settingsStopsWork,
} from './banners.ts'
import { keepsStoppingBanner, keepsStoppingMenu } from './ConnectionNotice.tsx'
import {
  type Command,
  type CommandContext,
  globalCommands,
  type KeyActions,
  keyCommands,
  taskCommands,
} from './commands.ts'
import { BannerStack } from './components/BannerStack.tsx'
import { EditorPickerHost } from './components/EditorPicker.tsx'
import { FindBar } from './components/FindBar.tsx'
import { PlanUsage } from './components/PlanUsage.tsx'
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { RemoveFactoryDialog } from './components/RemoveFactoryDialog.tsx'
import { resizeSidebarFromKey, SidebarLayout } from './components/ResizableSidebar.tsx'
import { SearchPalette } from './components/SearchPalette.tsx'
import { SetupNoticeDialog } from './components/SetupNoticeDialog.tsx'
import { ShortcutSheet } from './components/ShortcutSheet.tsx'
import { type FactoryBadges, Sidebar } from './components/Sidebar.tsx'
import { pickBlockerEvent, TaskDialog, type TaskDialogKind } from './components/TaskActions.tsx'
import { WorkingRunsPopover } from './components/WorkingRuns.tsx'
import {
  useAgentHealth,
  useAllPlans,
  useAnswered,
  useAutomationOutcomes,
  useAutomationRequests,
  useBanners,
  useConnection,
  useCoordinatorStatuses,
  useDrift,
  useFactoryList,
  useInbox,
  useMenuCommands,
  usePlanInbox,
  useSettingsState,
  useSimulators,
  useSlots,
  useTasks,
  useUpdateStatus,
  useWaitingCount,
} from './data.ts'
import { waitingByFactory } from './inbox.ts'
import {
  armable,
  focusedTaskRef,
  focusFirst,
  moveFocus,
  pressDialogPrimary,
  pressImageNavigation,
  rankNeighbours,
  replyBox,
  requestChangesBox,
} from './key-targets.ts'
import { imageNavigationKey, keyBindings } from './keymap.ts'
import { doneView, failedView, queueView, rankMove } from './list-view.ts'
import {
  backLink,
  currentFactoryId,
  initialNavigation,
  newPlan,
  type SettingsSectionId,
  settingsSectionIds,
  startHistory,
  withHistory,
} from './navigation.ts'
import { OvernightContext } from './overnight.tsx'
import { plansFailedByFactory } from './plans.ts'
import { ProfileProvider } from './profile.tsx'
import { useNotificationsOff } from './settings/NotificationsPage.tsx'
import { SettingsShell } from './settings/SettingsShell.tsx'
import {
  type SetupNotice,
  type SetupNoticeRequest,
  setupNotice,
  setupNoticeEvent,
} from './setup-notice.ts'
import { keySequences } from './shortcuts.ts'
import { factoryCapLine, runsLine } from './slots.ts'
import { ted } from './ted.ts'
import { AddFactoryDialog } from './views/AddFactoryDialog.tsx'
import { AutomationDialog, type TemplateChoice } from './views/AutomationDialog.tsx'
import { AutomationRunView, AutomationsPage, AutomationView } from './views/Automations.tsx'
import { Board } from './views/Board.tsx'
import { CoordinatorView } from './views/Coordinator.tsx'
import { FactorySettings } from './views/FactorySettings.tsx'
import { Inbox } from './views/Inbox.tsx'
import { NewTaskDialog } from './views/NewTaskDialog.tsx'
import { NoFactories } from './views/NoFactories.tsx'
import { Stub } from './views/OtherViews.tsx'
import { PlanChatView } from './views/PlanChat.tsx'
import { PlansList } from './views/PlansList.tsx'
import { saveListView, TaskList } from './views/TaskList.tsx'
import { TaskPanes } from './views/TaskThread.tsx'
import { factoryName } from './views/TaskViews.tsx'

const factoryViewTitles = {
  coordinator: 'Coordinator',
  plans: 'Plans',
  settings: 'Factory settings',
} as const

function sectionsStoppingWork(banners: readonly Banner[]) {
  const stopping: Partial<Record<SettingsSectionId, boolean>> = {}
  for (const banner of banners) {
    const place = banner.action?.opens
    const named = place?.kind === 'settings' ? place.section : banner.action?.section
    if (banner.severity !== 'stops-work' || named === undefined) continue
    const section = settingsSectionIds.find((id) => id === named)
    if (section !== undefined) stopping[section] = true
  }
  return stopping
}

function pausedFooter(health: readonly AgentHealth[]) {
  const paused = health
    .filter((h) => h.state !== 'ready')
    .reduce((total, h) => total + h.pausedRuns, 0)
  return paused > 0 ? { paused: runsPaused(paused) } : {}
}

function factoryBadges(
  waiting: Readonly<Record<string, FactoryBadges>>,
  stopping: ReadonlySet<string>,
  drift: DriftCounts | undefined,
): Record<string, FactoryBadges> {
  const ids = new Set([
    ...Object.keys(waiting),
    ...stopping,
    ...Object.keys(drift?.factories ?? {}),
  ])
  return Object.fromEntries(
    [...ids].map((id) => {
      const drifted = drift?.factories[id] ?? 0
      return [
        id,
        {
          ...waiting[id],
          ...(stopping.has(id) && { stopsWork: true }),
          ...(drifted > 0 && { drift: drifted }),
        },
      ]
    }),
  )
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

const allowedInSettings = new Set([
  'search',
  'settings',
  'close',
  'back',
  'forward',
  'shortcuts',
  'send',
  'go-to-inbox',
  'go-to-all-tasks',
  'go-to-board',
  'go-to-list',
  'go-to-plans',
])

const cardDialogs: Partial<Record<string, TaskDialogKind>> = {
  edit: 'edit',
  archive: 'archive',
  delete: 'delete',
  'follow-up': 'follow-up',
}

function report(error: unknown) {
  console.error(error)
}

function Offline({ when, children }: { when: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={when} className={when ? styles.offline : styles.online}>
      {children}
    </fieldset>
  )
}

export function App({ addFactoryFirst = false }: { addFactoryFirst?: boolean }) {
  const [history, dispatch] = useReducer(withHistory, initialNavigation, startHistory)
  const navigation = history.now
  const revealRequest = useMemo(
    () => (navigation.requestId === undefined ? undefined : { id: navigation.requestId }),
    [navigation],
  )
  const tasks = useTasks()
  const { factories, loaded: factoriesLoaded } = useFactoryList()
  const settingsResource = useSettingsState()
  const settings = settingsResource.settings
  const settingsOpen = navigation.settings !== undefined
  const slots = useSlots()
  const drift = useDrift()
  const simulators = useSimulators()
  const simulatorsFooter = simulators && simulatorsLine(simulators)
  const [runsOpen, setRunsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const closeUsage = useCallback(() => setUsageOpen(false), [])
  useEffect(() => {
    void navigation
    setUsageOpen(false)
  }, [navigation])
  const closeRuns = useCallback(() => setRunsOpen(false), [])
  const [newTaskOpen, setNewTaskOpen] = useState<{ description?: string; factoryId?: string }>()
  const [removing, setRemoving] = useState<Factory>()
  const [automationDialog, setAutomationDialog] = useState<{
    factoryId?: string
    template?: TemplateChoice
    editing?: Automation
  }>()
  const [asking, setAsking] = useState<{ request: SetupNoticeRequest; notice: SetupNotice }>()
  const latest = useRef({ tasks, factories })
  latest.current = { tasks, factories }
  useEffect(() => {
    const ask = (event: Event) => {
      const request = (event as CustomEvent<SetupNoticeRequest>).detail
      const { tasks: all, factories: known } = latest.current
      const notice = setupNotice(
        known.find((f) => f.id === request.task.factoryId),
        all,
        request.task,
      )
      if (!notice) return
      event.preventDefault()
      setAsking({ request, notice })
    }
    window.addEventListener(setupNoticeEvent, ask)
    return () => window.removeEventListener(setupNoticeEvent, ask)
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteChoose, setPaletteChoose] = useState<Command>()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [armed, setArmed] = useState<HTMLButtonElement>()
  const [cardDialog, setCardDialog] = useState<{ taskId: string; kind: TaskDialogKind }>()
  const [pendingPick, setPendingPick] = useState<string>()
  const [findAt, setFindAt] = useState<string>()
  const panes = useRef<HTMLDivElement>(null)
  const place = JSON.stringify([navigation.screen, navigation.taskId, navigation.settings])
  const [addFactoryOpen, setAddFactoryOpen] = useState(false)
  const addFactoryPending = useRef(addFactoryFirst)
  useEffect(() => {
    if (!factoriesLoaded || !addFactoryPending.current) return
    addFactoryPending.current = false
    setAddFactoryOpen(true)
  }, [factoriesLoaded])
  const [boardFilters, setBoardFilters] = useState<Readonly<Record<string, ListFilters>>>({})
  const dialogOpen =
    newTaskOpen !== undefined ||
    addFactoryOpen ||
    paletteOpen ||
    sheetOpen ||
    cardDialog !== undefined ||
    removing !== undefined ||
    automationDialog !== undefined
  const openNewTask = (factoryId?: string) =>
    setNewTaskOpen(factoryId === undefined ? {} : { factoryId })
  const inbox = useInbox()
  const questions = useAutomationRequests()
  const allAutomations = useAutomationOutcomes()
  const planInbox = usePlanInbox()
  const inboxCount = useWaitingCount()
  const notificationsOff = useNotificationsOff()
  const inboxScreen = navigation.screen.kind === 'inbox' ? navigation.screen : undefined
  const answered = useAnswered(inboxScreen?.answered === true)
  const allPlans = useAllPlans()
  const coordinatorStatuses = useCoordinatorStatuses()
  const waiting: Record<string, FactoryBadges> = {}
  for (const [factoryId, count] of Object.entries(waitingByFactory(inbox, questions, planInbox))) {
    waiting[factoryId] = { waiting: count }
  }
  for (const automation of allAutomations ?? []) {
    if (automation.last?.result.kind !== 'failed') continue
    waiting[automation.factoryId] = { ...waiting[automation.factoryId], automationFailed: true }
  }
  const failedTasks = tasks.filter((task) => task.status?.kind === 'failed' && !task.archived)
  for (const task of failedTasks) {
    waiting[task.factoryId] = { ...waiting[task.factoryId], failed: true }
  }
  for (const { factoryId, status } of coordinatorStatuses) {
    if (status !== 'ready') waiting[factoryId] = { ...waiting[factoryId], coordinator: status }
  }
  for (const factoryId of plansFailedByFactory(allPlans)) {
    waiting[factoryId] = { ...waiting[factoryId], plansFailed: true }
  }

  useEffect(() => {
    if (settings === undefined) return
    document.documentElement.style.setProperty('--text-scale', String(settings.textSize / 100))
    document.documentElement.style.setProperty(
      '--terminal-font-size',
      `${settings.terminalFontSize}px`,
    )
  }, [settings])

  const banners = useBanners()
  const updateStatus = useUpdateStatus()
  const [updateFailureShownAt] = useState(() => new Date().toISOString())
  const [updateFailureDismissed, setUpdateFailureDismissed] = useState(false)
  const shownUpdateBanner = updateFailureDismissed
    ? []
    : updateBanner(updateStatus, updateFailureShownAt)
  const chip = updateChip(updateStatus)
  const agentHealth = useAgentHealth()
  const { connection } = useConnection()
  const offline = connection.state !== 'connected'

  useEffect(() => {
    if (!offline) return
    setUsageOpen(false)
    setNewTaskOpen(undefined)
    setAddFactoryOpen(false)
    setPaletteOpen(false)
    setAutomationDialog(undefined)
  }, [offline])

  const shownFactoryId =
    navigation.screen.kind === 'factory' ? navigation.screen.factoryId : undefined
  useEffect(() => {
    if (!factoriesLoaded || shownFactoryId === undefined) return
    if (!factories.some((f) => f.id === shownFactoryId)) {
      dispatch({ type: 'open', screen: { kind: 'inbox' } })
    }
  }, [factories, factoriesLoaded, shownFactoryId])

  useEffect(() => {
    if (!offline) return
    const block = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="menu"], [aria-label="Problems"]')) return
      event.stopImmediatePropagation()
      event.preventDefault()
    }
    window.addEventListener('keydown', block, { capture: true })
    return () => window.removeEventListener('keydown', block, { capture: true })
  }, [offline])
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)

  const onMenuCommand = useRef<(command: MenuCommand) => void>(() => undefined)

  useMenuCommands((command) => onMenuCommand.current(command))
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return
      if (dialogOpen || document.querySelector('dialog[open]')) return
      event.preventDefault()
      setFindAt(place)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, place])

  const keys: KeyActions = {
    togglePalette: () => {
      if (newTaskOpen !== undefined || addFactoryOpen) return false
      if (!paletteOpen && document.querySelector('dialog[open]')) return false
      setPaletteChoose(undefined)
      setPaletteOpen((open) => !open)
      return true
    },
    openSheet: () => setSheetOpen(true),
    back: () => dispatch({ type: 'back' }),
    forward: () => dispatch({ type: 'forward' }),
    close: () => {
      if (usageOpen) {
        closeUsage()
        return true
      }
      if (settingsOpen) dispatch({ type: 'close-settings' })
      else if (navigation.taskId !== undefined) dispatch({ type: 'close-task' })
      else return false
      return true
    },
    move: (direction) => panes.current !== null && moveFocus(panes.current, direction),
    arm: (action: ArmAction) => {
      const button = panes.current ? armable(panes.current, action) : undefined
      setArmed(button)
      return button !== undefined
    },
    reply: () => {
      const box = panes.current ? replyBox(panes.current) : undefined
      box?.focus()
      return box !== undefined
    },
    requestChanges: () => {
      const box = panes.current ? requestChangesBox(panes.current) : undefined
      box?.focus()
      return box !== undefined
    },
    pressDialogPrimary,
    focusFilter: () => panes.current !== null && focusFirst(panes.current, '[data-filter-box]'),
    moveInRank: (direction) => {
      const around = rankNeighbours()
      if (!around) return false
      const ordered = around.order.flatMap((ref) => tasks.find((t) => t.displayId === ref) ?? [])
      const moving = ordered.find((t) => t.displayId === around.ref)
      const placed = moving && rankMove(ordered, moving.id, direction)
      if (!moving || !placed) return false
      ted.moveTask(moving.id, placed).catch(report)
      return true
    },
  }

  const commandContext: CommandContext = {
    task: settingsOpen ? undefined : task,
    factories,
    factoryId: currentFactoryId(navigation, tasks),
    dispatch,
    newTask: (description) => setNewTaskOpen(description === undefined ? {} : { description }),
    newAutomation: () => newAutomation(currentFactoryId(navigation, tasks)),
    addFactory: () => setAddFactoryOpen(true),
    keys,
  }

  const sequences = useRef(keySequences(keyBindings))
  const onShortcut = useRef<(event: KeyboardEvent) => void>(() => undefined)
  onShortcut.current = (event) => {
    if (event.defaultPrevented || event.isComposing) return
    const imageDirection = imageNavigationKey(event)
    if (imageDirection && !isTyping(event.target) && pressImageNavigation(imageDirection)) {
      sequences.current.reset()
      event.preventDefault()
      return
    }
    if (offline) return
    if (resizeSidebarFromKey(event)) {
      sequences.current.reset()
      return
    }
    const commandKey = event.metaKey || event.ctrlKey
    const typing = isTyping(event.target)
    if (typing && !commandKey) {
      sequences.current.reset()
      return
    }
    const found = sequences.current.feed(event, event.timeStamp)
    if (typing && found !== 'pending' && found?.id === 'archive') return
    if (found === 'pending') {
      event.preventDefault()
      return
    }
    if (!found || runsOpen) return
    if (usageOpen && found.id !== 'close') return
    if (settingsOpen && !allowedInSettings.has(found.id)) return
    if (!commandKey && document.querySelector('[role="menu"]')) return
    const anyDialog = dialogOpen || document.querySelector('dialog[open]') !== null
    const factoryNumber = /^factory:(\d)$/.exec(found.id)?.[1]
    if (factoryNumber !== undefined) {
      const factory = factories[Number(factoryNumber) - 1]
      if (!factory || anyDialog) return
      event.preventDefault()
      dispatch({ type: 'open-factory', factoryId: factory.id })
      return
    }
    const focused = focusedTaskRef()
    const target = settingsOpen
      ? undefined
      : (task ?? tasks.find((t) => focused !== undefined && t.displayId === focused))
    const command = [
      ...(target ? taskCommands(target) : []),
      ...globalCommands,
      ...keyCommands,
    ].find((c) => c.shortcuts === found.shortcuts)
    if (!command || (anyDialog && !command.inDialogs)) return
    if (command.choices) {
      event.preventDefault()
      setPaletteChoose(command)
      setPaletteOpen(true)
      return
    }
    const onCard = target !== undefined && target.id !== task?.id
    const dialogKind = onCard ? cardDialogs[command.id] : undefined
    if (target && dialogKind) {
      event.preventDefault()
      setCardDialog({ taskId: target.id, kind: dialogKind })
      return
    }
    if (target && onCard && command.id === 'blocked-by') {
      event.preventDefault()
      setPendingPick(target.id)
      openTask(target)
      return
    }
    const outcome = command.run?.(commandContext)
    if (outcome === false) return
    event.preventDefault()
    if (outcome instanceof Promise) outcome.catch(report)
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  useEffect(() => {
    if (!armed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.key === 'Enter' && armed.isConnected && !armed.disabled) armed.click()
      }
      setArmed(undefined)
    }
    const disarm = () => setArmed(undefined)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', disarm, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('pointerdown', disarm, { capture: true })
    }
  }, [armed])

  useEffect(() => {
    if (pendingPick === undefined || pendingPick !== navigation.taskId) return
    setPendingPick(undefined)
    window.dispatchEvent(new CustomEvent(pickBlockerEvent, { detail: pendingPick }))
  }, [pendingPick, navigation.taskId])

  const openTaskByRef = (ref: string) => {
    const found = tasks.find((t) => t.displayId === ref || t.id === ref)
    if (found) openTask(found)
  }

  async function act(banner: Banner) {
    const place = banner.action?.opens
    if (banner.problem === updateFailedProblem) {
      await ted.downloadTed().catch((error: unknown) => console.error(error))
    } else if (banner.action?.choose === 'folder') {
      const folder = await ted.chooseFolder(banner.action.label)
      if (folder === undefined) return
      await ted.actOnBanner(banner.id, { folder }).catch((error: unknown) => console.error(error))
    } else if (!place) {
      await ted.actOnBanner(banner.id).catch((error: unknown) => console.error(error))
    } else if (place.kind === 'settings') {
      const section = settingsSectionIds.find((id) => id === place.section)
      dispatch({ type: 'open-settings', ...(section !== undefined && { section }) })
    } else if (place.kind === 'automation') {
      dispatch({
        type: 'open-automation',
        automationId: place.automationId,
        factoryId: place.factoryId,
      })
    } else if (place.kind === 'factory-settings') {
      dispatch({
        type: 'open',
        screen: { kind: 'factory', factoryId: place.factoryId, view: 'settings' },
      })
    } else {
      dispatch({ type: 'open-task', taskId: place.taskId })
    }
  }

  onMenuCommand.current = (command) => {
    if (offline) return
    if (command.kind === 'open-inbox') dispatch({ type: 'open', screen: { kind: 'inbox' } })
    if (command.kind === 'open-inbox-request') {
      dispatch({
        type: 'open-inbox-request',
        taskId: command.taskId,
        factoryId: command.factoryId,
        requestId: command.requestId,
      })
    }
    if (command.kind === 'new-task') openNewTask()
    if (command.kind === 'open-task') {
      dispatch({ type: 'open-task', taskId: command.taskId, factoryId: command.factoryId })
    }
    if (command.kind === 'settings') {
      const section = settingsSectionIds.find((id) => id === command.section)
      dispatch({ type: 'open-settings', ...(section !== undefined && { section }) })
    }
    if (command.kind === 'banner') {
      const banner = banners.find((b) => b.id === command.bannerId)
      if (banner) void act(banner)
    }
  }

  const bannerStack = (label: string, shown: Banner[]) => (
    <BannerStack
      label={label}
      banners={shown}
      onAction={act}
      onDismiss={(banner) =>
        banner.problem === updateFailedProblem
          ? setUpdateFailureDismissed(true)
          : void ted.dismissBanner(banner.id)
      }
      menu={keepsStoppingMenu}
    />
  )

  const newAutomation = (factoryId?: string, template?: TemplateChoice) => {
    if (factories.length === 0) return setAddFactoryOpen(true)
    setAutomationDialog({
      ...(factoryId !== undefined && { factoryId }),
      ...(template !== undefined && { template }),
    })
  }
  const openAutomation = (automation: Pick<Automation, 'id' | 'factoryId'>, runId?: string) =>
    dispatch({
      type: 'open-automation',
      automationId: automation.id,
      factoryId: automation.factoryId,
      ...(runId !== undefined && { runId }),
    })
  const automationBanners = (factoryId: string, automationId: string) =>
    bannerStack(
      'Automation problems',
      factoryBanners(banners, factoryId)
        .filter(
          (b) =>
            b.action?.opens?.kind === 'automation' && b.action.opens.automationId === automationId,
        )
        .map(({ action: _, ...banner }) => banner),
    )
  const automationRun = (automationId: string, runId: string) => (
    <AutomationRunView
      key={runId}
      automationId={automationId}
      runId={runId}
      tasks={tasks}
      onBack={() => dispatch({ type: 'close-automation' })}
      onOpenAutomation={() => dispatch({ type: 'close-automation' })}
      onOpenTask={openTaskByRef}
    />
  )

  function main() {
    const opened = task && (
      <TaskPanes
        key={task.id}
        task={task}
        tasks={tasks}
        factories={factories}
        backLink={backLink(navigation)}
        revealRequest={revealRequest}
        answeredId={inboxScreen?.answered ? navigation.requestId : undefined}
        onBack={() => dispatch({ type: 'close-task' })}
        onOpenTask={openTaskByRef}
        onOpenPlan={(planId) => dispatch({ type: 'open-plan', factoryId: task.factoryId, planId })}
        onFollowedUp={openTask}
      />
    )
    const { screen } = navigation
    const noFactories = factoriesLoaded && factories.length === 0 && tasks.length === 0
    if (screen.kind === 'inbox' && noFactories && !opened && inbox.length === 0) {
      return <NoFactories onAddFactory={() => setAddFactoryOpen(true)} />
    }
    if (screen.kind === 'inbox') {
      const openInbox = (change: { factoryId?: string | undefined; answered?: boolean }) => {
        const factoryId = 'factoryId' in change ? change.factoryId : screen.factoryId
        const showAnswered = change.answered ?? screen.answered === true
        dispatch({
          type: 'open',
          screen: {
            kind: 'inbox',
            ...(factoryId !== undefined && { factoryId }),
            ...(showAnswered && { answered: true }),
          },
        })
      }
      const planFactory =
        navigation.planId === undefined
          ? undefined
          : factories.find((factory) => factory.id === navigation.lastFactoryId)
      const planned =
        planFactory && navigation.planId ? (
          <PlanChatView
            key={navigation.planId}
            factory={planFactory}
            planId={navigation.planId}
            revealRequest={revealRequest}
            backLabel="← Inbox"
            onBack={() => dispatch({ type: 'open', screen })}
            onDeleted={() => dispatch({ type: 'open', screen })}
            onOpenTask={openTaskByRef}
            onOpenPlan={(planId) =>
              dispatch({ type: 'open-plan', factoryId: planFactory.id, planId })
            }
            onPlanMore={(from) => dispatch({ type: 'open-plan', factoryId: planFactory.id, from })}
          />
        ) : undefined
      return (
        <Inbox
          items={inbox}
          plans={planInbox}
          onOpenPlan={({ plan, request }) =>
            dispatch({
              type: 'open-plan',
              factoryId: plan.factoryId,
              planId: plan.id,
              requestId: request.id,
            })
          }
          answered={answered}
          factories={factories}
          factoryId={screen.factoryId}
          showAnswered={screen.answered === true}
          anyTasks={tasks.length > 0}
          selected={navigation.requestId}
          onClear={() => dispatch({ type: 'open', screen })}
          onOpen={({ request, task: on }) =>
            dispatch({
              type: 'open-task',
              taskId: on.id,
              factoryId: on.factoryId,
              requestId: request.id,
            })
          }
          questions={questions}
          onOpenQuestion={(question) =>
            dispatch({
              type: 'open-automation',
              automationId: question.automationId,
              factoryId: question.factoryId,
              runId: question.runId,
              requestId: question.id,
            })
          }
          onFilter={(factoryId) => openInbox({ factoryId })}
          onShowAnswered={(show) => openInbox({ answered: show })}
          onNewTask={() => openNewTask()}
        >
          {opened ??
            planned ??
            (navigation.automation?.runId === undefined
              ? undefined
              : automationRun(navigation.automation.id, navigation.automation.runId))}
        </Inbox>
      )
    }
    if (opened) return opened
    switch (screen.kind) {
      case 'all-tasks':
        return (
          <TaskList
            scope={allTasksScope}
            title="All Tasks"
            tasks={tasks}
            factories={factories}
            settings={settings}
            onOpen={openTask}
            onOpenTask={openTaskByRef}
            onNewTask={() => openNewTask()}
          />
        )
      case 'factory': {
        const name = factoryName(factories, screen.factoryId)
        const inFactory = tasks.filter((t) => t.factoryId === screen.factoryId)
        const factory = factories.find((f) => f.id === screen.factoryId)
        const view = {
          title: name,
          capLine: factoryCapLine(slots, screen.factoryId),
          tasks: inFactory,
          factories,
          onOpen: openTask,
          onNewTask: () => openNewTask(),
          banners: bannerStack(`${name} problems`, factoryBanners(banners, screen.factoryId)),
        }
        const openPlans = () => dispatch({ type: 'open-plan', factoryId: screen.factoryId })
        if (screen.view === 'board') {
          return (
            <Board
              {...view}
              factoryId={screen.factoryId}
              factory={factory}
              queue={slots?.queue ?? []}
              filters={boardFilters[screen.factoryId] ?? {}}
              onFilters={(filters) =>
                setBoardFilters((all) => ({ ...all, [screen.factoryId]: filters }))
              }
              onOpenTask={openTaskByRef}
              onPlan={openPlans}
              onShowAllDone={() => {
                saveListView(
                  settings,
                  screen.factoryId,
                  doneView(screen.factoryId, settings?.listViews),
                ).catch((error: unknown) => console.error(error))
                dispatch({
                  type: 'open',
                  screen: { kind: 'factory', factoryId: screen.factoryId, view: 'list' },
                })
              }}
            />
          )
        }
        if (screen.view === 'list') {
          return (
            <TaskList
              {...view}
              scope={screen.factoryId}
              breadcrumb="List"
              settings={settings}
              onOpenTask={openTaskByRef}
              onPlan={openPlans}
            />
          )
        }
        if (screen.view === 'settings' && factory) {
          return (
            <FactorySettings
              key={factory.id}
              factory={factory}
              banners={view.banners}
              onOpenFactory={(factoryId) =>
                dispatch({ type: 'open', screen: { kind: 'factory', factoryId, view: 'board' } })
              }
              onOpenGitHubSettings={() =>
                dispatch({ type: 'open-settings', section: 'integrations' })
              }
              onRemoveFactory={() => setRemoving(factory)}
              onOpenTask={openTask}
            />
          )
        }
        if (screen.view === 'automations') {
          const open = navigation.automation
          if (open?.runId !== undefined) return automationRun(open.id, open.runId)
          if (open) {
            return (
              <AutomationView
                key={open.id}
                automationId={open.id}
                banners={automationBanners(screen.factoryId, open.id)}
                settings={settings}
                onBack={() => dispatch({ type: 'close-automation' })}
                onOpenRun={(runId) =>
                  openAutomation({ id: open.id, factoryId: screen.factoryId }, runId)
                }
                onEdit={(editing) => setAutomationDialog({ editing })}
                onOpenAutomation={openAutomation}
                onOpenTask={openTaskByRef}
              />
            )
          }
          return (
            <AutomationsPage
              factory={factory}
              banners={view.banners}
              onOpen={openAutomation}
              onNew={(template) => newAutomation(screen.factoryId, template)}
              onOpenTask={openTaskByRef}
            />
          )
        }
        if (screen.view === 'coordinator' && factory)
          return <CoordinatorView key={factory.id} factory={factory} onOpenTask={openTaskByRef} />
        if (screen.view === 'plans' && factory) {
          const backToPlans = () =>
            dispatch({
              type: 'open',
              screen: { kind: 'factory', factoryId: factory.id, view: 'plans' },
            })
          const planMore = (from: string) =>
            dispatch({ type: 'open-plan', factoryId: factory.id, from })
          if (navigation.planId !== undefined) {
            return (
              <PlanChatView
                key={navigation.planId}
                factory={factory}
                planId={navigation.planId === newPlan ? undefined : navigation.planId}
                revealRequest={revealRequest}
                onBack={backToPlans}
                {...(navigation.planFrom !== undefined && { from: navigation.planFrom })}
                onOpenPlan={(planId) =>
                  dispatch({ type: 'open-plan', factoryId: factory.id, planId })
                }
                onPlanMore={planMore}
                onOpenTask={openTaskByRef}
                onDeleted={backToPlans}
              />
            )
          }
          return (
            <PlansList
              factory={factory}
              banners={view.banners}
              onPlan={openPlans}
              onOpenPlan={(planId) =>
                dispatch({ type: 'open-plan', factoryId: factory.id, planId })
              }
              onPlanMore={planMore}
              onOpenTask={openTaskByRef}
            />
          )
        }
        return <Stub title={`${name} · ${factoryViewTitles[screen.view]}`} banners={view.banners} />
      }
    }
  }

  const problems =
    connection.state === 'stopped' ? (
      bannerStack('Problems', keepsStoppingBanner(connection))
    ) : (
      <Offline when={offline}>
        {bannerStack('Problems', [...appWideBanners(banners), ...shownUpdateBanner])}
      </Offline>
    )

  const palette = paletteOpen && (
    <SearchPalette
      context={commandContext}
      factoryId={currentFactoryId(navigation, tasks)}
      choose={paletteChoose}
      onOpenTask={(taskId, factoryId) => {
        if (settingsOpen) dispatch({ type: 'close-settings' })
        dispatch({ type: 'open-task', taskId, factoryId })
      }}
      onOpenFactory={(factoryId) => dispatch({ type: 'open-factory', factoryId })}
      onClose={() => {
        setPaletteOpen(false)
        setPaletteChoose(undefined)
      }}
    />
  )

  const cardDialogTask = cardDialog && tasks.find((t) => t.id === cardDialog.taskId)
  const overlays = (
    <>
      {sheetOpen && <ShortcutSheet onClose={() => setSheetOpen(false)} />}
      {cardDialog && cardDialogTask && (
        <TaskDialog
          task={cardDialogTask}
          kind={cardDialog.kind}
          onKind={(kind) =>
            setCardDialog(kind === undefined ? undefined : { taskId: cardDialog.taskId, kind })
          }
          onFollowedUp={openTask}
        />
      )}
    </>
  )

  const find = findAt === place && <FindBar scope={panes} onClose={() => setFindAt(undefined)} />

  const dialogs = (
    <>
      <EditorPickerHost />
      {addFactoryOpen && (
        <AddFactoryDialog
          factories={factories}
          onClose={() => setAddFactoryOpen(false)}
          onAdded={(added) => {
            setAddFactoryOpen(false)
            dispatch({
              type: 'open',
              screen: { kind: 'factory', factoryId: added.id, view: 'board' },
            })
          }}
          onOpenFactory={(factoryId) => {
            setAddFactoryOpen(false)
            dispatch({ type: 'open', screen: { kind: 'factory', factoryId, view: 'board' } })
          }}
          onOpenGitHubSettings={() => {
            setAddFactoryOpen(false)
            dispatch({ type: 'open-settings', section: 'integrations' })
          }}
        />
      )}
      {newTaskOpen && (
        <NewTaskDialog
          factories={factories}
          tasks={tasks}
          factoryId={newTaskOpen.factoryId ?? currentFactoryId(navigation, tasks)}
          {...(newTaskOpen.description !== undefined && {
            initialDescription: newTaskOpen.description,
          })}
          onClose={() => setNewTaskOpen(undefined)}
          onOpenTask={openTask}
        />
      )}
      {asking && (
        <SetupNoticeDialog
          task={asking.request.task}
          notice={asking.notice}
          onStart={() => {
            asking.request.resolve(true)
            setAsking(undefined)
          }}
          onCancel={() => {
            asking.request.resolve(false)
            setAsking(undefined)
          }}
          onOpenTask={openTask}
        />
      )}
      {automationDialog && (
        <AutomationDialog
          factories={factories}
          factoryId={automationDialog.factoryId ?? currentFactoryId(navigation, tasks)}
          {...(automationDialog.editing && { editing: automationDialog.editing })}
          {...(automationDialog.template && { template: automationDialog.template })}
          onClose={() => setAutomationDialog(undefined)}
          onSaved={(saved) => {
            setAutomationDialog(undefined)
            if (!automationDialog.editing) openAutomation(saved)
          }}
        />
      )}
      {removing && (
        <RemoveFactoryDialog
          factory={removing}
          onClose={() => setRemoving(undefined)}
          onRemoved={() => {
            setRemoving(undefined)
            dispatch({ type: 'open', screen: { kind: 'inbox' } })
          }}
        />
      )}
    </>
  )

  const overnight = {
    on: settings?.overnightMode === true,
    openGeneral: () => dispatch({ type: 'open-settings', section: 'general' }),
  }
  const frame = (content: ReactNode) => (
    <div className={styles.window} data-loaded={factoriesLoaded}>
      {connection.state === 'reconnecting' && <ReconnectingBar />}
      <ProfileProvider settings={settings}>
        <OvernightContext value={overnight}>
          <ArmedContext value={armed}>
            <SidebarLayout className={styles.app}>{content}</SidebarLayout>
          </ArmedContext>
        </OvernightContext>
      </ProfileProvider>
    </div>
  )

  if (navigation.settings) {
    return frame(
      <div className={styles.main}>
        {problems}
        <Offline when={offline}>
          <div ref={panes} className={styles.panes}>
            {find}
            <SettingsShell
              error={settingsResource.error}
              retry={settingsResource.retry}
              section={navigation.settings.section}
              settings={settings}
              factories={factories}
              inboxCount={inboxCount}
              stopsWork={{
                ...sectionsStoppingWork(banners),
                ...(notificationsOff && { notifications: true }),
              }}
              counts={{ library: drift?.library ?? 0 }}
              dispatch={dispatch}
            />
          </div>
        </Offline>
        {palette}
        {dialogs}
        {overlays}
      </div>,
    )
  }

  return frame(
    <>
      <Offline when={offline}>
        <Sidebar
          navigation={navigation}
          factories={factories}
          currentFactoryId={currentFactoryId(navigation, tasks)}
          developerMode={settings?.developerMode ?? false}
          inboxCount={inboxCount}
          badges={factoryBadges(waiting, factoriesStoppingWork(banners), drift)}
          settingsProblem={settingsStopsWork(banners)}
          footer={{
            ...(slots !== undefined && { runs: runsLine(slots) }),
            ...(simulatorsFooter !== undefined && { simulators: simulatorsFooter }),
            ...(failedTasks.length > 0 && { failed: `${failedTasks.length} failed` }),
            ...pausedFooter(agentHealth),
            ...(settings?.overnightMode && { overnight: 'Overnight mode is on' }),
            ...(chip !== undefined && { update: chip }),
          }}
          onUpdate={() =>
            void ted.restartToUpdate().catch((error: unknown) => console.error(error))
          }
          onOpenFailed={() => {
            saveListView(
              settings,
              allTasksScope,
              failedView(allTasksScope, settings?.listViews),
            ).catch((error: unknown) => console.error(error))
            dispatch({ type: 'open', screen: { kind: 'all-tasks' } })
          }}
          runsOpen={runsOpen}
          onOpenRuns={() => {
            setUsageOpen(false)
            setRunsOpen((open) => !open)
          }}
          usage={
            <PlanUsage
              health={agentHealth}
              billing={
                settings?.billing ?? {
                  claude: 'subscription',
                  codex: 'subscription',
                  antigravity: 'subscription',
                }
              }
              open={usageOpen}
              onToggle={() => {
                setRunsOpen(false)
                setUsageOpen((open) => !open)
              }}
              onClose={closeUsage}
              onSettings={() => {
                setUsageOpen(false)
                dispatch({ type: 'open-settings', section: 'agents' })
              }}
            />
          }
          dispatch={dispatch}
          onNewTask={openNewTask}
          onSearch={() => setPaletteOpen(true)}
          onAddFactory={() => setAddFactoryOpen(true)}
          onRemoveFactory={setRemoving}
        />
        {runsOpen && slots && (
          <WorkingRunsPopover
            slots={slots}
            factories={factories}
            onClose={closeRuns}
            onOpenList={() => {
              setRunsOpen(false)
              saveListView(
                settings,
                allTasksScope,
                queueView(allTasksScope, settings?.listViews),
              ).catch((error: unknown) => console.error(error))
              dispatch({ type: 'open', screen: { kind: 'all-tasks' } })
            }}
          />
        )}
      </Offline>
      <main className={styles.main}>
        {problems}
        <Offline when={offline}>
          <div ref={panes} className={styles.panes}>
            {find}
            {main()}
          </div>
        </Offline>
      </main>
      {palette}
      {dialogs}
      {overlays}
    </>,
  )
}
