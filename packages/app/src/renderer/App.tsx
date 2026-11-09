import type { Task } from '@ted/protocol'
import { useReducer } from 'react'
import styles from './App.module.css'
import { Sidebar } from './components/Sidebar.tsx'
import { useFactories, useTasks } from './data.ts'
import { FactoryBanners } from './FactoryBanners.tsx'
import { backLink, currentFactoryId, initialNavigation, navigate } from './navigation.ts'
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
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)

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
        if (screen.view === 'board') {
          return <Board title={name} tasks={inFactory} factories={factories} onOpen={openTask} />
        }
        if (screen.view === 'list') {
          return <TaskList title={name} tasks={inFactory} factories={factories} onOpen={openTask} />
        }
        return <Stub title={`${name} · ${factoryViewTitles[screen.view]}`} />
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
        dispatch={dispatch}
      />
      <div className={styles.column}>
        <FactoryBanners />
        <main className={styles.main}>{main()}</main>
      </div>
    </div>
  )
}
