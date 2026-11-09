import type { Factory } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { useConnection } from './data.ts'
import { ted } from './ted.ts'
import styles from './worktree.module.css'

export function FactoryBanners() {
  const [factories, setFactories] = useState<Factory[]>([])
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    const refresh = () => void ted.listFactories().then(setFactories, () => undefined)
    refresh()
    return ted.onEvent((event) => {
      if (event.type === 'task-updated' || event.type === 'factory-added') refresh()
    })
  }, [epoch])

  const locate = async (key: string) => {
    const updated = await ted.locateLocalFolder(key)
    if (updated) setFactories((current) => current.map((f) => (f.id === updated.id ? updated : f)))
  }

  const missing = factories.filter((f) => f.localFolder && !f.localFolder.found)
  return missing.map((factory) => (
    <div key={factory.id} role="alert" className={styles.banner}>
      <span>Local folder for {factory.name} not found</span>
      <button
        type="button"
        className={styles.bannerAction}
        onClick={() => void locate(factory.key)}
      >
        Locate
      </button>
    </div>
  ))
}
