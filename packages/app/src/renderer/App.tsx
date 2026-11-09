import type { AgentHealth, Automation, Banner, Factory, ListFilters, Task } from '@ted/protocol'
import { planChip, runsPaused } from '@ted/protocol/health'
import { allTasksScope } from '@ted/protocol/list-view'
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { MenuCommand } from '../background.ts'
import styles from './App.module.css'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  settingsStopsWork,
} from './banners.ts'
import { keepsStoppingBanner, keepsStoppingMenu } from './ConnectionNotice.tsx'
import { archiveTaskEvent } from './components/ArchiveDialogs.tsx'
import { BannerStack } from './components/BannerStack.tsx'
import { FindBar } from './components/FindBar.tsx'
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { RemoveFactoryDialog } from './components/RemoveFactoryDialog.tsx'
import { SearchPalette } from './components/SearchPalette.tsx'
import { type FactoryBadges, Sidebar } from './components/Sidebar.tsx'
import { WorkingRunsPopover } from './components/WorkingRuns.tsx'
import {
  useAgentHealth,
  useAnswered,
  useAutomationRequests,
  useAutomations,
  useBanners,
  useConnection,
  useFactoryList,
  useInbox,
  useSettings,
  useSlots,
  useTasks,
} from './data.ts'
import { waitingByFactory } from './inbox.ts'
import { doneView, failedView, queueView } from './list-view.ts'
import {
  backLink,
  currentFactoryId,
  initialNavigation,
  navigate,
  type SettingsSectionId,
  settingsSectionIds,
} from './navigation.ts'
import { SettingsShell } from './settings/SettingsShell.tsx'
import { factoryCapLine, runsLine } from './slots.ts'
import { runStatusAction, shortcutAction } from './task-actions.ts'
import { ted } from './ted.ts'
import { AddFactoryDialog } from './views/AddFactoryDialog.tsx'
import { AutomationDialog, type TemplateChoice } from './views/AutomationDialog.tsx'
import { AutomationRunView, AutomationsPage, AutomationView } from './views/Automations.tsx'
import { Board } from './views/Board.tsx'
import { editTaskEvent } from './views/EditTaskDialog.tsx'
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

function Offline({ when, children }: { when: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={when} className={when ? styles.offline : styles.online}>
      {children}
    </fieldset>
  )
}

export function App({ addFactoryFirst = false }: { addFactoryFirst?: boolean }) {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation)
  const tasks = useTasks()
  const { factories, loaded: factoriesLoaded } = useFactoryList()
  const settings = useSettings()
  const settingsOpen = navigation.settings !== undefined
  const slots = useSlots()
  const [runsOpen, setRunsOpen] = useState(false)
  const closeRuns = useCallback(() => setRunsOpen(false), [])
  const [newTaskOpen, setNewTaskOpen] = useState<{ description?: string; factoryId?: string }>()
  const [removing, setRemoving] = useState<Factory>()
  const [automationDialog, setAutomationDialog] = useState<{
    factoryId?: string
    template?: TemplateChoice
    editing?: Automation
  }>()
  const [paletteOpen, setPaletteOpen] = useState(false)
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
    removing !== undefined ||
    automationDialog !== undefined
  const openNewTask = (factoryId?: string) =>
    setNewTaskOpen(factoryId === undefined ? {} : { factoryId })
  const inbox = useInbox()
  const questions = useAutomationRequests()
  const allAutomations = useAutomations(undefined)
  const inboxCount = inbox.length + questions.length
  const inboxScreen = navigation.screen.kind === 'inbox' ? navigation.screen : undefined
  const answered = useAnswered(inboxScreen?.answered === true)
  const waiting: Record<string, FactoryBadges> = {}
  for (const [factoryId, count] of Object.entries(waitingByFactory(inbox, questions))) {
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

  useEffect(() => {
    if (settings === undefined) return
    document.documentElement.style.setProperty(
      '--terminal-font-size',
      `${settings.terminalFontSize}px`,
    )
  }, [settings])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen) return
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        dispatch({ type: 'open-settings' })
      } else if (event.key === 'Escape' && settingsOpen && !event.defaultPrevented) {
        dispatch({ type: 'close-settings' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, dialogOpen])
  const banners = useBanners()
  const agentHealth = useAgentHealth()
  const { connection } = useConnection()
  const offline = connection.state !== 'connected'

  useEffect(() => {
    if (!offline) return
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || settingsOpen || !(event.metaKey || event.ctrlKey)) return
      if (event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return
      const factory = factories[Number(event.key) - 1]
      if (!factory) return
      event.preventDefault()
      dispatch({ type: 'open-factory', factoryId: factory.id })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen, factories])

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
      if (dialogOpen || settingsOpen || runsOpen || event.metaKey || event.ctrlKey) return
      if (event.altKey || event.shiftKey || event.key !== 's' || isTyping(event.target)) return
      const action = task && shortcutAction(task)
      if (!task || !action) return
      event.preventDefault()
      runStatusAction(action.kind, task).catch((error: unknown) => console.error(error))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen, runsOpen, task])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || settingsOpen || runsOpen || !task || task.archived) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== 'e' || isTyping(event.target) || event.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent(editTaskEvent, { detail: task.id }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen, runsOpen, task])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || settingsOpen || runsOpen || !task || task.archived) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'Backspace' || isTyping(event.target)) return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent(archiveTaskEvent, { detail: task.id }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen, runsOpen, task])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || settingsOpen || event.altKey || event.shiftKey) return
      const command = event.metaKey || event.ctrlKey
      const newTask = command
        ? event.key.toLowerCase() === 'n'
        : event.key === 'c' && !isTyping(event.target)
      if (!newTask) return
      event.preventDefault()
      setNewTaskOpen({})
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, settingsOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        if (newTaskOpen !== undefined || addFactoryOpen) return
        if (!paletteOpen && document.querySelector('dialog[open]')) return
        event.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (key === 'f') {
        if (dialogOpen || document.querySelector('dialog[open]')) return
        event.preventDefault()
        setFindAt(place)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen, paletteOpen, newTaskOpen, addFactoryOpen, place])

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
          selected={navigation.requestId}
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
        >
          {opened ??
            (navigation.automation?.runId !== undefined &&
              automationRun(navigation.automation.id, navigation.automation.runId))}
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
      context={{
        task: settingsOpen ? undefined : task,
        factories,
        dispatch,
        newTask: (description) => setNewTaskOpen(description === undefined ? {} : { description }),
        newAutomation: () => newAutomation(currentFactoryId(navigation, tasks)),
        addFactory: () => setAddFactoryOpen(true),
      }}
      factoryId={currentFactoryId(navigation, tasks)}
      onOpenTask={(taskId, factoryId) => {
        if (settingsOpen) dispatch({ type: 'close-settings' })
        dispatch({ type: 'open-task', taskId, factoryId })
      }}
      onOpenFactory={(factoryId) => dispatch({ type: 'open-factory', factoryId })}
      onClose={() => setPaletteOpen(false)}
    />
  )

  const find = findAt === place && <FindBar scope={panes} onClose={() => setFindAt(undefined)} />

  const dialogs = (
    <>
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

  const frame = (content: ReactNode) => (
    <div className={styles.window}>
      {connection.state === 'reconnecting' && <ReconnectingBar />}
      <div className={styles.app}>{content}</div>
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
    </>,
  )
}
