import { sampleHome } from '@ted/protocol'
import { seedDemoFromCli } from './demo.ts'

// The app runs this in a process of its own to prepare the sample data before opening it.
await seedDemoFromCli(sampleHome(), process.argv.includes('--reset'))
process.exit(0)
