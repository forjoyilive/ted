import { createRoot } from 'react-dom/client'
import { TaskList } from './TaskList.tsx'

createRoot(document.getElementById('root') as HTMLElement).render(<TaskList />)
