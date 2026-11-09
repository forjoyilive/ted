import type { Banner, Task } from '@ted/protocol'
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
import { BannerStack } from './components/BannerStack.tsx'
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { WorkingRunsPopover } from './components/WorkingRuns.tsx'
import {
  useBanners,
  useConnection,
  useFactories,
  useInbox,
  useSettings,
  useSlots,
  useTasks,
} from './data.ts'
import { FactoryBanners } from './FactoryBanners.tsx'
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
import { ted } from './ted.ts'
import { Inbox } from './views/Inbox.tsx'
import { NewTaskDialog } from './views/NewTaskDialog.tsx'
import { Stub } from './views/OtherViews.tsx'
import { TaskDetails, TaskThread } from './views/TaskThread.tsx'
import { Board, factoryName, TaskList } from './views/TaskViews.tsx'

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

const stubTitles = { search: 'Search', 'add-factory': 'Add Factory' }

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

export function App() {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation)
  const tasks = useTasks()
  const factories = useFactories()
  const settings = useSettings()
  const settingsOpen = navigation.settings !== undefined
  const slots = useSlots()
  const [runsOpen, setRunsOpen] = useState(false)
  const closeRuns = useCallback(() => setRunsOpen(false), [])
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const openNewTask = () => setNewTaskOpen(true)
  const inbox = useInbox()
  const inboxCount = inbox.length
  const waiting: Record<string, { waiting: number }> = {}
  for (const { task } of inbox) {
    waiting[task.factoryId] = { waiting: (waiting[task.factoryId]?.waiting ?? 0) + 1 }
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
      if (newTaskOpen) return
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        dispatch({ type: 'open-settings' })
      } else if (event.key === 'Escape' && settingsOpen && !event.defaultPrevented) {
        dispatch({ type: 'close-settings' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, newTaskOpen])
  const banners = useBanners()
  const { connection } = useConnection()
  const offline = connection.state !== 'connected'

  useEffect(() => {
    if (offline) setNewTaskOpen(false)
  }, [offline])

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
      if (newTaskOpen || settingsOpen || runsOpen || event.metaKey || event.ctrlKey) return
      if (event.altKey || event.shiftKey || event.key !== 's' || isTyping(event.target)) return
      if (task?.stage !== 'backlog') return
      event.preventDefault()
      ted.startTask(task.id).catch((error: unknown) => console.error(error))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newTaskOpen, settingsOpen, runsOpen, task])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (newTaskOpen || settingsOpen || event.altKey || event.shiftKey) return
      const command = event.metaKey || event.ctrlKey
      const newTask = command
        ? event.key.toLowerCase() === 'n'
        : event.key === 'c' && !isTyping(event.target)
      if (!newTask) return
      event.preventDefault()
      setNewTaskOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newTaskOpen, settingsOpen])
  const openTaskByRef = (ref: string) => {
    const found = tasks.find((t) => t.displayId === ref || t.id === ref)
    if (found) openTask(found)
  }

  async function act(banner: Banner) {
    const place = banner.action?.opens
    if (!place) {
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
    if (command.kind === 'new-task') setNewTaskOpen(true)
    if (command.kind === 'settings') dispatch({ type: 'open-settings' })
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
      <>
        <TaskThread
          task={task}
          backLink={backLink(navigation)}
          requestId={navigation.requestId}
          onBack={() => dispatch({ type: 'close-task' })}
          onOpenTask={openTaskByRef}
        />
        <TaskDetails task={task} tasks={tasks} factories={factories} />
      </>
    )
    const { screen } = navigation
    if (screen.kind === 'inbox') {
      return (
        <Inbox
          items={inbox}
          factories={factories}
          selected={navigation.requestId}
          onOpen={({ request, task: on }) =>
            dispatch({
              type: 'open-task',
              taskId: on.id,
              factoryId: on.factoryId,
              requestId: request.id,
            })
          }
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
            title="All Tasks"
            tasks={tasks}
            factories={factories}
            onOpen={openTask}
            onNewTask={openNewTask}
          />
        )
      case 'factory': {
        const name = factoryName(factories, screen.factoryId)
        const inFactory = tasks.filter((t) => t.factoryId === screen.factoryId)
        const view = {
          title: name,
          capLine: factoryCapLine(slots, screen.factoryId),
          tasks: inFactory,
          factories,
          onOpen: openTask,
          onNewTask: openNewTask,
          banners: bannerStack(`${name} problems`, factoryBanners(banners, screen.factoryId)),
        }
        if (screen.view === 'board') return <Board {...view} onOpenTask={openTaskByRef} />
        if (screen.view === 'list') return <TaskList {...view} />
        return <Stub title={`${name} · ${factoryViewTitles[screen.view]}`} banners={view.banners} />
      }
      default:
        return <Stub title={stubTitles[screen.kind]} />
    }
  }

  const problems =
    connection.state === 'stopped' ? (
      bannerStack('Problems', keepsStoppingBanner(connection))
    ) : (
      <Offline when={offline}>{bannerStack('Problems', appWideBanners(banners))}</Offline>
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
          <div className={styles.panes}>
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
          footer={slots === undefined ? {} : { runs: runsLine(slots) }}
          runsOpen={runsOpen}
          onOpenRuns={() => setRunsOpen((open) => !open)}
          dispatch={dispatch}
          onNewTask={openNewTask}
        />
        {runsOpen && slots && (
          <WorkingRunsPopover
            slots={slots}
            factories={factories}
            onClose={closeRuns}
            onOpenList={() => {
              setRunsOpen(false)
              dispatch({ type: 'open', screen: { kind: 'all-tasks' } })
            }}
          />
        )}
      </Offline>
      <main className={styles.main}>
        <Offline when={offline}>
          <FactoryBanners />
        </Offline>
        {problems}
        <Offline when={offline}>
          <div className={styles.panes}>{main()}</div>
        </Offline>
      </main>
      {newTaskOpen && (
        <NewTaskDialog
          factories={factories}
          tasks={tasks}
          factoryId={currentFactoryId(navigation, tasks)}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
    </>,
  )
}
