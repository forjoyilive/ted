import type { AgentHealth, Banner, Factory, ListFilters, Task } from '@ted/protocol'
import { planChip, runsPaused } from '@ted/protocol/health'
import { allTasksScope } from '@ted/protocol/list-view'
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { MenuCommand } from '../background.ts'
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
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { RemoveFactoryDialog } from './components/RemoveFactoryDialog.tsx'
import { SearchPalette } from './components/SearchPalette.tsx'
import { ShortcutSheet } from './components/ShortcutSheet.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { pickBlockerEvent, TaskDialog, type TaskDialogKind } from './components/TaskActions.tsx'
import { WorkingRunsPopover } from './components/WorkingRuns.tsx'
import {
  useAgentHealth,
  useAnswered,
  useBanners,
  useConnection,
  useFactoryList,
  useInbox,
  useSettings,
  useSlots,
  useTasks,
} from './data.ts'
import { waitingByFactory } from './inbox.ts'
import {
  armable,
  focusedTaskRef,
  focusFirst,
  moveFocus,
  pressDialogPrimary,
  rankNeighbours,
  requestChangesBox,
} from './key-targets.ts'
import { keyBindings } from './keymap.ts'
import { doneView, failedView, queueView, rankMove } from './list-view.ts'
import {
  backLink,
  currentFactoryId,
  initialNavigation,
  type SettingsSectionId,
  settingsSectionIds,
  startHistory,
  withHistory,
} from './navigation.ts'
import { SettingsShell } from './settings/SettingsShell.tsx'
import { hasWorktree, isShellShortcut, openTaskShell } from './shell.ts'
import { keySequences } from './shortcuts.ts'
import { factoryCapLine, runsLine } from './slots.ts'
import { ted } from './ted.ts'
import { AddFactoryDialog } from './views/AddFactoryDialog.tsx'
import { Board } from './views/Board.tsx'
import { FactorySettings } from './views/FactorySettings.tsx'
import { Inbox } from './views/Inbox.tsx'
import { NewTaskDialog } from './views/NewTaskDialog.tsx'
import { NoFactories } from './views/NoFactories.tsx'
import { Stub } from './views/OtherViews.tsx'
import { saveListView, TaskList } from './views/TaskList.tsx'
import { TaskPanes } from './views/TaskThread.tsx'
import { factoryName } from './views/TaskViews.tsx'

const factoryViewTitles = {
  plans: 'Plans',
  automations: 'Automations',
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

function planFooter(health: readonly AgentHealth[]) {
  const chips = health.flatMap((h) => planChip(h) ?? [])
  return chips.length > 0 ? { planChips: chips } : {}
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
  const tasks = useTasks()
  const { factories, loaded: factoriesLoaded } = useFactoryList()
  const settings = useSettings()
  const settingsOpen = navigation.settings !== undefined
  const slots = useSlots()
  const [runsOpen, setRunsOpen] = useState(false)
  const closeRuns = useCallback(() => setRunsOpen(false), [])
  const [newTaskOpen, setNewTaskOpen] = useState<{ description?: string; factoryId?: string }>()
  const [removing, setRemoving] = useState<Factory>()
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
    removing !== undefined
  const openNewTask = (factoryId?: string) =>
    setNewTaskOpen(factoryId === undefined ? {} : { factoryId })
  const inbox = useInbox()
  const inboxCount = inbox.length
  const inboxScreen = navigation.screen.kind === 'inbox' ? navigation.screen : undefined
  const answered = useAnswered(inboxScreen?.answered === true)
  const waiting: Record<string, { waiting?: number; failed?: boolean }> = {}
  for (const [factoryId, count] of Object.entries(waitingByFactory(inbox))) {
    waiting[factoryId] = { waiting: count }
  }
  const failedTasks = tasks.filter((task) => task.status?.kind === 'failed' && !task.archived)
  for (const task of failedTasks) {
    waiting[task.factoryId] = { ...waiting[task.factoryId], failed: true }
  }

  useEffect(() => {
    if (settings === undefined) return
    document.documentElement.style.setProperty(
      '--terminal-font-size',
      `${settings.terminalFontSize}px`,
    )
  }, [settings])

  const banners = useBanners()
  const agentHealth = useAgentHealth()
  const { connection } = useConnection()
  const offline = connection.state !== 'connected'

  useEffect(() => {
    if (!offline) return
    setNewTaskOpen(undefined)
    setAddFactoryOpen(false)
    setPaletteOpen(false)
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

  useEffect(
    () =>
      ted.onEvent((event) => {
        if (event.type === 'menu-command') onMenuCommand.current(event.command)
      }),
    [],
  )
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || settingsOpen || runsOpen || !isShellShortcut(event)) return
      if (!task || task.archived || !hasWorktree(task)) return
      event.preventDefault()
      openTaskShell(task)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen, runsOpen, task])

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
    reply: () =>
      panes.current !== null &&
      (focusFirst(panes.current, 'textarea[data-answer-box]') ||
        focusFirst(panes.current, 'textarea[data-comment-box]')),
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
    addFactory: () => setAddFactoryOpen(true),
    keys,
  }

  const sequences = useRef(keySequences(keyBindings))
  const onShortcut = useRef<(event: KeyboardEvent) => void>(() => undefined)
  onShortcut.current = (event) => {
    if (event.defaultPrevented || event.isComposing || offline) return
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
    if (banner.action?.choose === 'folder') {
      const folder = await ted.chooseFolder(banner.action.label)
      if (folder === undefined) return
      await ted.actOnBanner(banner.id, { folder }).catch((error: unknown) => console.error(error))
    } else if (!place) {
      await ted.actOnBanner(banner.id).catch((error: unknown) => console.error(error))
    } else if (place.kind === 'settings') {
      const section = settingsSectionIds.find((id) => id === place.section)
      dispatch({ type: 'open-settings', ...(section !== undefined && { section }) })
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
      onDismiss={(banner) => void ted.dismissBanner(banner.id)}
      menu={keepsStoppingMenu}
    />
  )

  function main() {
    const opened = task && (
      <TaskPanes
        task={task}
        tasks={tasks}
        factories={factories}
        backLink={backLink(navigation)}
        requestId={navigation.requestId}
        answeredId={inboxScreen?.answered ? navigation.requestId : undefined}
        onBack={() => dispatch({ type: 'close-task' })}
        onOpenTask={openTaskByRef}
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
      return (
        <Inbox
          items={inbox}
          answered={answered}
          factories={factories}
          factoryId={screen.factoryId}
          showAnswered={screen.answered === true}
          anyTasks={tasks.length > 0}
          selected={navigation.requestId}
          onOpen={({ request, task: on }) =>
            dispatch({
              type: 'open-task',
              taskId: on.id,
              factoryId: on.factoryId,
              requestId: request.id,
            })
          }
          onFilter={(factoryId) => openInbox({ factoryId })}
          onShowAnswered={(show) => openInbox({ answered: show })}
          onNewTask={() => openNewTask()}
        >
          {opened}
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
        const openPlans = () =>
          dispatch({
            type: 'open',
            screen: { kind: 'factory', factoryId: screen.factoryId, view: 'plans' },
          })
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
      <Offline when={offline}>{bannerStack('Problems', appWideBanners(banners))}</Offline>
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

  const frame = (content: ReactNode) => (
    <div className={styles.window}>
      {connection.state === 'reconnecting' && <ReconnectingBar />}
      <ArmedContext value={armed}>
        <div className={styles.app}>{content}</div>
      </ArmedContext>
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
              section={navigation.settings.section}
              settings={settings}
              factories={factories}
              inboxCount={inboxCount}
              stopsWork={sectionsStoppingWork(banners)}
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
          inboxCount={inboxCount}
          badges={{
            ...waiting,
            ...Object.fromEntries(
              [...factoriesStoppingWork(banners)].map((id) => [
                id,
                { ...waiting[id], stopsWork: true },
              ]),
            ),
          }}
          settingsProblem={settingsStopsWork(banners)}
          footer={{
            ...(slots !== undefined && { runs: runsLine(slots) }),
            ...(failedTasks.length > 0 && { failed: `${failedTasks.length} failed` }),
            ...pausedFooter(agentHealth),
            ...planFooter(agentHealth),
          }}
          onOpenFailed={() => {
            saveListView(
              settings,
              allTasksScope,
              failedView(allTasksScope, settings?.listViews),
            ).catch((error: unknown) => console.error(error))
            dispatch({ type: 'open', screen: { kind: 'all-tasks' } })
          }}
          runsOpen={runsOpen}
          onOpenRuns={() => setRunsOpen((open) => !open)}
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
