import type { Banner, Task } from '@ted/protocol'
import { useEffect, useReducer } from 'react'
import styles from './App.module.css'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  settingsStopsWork,
} from './banners.ts'
import { BannerStack } from './components/BannerStack.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { useBanners, useFactories, useSettings, useTasks } from './data.ts'
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

const stubTitles = { search: 'Search', 'new-task': 'New Task', 'add-factory': 'Add Factory' }

export function App() {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation)
  const tasks = useTasks()
  const factories = useFactories()
  const settings = useSettings()
  const settingsOpen = navigation.settings !== undefined
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
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        dispatch({ type: 'open-settings' })
      } else if (event.key === 'Escape' && settingsOpen && !event.defaultPrevented) {
        dispatch({ type: 'close-settings' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])
  const banners = useBanners()
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)

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
          />
          <TaskDetails task={task} factories={factories} />
        </>
      )
    }
    const { screen } = navigation
    switch (screen.kind) {
      case 'inbox':
        return <Inbox />
      case 'all-tasks':
        return <TaskList title="All Tasks" tasks={tasks} factories={factories} onOpen={openTask} />
      case 'factory': {
        const name = factoryName(factories, screen.factoryId)
        const inFactory = tasks.filter((t) => t.factoryId === screen.factoryId)
        const view = {
          title: name,
          tasks: inFactory,
          factories,
          onOpen: openTask,
          banners: bannerStack(`${name} problems`, factoryBanners(banners, screen.factoryId)),
        }
        if (screen.view === 'board') return <Board {...view} />
        if (screen.view === 'list') return <TaskList {...view} />
        return <Stub title={`${name} · ${factoryViewTitles[screen.view]}`} banners={view.banners} />
      }
      default:
        return <Stub title={stubTitles[screen.kind]} />
    }
  }

  if (navigation.settings) {
    return (
      <div className={styles.app}>
        <div className={styles.main}>
          {bannerStack('Problems', appWideBanners(banners))}
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
        </div>
      </div>
    )
  }

  return (
    <div className={styles.app}>
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
      />
      <main className={styles.main}>
        {bannerStack('Problems', appWideBanners(banners))}
        <div className={styles.panes}>{main()}</div>
      </main>
    </div>
  )
}
