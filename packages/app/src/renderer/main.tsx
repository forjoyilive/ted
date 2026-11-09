import { createRoot } from 'react-dom/client'
import { FactoryBanners } from './FactoryBanners.tsx'
import { TaskList } from './TaskList.tsx'

createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    <FactoryBanners />
    <TaskList />
  </>,
)
