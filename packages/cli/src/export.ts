import path from 'node:path'
import { withDaemon } from '@ted/daemon/launch'
import { exportFormat, formatExport } from '@ted/protocol'
import { writeExportFile } from '@ted/protocol/export-file'

export async function exportCommand(
  home: string,
  options: { factory?: string; format?: string; output?: string },
): Promise<string> {
  const format = exportFormat(options.format ?? 'json')
  const key = options.factory?.trim()
  if (!key || !options.output?.trim()) {
    throw new Error('Use ted export --factory <key> [--format json|markdown] --output <path>')
  }
  const destination = path.resolve(options.output)
  const snapshot = await withDaemon(home, async (client) => {
    const factory = (await client.listFactories()).find((factory) => factory.key === key)
    if (!factory) throw new Error(`No Factory with key ${key}`)
    return client.exportFactory(factory.id)
  })
  await writeExportFile(destination, formatExport(snapshot, format))
  const count = snapshot.tasks.length
  return `Exported ${count} ${count === 1 ? 'Task' : 'Tasks'} to ${destination}`
}
