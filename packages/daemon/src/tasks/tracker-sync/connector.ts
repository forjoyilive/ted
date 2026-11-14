import type {
  Comment,
  CommentAnswer,
  MachineSettings,
  RequestPurpose,
  Task,
  TrackerGroup,
} from '@ted/protocol'
import type { TrackerSeen } from '../../store/index.ts'

export class TrackerWait extends Error {
  readonly waitMs: number
  constructor(waitMs: number) {
    super('the tracker asked TED to wait')
    this.waitMs = waitMs
  }
}

export interface TrackerItem<Handle> {
  closed: boolean
  state: string
  group?: TrackerGroup
  handle: Handle
}

export type TrackerRead<Handle> =
  | { items: ReadonlyMap<string, TrackerItem<Handle>> }
  | { waitMs: number }
  | undefined

export interface TrackerAdvance {
  step: string
  moved?: string
}

export interface TrackerTexts {
  closedTitle(label: string, state: string): string
  closedBody(label: string, state: string, pastSignOff: boolean): string
  groupTitle(group: TrackerGroup, factoryName: string): string
  groupBody(ask: {
    automation: string
    task: string
    label: string
    group: TrackerGroup
    factoryName: string
  }): string
}

export interface TrackerConnector<Source, Handle> {
  id: string
  name: string
  groupNoun: string
  enabled(settings: MachineSettings): boolean
  source(url: string): Source | undefined
  key(source: Source): string
  label(source: Source): string
  read(sources: readonly Source[]): Promise<TrackerRead<Handle>>
  steps: readonly string[]
  advance(input: {
    task: Task
    merged: boolean
    step: string | undefined
    item: TrackerItem<Handle>
  }): Promise<TrackerAdvance | undefined>
  link(
    item: TrackerItem<Handle>,
    pullRequest: { url: string; title: string },
    task: Task,
  ): Promise<void>
  ready?(): boolean
  texts: TrackerTexts
}

export interface TrackerRecord {
  seen?: TrackerSeen
  step?: string
  linked: ReadonlySet<string>
}

export interface TrackerRecords<Handle> {
  record(taskId: string): TrackerRecord
  see(taskId: string, label: string, item: TrackerItem<Handle>): void
  moved(taskId: string, label: string, step: string, state: string | undefined): void
  linked(taskId: string, label: string, urls: readonly string[]): void
  syncState(task: Task): 'on' | 'ask' | undefined
  allowTask(task: Task, label: string): void
  groups(
    settings: MachineSettings,
    factoryId: string,
  ): { allowed: readonly string[]; declined: readonly string[] }
  allowGroup(
    factoryId: string,
    group: string,
    consents: readonly { taskId: string; label: string }[],
  ): MachineSettings
  declineGroup(factoryId: string, group: string): void
  closedPurpose: RequestPurpose
  isClosedQuestion(comment: Comment): boolean
  groupAsk(group: TrackerGroup): Pick<Comment, 'linearTeam' | 'purpose'>
  isGroupAsk(comment: Comment): boolean
  askedGroup(comment: Comment): string | undefined
  withdrawn(why: 'reopened' | 'done', at: string): CommentAnswer
}
