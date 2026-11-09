import type { Task } from '@ted/protocol'
import { useEffect, useReducer, useState } from 'react'
import styles from './App.module.css'
import { Sidebar } from './components/Sidebar.tsx'
import { useFactories, useTasks } from './data.ts'
import { backLink, currentFactoryId, initialNavigation, navigate } from './navigation.ts'
import { NewTaskDialog } from './views/NewTaskDialog.tsx'
import { AppSettings, Inbox, Stub } from './views/OtherViews.tsx'
import { TaskDetails, TaskThread } from './views/TaskThread.tsx'
import { Board, factoryName, TaskList } from './views/TaskViews.tsx'

const factoryViewTitles = {
  plans: 'Plans',
  automations: 'Automations',
  settings: 'Factory settings',
} as const

const stubTitles = { search: 'Search', 'add-factory': 'Add Factory' }

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export function App() {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation)
  const tasks = useTasks()
  const factories = useFactories()
  const openTask = (task: Task) =>
    dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
  const task = tasks.find((t) => t.id === navigation.taskId)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const openNewTask = () => setNewTaskOpen(true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (newTaskOpen || event.altKey || event.shiftKey) return
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
  }, [newTaskOpen])

  function main() {
    if (task) {
      return (
        <>
          <TaskThread
            task={task}
            backLink={backLink(navigation)}
            onBack={() => dispatch({ type: 'close-task' })}
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
      case 'settings':
        return <AppSettings />
      case 'factory': {
        const name = factoryName(factories, screen.factoryId)
        const inFactory = tasks.filter((t) => t.factoryId === screen.factoryId)
        if (screen.view === 'board') {
          return (
            <Board
              title={name}
              tasks={inFactory}
              factories={factories}
              onOpen={openTask}
              onNewTask={openNewTask}
            />
          )
        }
        if (screen.view === 'list') {
          return (
            <TaskList
              title={name}
              tasks={inFactory}
              factories={factories}
              onOpen={openTask}
              onNewTask={openNewTask}
            />
          )
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
        onNewTask={openNewTask}
      />
      <main className={styles.main}>{main()}</main>
      {newTaskOpen && (
        <NewTaskDialog
          factories={factories}
          tasks={tasks}
          factoryId={currentFactoryId(navigation, tasks)}
          onClose={() => setNewTaskOpen(false)}
        />
      )}
    </div>
  )
}
