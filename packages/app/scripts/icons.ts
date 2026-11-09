import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appIconPng } from '../src/app-icon.ts'
import { logoSvg } from '../src/logo.ts'
import { appDir } from './stage.ts'

const linuxIconSizes = [16, 32, 48, 64, 128, 256, 512, 1024]
const macIconSizes = [16, 32, 128, 256, 512]

const buildDir = path.join(appDir, 'build')

await writeFile(path.join(buildDir, 'logo.svg'), logoSvg())

await mkdir(path.join(buildDir, 'icons'), { recursive: true })
for (const size of linuxIconSizes) {
  await writeFile(
    path.join(buildDir, 'icons', `${size}x${size}.png`),
    appIconPng({ size, layout: 'linux' }),
  )
}

const scratch = await mkdtemp(path.join(tmpdir(), 'ted-icons-'))
try {
  const iconset = path.join(scratch, 'icon.iconset')
  await mkdir(iconset)
  for (const size of macIconSizes) {
    await writeFile(path.join(iconset, `icon_${size}x${size}.png`), appIconPng({ size }))
    await writeFile(
      path.join(iconset, `icon_${size}x${size}@2x.png`),
      appIconPng({ size: size * 2 }),
    )
  }
  execFileSync('iconutil', [
    '--convert',
    'icns',
    iconset,
    '--output',
    path.join(buildDir, 'icon.icns'),
  ])
} finally {
  await rm(scratch, { recursive: true, force: true })
}
