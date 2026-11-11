import { type DaemonClient, exportFormat, formatExport, type SaveExportResult } from '@ted/protocol'
import { writeExportFile } from '@ted/protocol/export-file'

export async function saveFactoryExport(
  client: DaemonClient,
  factoryId: unknown,
  givenFormat: unknown,
  choose: (filename: string, extension: string) => Promise<string | undefined>,
): Promise<SaveExportResult> {
  const format = exportFormat(givenFormat)
  if (typeof factoryId !== 'string') throw new Error('Choose a Factory to export')
  const factory = (await client.listFactories()).find((factory) => factory.id === factoryId)
  if (!factory) throw new Error('That Factory no longer exists')
  const extension = format === 'json' ? 'json' : 'md'
  const key = factory.key.replace(/[^a-zA-Z0-9_-]/g, '_') || 'Factory'
  const destination = await choose(
    `${key}-${new Date().toISOString().slice(0, 10)}.${extension}`,
    extension,
  )
  if (destination === undefined) return { canceled: true }
  const snapshot = await client.exportFactory(factoryId)
  await writeExportFile(destination, formatExport(snapshot, format))
  return { canceled: false, path: destination, tasks: snapshot.tasks.length }
}
