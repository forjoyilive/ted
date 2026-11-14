import type { AsanaProjectList, Factory, MachineSettings } from '@ted/protocol'
import { useId, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { Select } from '../components/Select.tsx'
import { ted } from '../ted.ts'
import styles from './asana.module.css'
import { TrackerGroupsRow } from './TrackerGroupsRow.tsx'
import groupStyles from './tracker-groups.module.css'

export function AsanaProjectsRow({
  factory,
  settings,
  projects,
  account,
}: {
  factory: Factory
  settings: MachineSettings
  projects: AsanaProjectList | undefined
  account: string
}) {
  const [problem, setProblem] = useState<string>()
  const fieldId = useId()
  const allowed = settings.trackerSyncGroups.asana?.[factory.id] ?? []
  const declined = settings.trackerSyncDeclined.asana?.[factory.id] ?? []
  const accounts = settings.trackerSyncGroupAccounts.asana?.[factory.id] ?? {}
  const name = (gid: string) => projects?.projects.find((p) => p.gid === gid)?.name ?? gid
  const choices = (projects?.projects ?? []).filter((p) => !allowed.includes(p.gid))

  function run(work: () => Promise<unknown>) {
    setProblem(undefined)
    return work().catch((error: unknown) =>
      setProblem(
        error instanceof Error ? error.message : 'Couldn’t change the project. Try again.',
      ),
    )
  }
  const allow = (gid: string) => run(() => ted.allowAsanaProject(factory.id, gid))

  return (
    <TrackerGroupsRow
      title={`Asana projects for Automations in ${factory.name}`}
      labelFor={fieldId}
      help="TED writes to Asana for a Task an Automation made only while its Asana task is in one of these projects. The first time an Automation makes a Task from another project, TED asks you in the Inbox. Removing a project stops new Tasks from syncing through it; Tasks already syncing keep going. For a single Task, open its menu and choose Sync with Asana."
      allowed={allowed}
      declined={declined}
      label={name}
      allowLabel={(gid) => `Allow ${name(gid)} for Automations in ${factory.name}`}
      onAllow={allow}
      forgetLabel={(gid) => `Remove ${name(gid)} from Not now in ${factory.name}`}
      onForget={(gid) => run(() => ted.forgetAsanaProject(factory.id, gid, 'declined'))}
      {...(problem !== undefined && { problem })}
    >
      <span className={styles.projects}>
        {allowed.map((gid) => (
          <span key={gid} className={groupStyles.notNowGroup} data-asana-project={gid}>
            {name(gid)}
            {accounts[gid] !== account && (
              <>
                <span className={styles.waiting}>Allowed by another Asana account</span>
                <ActionButton
                  type="button"
                  className={groupStyles.allow}
                  aria-label={`Allow ${name(gid)} again for Automations in ${factory.name}`}
                  onClick={() => allow(gid)}
                >
                  Allow again
                </ActionButton>
              </>
            )}
            <ActionButton
              type="button"
              className={groupStyles.allow}
              aria-label={`Remove ${name(gid)} from ${factory.name}`}
              onClick={() => run(() => ted.forgetAsanaProject(factory.id, gid, 'allowed'))}
            >
              Remove
            </ActionButton>
          </span>
        ))}
        <Select
          id={fieldId}
          value=""
          disabled={!projects}
          onChange={(event) => {
            if (event.target.value !== '') void allow(event.target.value)
          }}
        >
          <option value="">{projects ? 'Add a project…' : 'Loading projects…'}</option>
          {choices.map((project) => (
            <option key={project.gid} value={project.gid}>
              {project.name} · {project.workspace}
            </option>
          ))}
        </Select>
      </span>
    </TrackerGroupsRow>
  )
}
