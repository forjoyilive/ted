# An Automation Run can have a checkout and Apps

An Automation Run worked in `TED_HOME/automations/<id>/` and read code only through GitHub. Apps started only for a Task, so nothing could use a Factory’s App outside a Task. Audits (KRI-241, split into TED-268 and TED-309 to TED-315) need an unattended Run that starts the App from the default branch and uses it.

**An Automation has a `checkout` setting**, off by default, stored with `v1.AutomationCheckoutSet` in the same commit as its create or edit. The editor shows it as “Run in a copy of the code”. A template may turn it on (`AutomationTemplate.checkout`).

**With it on, each Run gets a fresh checkout**, made by `createCheckouts` in `packages/daemon/src/automations/checkout.ts` before the Run starts: a detached scratch worktree of `origin/<default branch>` for every repo `factoryRepos` lists, whatever `base_branch` the Workflow sets for Tasks, under `TED_HOME/automation-runs/<run-id>/<repo>/`, then `worktree.copy` from the local folder and the repo’s `setup` command, always in the OS sandbox (ADR 0091, ADR 0096). Automation Runs stay in Auto, so a Factory’s Bypass doesn’t reach them. The sandbox’s temp folder is `TED_HOME/sandbox/<run-id>/`; its caches are `TED_HOME/sandbox/automation-<automation-id>/cache/`, kept between Runs and deleted with the Automation, which Factory removal also deletes. The Run’s folder is the worktree, or the checkout folder in a multi-repo Factory. A failed setup fails the Run with the command’s output tail.

**The Apps module gets a second kind of owner.** `Tasks.setRunAppOwner` lets the Automations module answer `AppTask` for a Run ID it owns; App folders, ports and simulators are keyed by that ID. App events write no Task thread lines for an owner that isn’t a Task. Only that Run starts its Apps (`POST /runs/:id/apps/start`, starter `automation`); the app may list, show, stop and read the log; a Run token reaches only its own Run’s Apps. `ted run-app`, `ted app list` and `ted app log` pick the Run’s routes inside an Automation Run.

**An Automation Run never takes a simulator.** With every slot booted, its start joins a first-come line in `simulators.ts` and waits, with no request to the human and no time limit, until a slot frees. Stopping the App leaves the line. The Run page says it is waiting for a simulator.

**The checkout ends with the Run.** When a firing ends (finished, failed or stopped), TED stops the Run’s Apps, deletes their simulators and removes the worktrees and temp folder. A Run TED resumes after a crash keeps them; Retry gets a fresh checkout. Deleting an Automation (or its Factory) releases the checkouts of its started firings itself, because the firings are gone before their Runs report the end. At start, the daemon restores the checkouts of firings still started and removes every other folder in `automation-runs/`; until that restore is done, the Apps module and the `/runs/:id/apps` routes wait for it for any ID that is an Automation firing, so an App waiting for a simulator keeps waiting. The folders count as Worktrees in Settings → Storage and are left out of Time Machine.

## Considered Options

- **Give the Automation Run a Task.** Rejected. A Task carries a Workflow, Stages, a branch and pull requests; an Audit wants none of them, and a hidden Task would show up in every list that reads Tasks.
- **Ask the human for a simulator, as a Task Lead does.** Rejected by the user in TED-268: Automations run unattended, so the Run waits instead.
- **Keep one checkout per Automation and reset it each Run.** Rejected by the user: installs would be faster, but leftovers from one Run could change the next. The download caches give most of the speed back.

## Consequences

An Automation Run may edit files in its checkout; it never commits or pushes, and its changes go with the checkout. The checkout record lives in memory and is rebuilt from the folder and the Factory’s settings at start. The Run page shows no commit for the checkout; the agent’s prompt names it.
