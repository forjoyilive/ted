import type { DaemonConnection } from '@ted/daemon/launch'
import type { Banner, Task } from '@ted/protocol'
import { type ReactNode, useEffect, useReducer, useState } from 'react'
import styles from './App.module.css'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  settingsStopsWork,
} from './banners.ts'
import { type BannerMenuItem, BannerStack } from './components/BannerStack.tsx'
import { ReconnectingBar } from './components/ReconnectingBar.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { useBanners, useConnection, useFactories, useSettings, useTasks } from './data.ts'
import {
  backLink,
  currentFactoryId,
  initialNavigation,
  navigate,
  type SettingsSectionId,
  settingsSectionIds,
} from './navigation.ts'
import { SettingsShell } from './settings/SettingsShell.tsx'
import { ted } from './ted.ts'
import { NewTaskDialog } from './views/NewTaskDialog.tsx'
import { Inbox, Stub } from './views/OtherViews.tsx'
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
    if (banner.severity !== 'stops-work' || place?.kind !== 'settings') continue
    const section = settingsSectionIds.find((id) => id === place.section)
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

const keepsStoppingProblem = 'daemon-keeps-stopping'

function keepsStoppingBanner(connection: DaemonConnection): Banner[] {
  if (connection.state !== 'stopped') return []
  return [
    {
      id: `${keepsStoppingProblem}:app`,
      problem: keepsStoppingProblem,
      severity: 'stops-work',
      text: 'TED’s background process keeps stopping',
      action: { label: 'Restart' },
      raisedAt: connection.crashes.at(-1) ?? new Date().toISOString(),
    },
  ]
}

const keepsStoppingMenu = (banner: Banner): BannerMenuItem[] | undefined =>
  banner.problem === keepsStoppingProblem
    ? [
        {
          label: 'Restart TED in the background',
          onSelect: () => ted.restartDaemon().catch((error: unknown) => console.error(error)),
        },
        {
          label: 'Copy report',
          onSelect: () => ted.copyCrashReport().catch((error: unknown) => console.error(error)),
        },
      ]
    : undefined

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
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const openNewTask = () => setNewTaskOpen(true)
  const inboxCount = 0

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
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)

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
    if (task) {
      return (
        <>
          <TaskThread
            task={task}
            backLink={backLink(navigation)}
            onBack={() => dispatch({ type: 'close-task' })}
            onOpenTask={openTaskByRef}
          />
          <TaskDetails task={task} tasks={tasks} factories={factories} />
        </>
      )
    }
    const { screen } = navigation
    switch (screen.kind) {
      case 'inbox':
        return <Inbox />
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
          badges={Object.fromEntries(
            [...factoriesStoppingWork(banners)].map((id) => [id, { stopsWork: true }]),
          )}
          settingsProblem={settingsStopsWork(banners)}
          dispatch={dispatch}
          onNewTask={openNewTask}
        />
      </Offline>
      <main className={styles.main}>
        {problems}
        <Offline when={offline}>
          <div className={styles.panes}>{main()}</div>
        </Offline>
      </main>
      {newTaskOpen && (
        <Offline when={offline}>
          <NewTaskDialog
            factories={factories}
            tasks={tasks}
            factoryId={currentFactoryId(navigation, tasks)}
            onClose={() => setNewTaskOpen(false)}
          />
        </Offline>
      )}
    </>,
  )
}
