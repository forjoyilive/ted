import type { Banner, Task } from '@ted/protocol'
import { useReducer } from 'react'
import styles from './App.module.css'
import {
  appWideBanners,
  factoriesStoppingWork,
  factoryBanners,
  settingsStopsWork,
} from './banners.ts'
import { BannerStack } from './components/BannerStack.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { useBanners, useFactories, useTasks } from './data.ts'
import { backLink, currentFactoryId, initialNavigation, navigate } from './navigation.ts'
import { ted } from './ted.ts'
import { AppSettings, Inbox, Stub } from './views/OtherViews.tsx'
import { TaskDetails, TaskThread } from './views/TaskThread.tsx'
import { Board, factoryName, TaskList } from './views/TaskViews.tsx'

const factoryViewTitles = {
  plans: 'Plans',
  automations: 'Automations',
  settings: 'Factory settings',
} as const

const stubTitles = { search: 'Search', 'new-task': 'New Task', 'add-factory': 'Add Factory' }

export function App() {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation)
  const tasks = useTasks()
  const factories = useFactories()
  const banners = useBanners()
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)

  async function act(banner: Banner) {
    const place = banner.action?.opens
    if (!place) {
      await ted.actOnBanner(banner.id).catch((error: unknown) => console.error(error))
    } else if (place.kind === 'settings') {
      dispatch({ type: 'open', screen: { kind: 'settings' } })
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
      case 'settings':
        return <AppSettings />
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

  return (
    <div className={styles.app}>
      <Sidebar
        navigation={navigation}
        factories={factories}
        currentFactoryId={currentFactoryId(navigation, tasks)}
        inboxCount={0}
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
