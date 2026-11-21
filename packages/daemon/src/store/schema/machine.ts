import { Events, Schema, State } from '@livestore/livestore'

export const machineSettings = State.SQLite.table({
  name: 'machineSettings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    appearance: State.SQLite.text(),
  },
})

export const machineSettingValues = State.SQLite.table({
  name: 'machineSettingValues',
  columns: {
    name: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
  },
})

export const banners = State.SQLite.table({
  name: 'banners',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    problem: State.SQLite.text(),
    severity: State.SQLite.text(),
    factoryId: State.SQLite.text({ nullable: true }),
    text: State.SQLite.text(),
    action: State.SQLite.text({ nullable: true }),
    raisedAt: State.SQLite.text(),
    dismissed: State.SQLite.integer({ nullable: true }),
    dismissedUntil: State.SQLite.text({ nullable: true }),
  },
})

export const machineEvents = {
  intervalObservationStarted: Events.synced({
    name: 'v1.IntervalObservationStarted',
    schema: Schema.Struct({
      sessionId: Schema.String,
      previousObservedAt: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  intervalObservationEnded: Events.synced({
    name: 'v1.IntervalObservationEnded',
    schema: Schema.Struct({ sessionId: Schema.String, at: Schema.String }),
  }),
  taskWaitObserved: Events.synced({
    name: 'v1.TaskWaitObserved',
    schema: Schema.Struct({ taskId: Schema.String, reasons: Schema.String, at: Schema.String }),
  }),
  runStateObserved: Events.synced({
    name: 'v1.RunStateObserved',
    schema: Schema.Struct({ runId: Schema.String, state: Schema.String, at: Schema.String }),
  }),
  appearanceChanged: Events.synced({
    name: 'v1.AppearanceChanged',
    schema: Schema.Struct({ appearance: Schema.String, at: Schema.String }),
  }),
  machineSettingsChanged: Events.synced({
    name: 'v1.MachineSettingsChanged',
    schema: Schema.Struct({ changes: Schema.String, at: Schema.String }),
  }),
  bannerRaised: Events.synced({
    name: 'v1.BannerRaised',
    schema: Schema.Struct({
      id: Schema.String,
      problem: Schema.String,
      severity: Schema.String,
      factoryId: Schema.NullOr(Schema.String),
      text: Schema.String,
      action: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  bannerDismissed: Events.synced({
    name: 'v1.BannerDismissed',
    schema: Schema.Struct({ id: Schema.String, until: Schema.String, at: Schema.String }),
  }),
  problemDismissed: Events.synced({
    name: 'v1.ProblemDismissed',
    schema: Schema.Struct({ id: Schema.String, raisedAt: Schema.String }),
  }),
  bannerCleared: Events.synced({
    name: 'v1.BannerCleared',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
}

export const machineMaterializers = State.SQLite.materializers(machineEvents, {
  'v1.IntervalObservationStarted': () => [],
  'v1.IntervalObservationEnded': () => [],
  'v1.TaskWaitObserved': () => [],
  'v1.RunStateObserved': () => [],
  'v1.AppearanceChanged': ({ appearance }) =>
    machineSettings.insert({ id: 'machine', appearance }).onConflict('id', 'replace'),
  'v1.MachineSettingsChanged': ({ changes }) =>
    Object.entries(JSON.parse(changes) as Record<string, unknown>).map(([name, value]) =>
      machineSettingValues
        .insert({ name, value: JSON.stringify(value) })
        .onConflict('name', 'replace'),
    ),
  'v1.BannerRaised': ({ at, ...banner }) => [
    banners
      .insert({ ...banner, raisedAt: at, dismissed: null, dismissedUntil: null })
      .onConflict('id', 'ignore'),
    banners
      .update({ severity: banner.severity, text: banner.text, action: banner.action })
      .where({ id: banner.id }),
  ],
  'v1.BannerDismissed': ({ id, until }) => banners.update({ dismissedUntil: until }).where({ id }),
  'v1.ProblemDismissed': ({ id, raisedAt }) =>
    banners.update({ dismissed: 1 }).where({ id, raisedAt }),
  'v1.BannerCleared': ({ id }) => banners.delete().where({ id }),
})
