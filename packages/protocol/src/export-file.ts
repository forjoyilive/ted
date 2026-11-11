import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import path from 'node:path'

export async function writeExportFile(destination: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.ted-export-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(text, 'utf8')
    } finally {
      await file.close()
    }
    try {
      await link(temporary, destination)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('That destination already exists. Choose a new filename.')
      }
      throw error
    }
  } finally {
    await unlink(temporary)
  }
}
