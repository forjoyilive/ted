export type CommandLineStatus =
  | { state: 'unavailable' }
  | { state: 'package' }
  | { state: 'not-installed'; path: string }
  | { state: 'installed'; path: string; addToPath?: string }
  | { state: 'taken'; path: string }
