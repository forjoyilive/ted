# What Ted can learn from Warp Factories (KRI-163)

Researched 10 November 2026 for [KRI-163](https://linear.app/kriyadesign/issue/KRI-163/what-can-we-learn-from-warp-software-factories). This is research and proposed follow-up work; it changes no product behavior.

The strongest lesson is to make Factory improvements measurable: collect outcomes, inspect repeated failures, compare a candidate on fixed Tasks, then review the change and watch its results. Ted already has much of the execution and human-control machinery. Start by making its existing evidence useful across Tasks, then add a small replay experiment. This recommendation is our assessment, not a claim that Warp’s results will transfer to Ted.

## What the page is proposing

[Warp’s landing page](https://www.warp.dev/factories) presents factories as versioned infrastructure spanning work intake, agent execution, review and verification. Its distinctive emphasis is evaluation: scorers, historical-task benchmarks, configuration routing and proposed improvements. It also emphasizes portable execution, integrations and visual proof of work. Factories is offered through early access; the page is evidence of positioning, not an independent test of reliability or adoption.

The [overview documentation](https://docs.warp.dev/factories) makes a useful distinction: spec approval belongs to editable foreman instructions, while repository permissions govern approval and merge access. Warp says it never merges for the user. Ted instead owns Gate enforcement and the eventual merge through daemon logic. Preserve that distinction when comparing similarly named features; an agent instruction and an enforced authorization boundary provide different guarantees.

## Where Ted already overlaps

These are findings from the current repo, not a claim of full feature parity.

| Area | Evidence in Ted | Lesson |
|---|---|---|
| Versioned Factory behavior | [Workflow resolution](../../packages/daemon/src/workflow/workflows.ts) validates layers and retains a last valid version; [resolution rules](../../packages/daemon/src/workflow/resolve.ts) combine defaults, Library and Factory settings. [Stage entry records](../../packages/daemon/src/store/schema.ts) retain layer references and time. | Use these versions to explain changes in results. A benchmark would still need a complete reproducible snapshot. |
| Reviewable settings changes | [Factory settings](../../packages/daemon/src/factory-settings.ts) and [ADR 0061](../adr/0061-factory-settings-save-through-a-pull-request.md) already put Factory changes through a pull request. | Improvement proposals can use the existing review path. |
| Tokens and cost | [Agent interface](../../packages/daemon/src/agents/agent.ts) owns token and cost interpretation; [Run summaries](../../packages/daemon/src/runs/conversations.ts) expose available tokens regardless of billing, plus cost when billing is by API key. [Codex](../../packages/daemon/src/agents/codex.ts) estimates cost from token counts and model prices; [Claude](../../packages/daemon/src/agents/claude.ts) reads reported cost. | Add Task-level attribution and coverage before building another cost collector. Subscription usage must not appear as zero-cost work. |
| Objective execution evidence | [Check runner](../../packages/daemon/src/tasks/checks.ts) records state, exit code and duration; [store schema](../../packages/daemon/src/store/schema.ts) records Checks, Stage entries and send-backs. | Combine these facts before asking another model to judge them. |
| Factory coordination | [Coordinator](../../packages/daemon/src/coordinators/coordinators.ts) and [ADR 0094](../adr/0094-coordinators-have-bounded-factory-authority.md) already support comparison, explicit-human starts and reordering. | Broader foreman authority would be a separate product and security decision, rather than a missing chat feature. |
| Work intake and status return | [Automations](../../packages/daemon/src/automations/automations.ts) schedule Runs; [source matching](../../packages/daemon/src/tasks/sources.ts) prevents duplicate tracking; [Linear sync](../../packages/daemon/src/tasks/linear-sync.ts) returns progress and pull request links. | Evaluate new event sources against a concrete latency need. |
| Proof of work | [Design reviews](../adr/0081-design-reviews-carry-their-parts-and-prototypes-run-from-their-own-scheme.md), [attachments](../adr/0073-attachments-in-comments.md) and [Apps](../adr/0084-apps-run-in-detached-hosts.md) already carry visual evidence and runnable previews. | Improve evidence relevance and discoverability before adding another capture system. |

I found no general scorer configuration, fixed-task benchmark runner or cross-Task improvement service in the inspected Workflow, Runs, Tasks and store code. That is a scoped inspection, not proof that no related utility exists anywhere in the repo.

## Lessons worth adopting

### 1. Measure delivery and intervention at Task level first

Warp’s [measurement documentation](https://docs.warp.dev/factories/measure-and-improve/) separates activity, delivery, cost and autonomy. Its autonomy metric means merged PRs without a human code push; it does not mean no human effort. Cost is a comparison measure with coverage limitations. The docs also warn that more Runs can reflect evaluation activity rather than more delivered work.

For Ted, propose a read-only report by Factory, date range and configuration: Task completion, first-pass Validate success, send-backs, elapsed time, time waiting on the human, tokens and known API cost. Include Task Leads, reviewers and sub-agents once each; keep measurement Runs separate. Show unknown coverage explicitly. A multi-repo Task should remain one Task outcome, even though it produces several PRs.

Use event timestamps to show elapsed time and recorded waits. Do not label that as active engineering time or human minutes saved. Compare similar work and report the number of observations. A merged Task is a delivery fact, not evidence that it stayed correct in production.

### 2. Add narrowly defined, inspectable evaluations

Warp’s [Scorers documentation](https://docs.warp.dev/factories/measure-and-improve/scorers/) describes an LLM judge applied to selected completed agents, with instructions, model, classifications, threshold and sampling rate. It stores reasoning and supports on-demand evaluation. Re-scoring replaces that Scorer’s earlier result.

Ted should begin with one failure mode whose evidence humans can audit, such as whether a UI change included relevant visual verification. Use Check records for whether a Check ran and passed; a transcript claim alone is weaker evidence. Treat missing evidence as unknown where appropriate. Calibrate an LLM judge against human-labeled examples before sampling more Runs.

Keep each evaluation’s rubric version, judge configuration, input references and reasoning. Prefer append-only evaluation history so a revised rubric cannot silently rewrite a baseline. Keep evaluations advisory until their error rate is understood. A favorable judge result must not override a failed Check, an open Gate or a [Failure case’s recorded result](../spec/failure-cases.md).

### 3. Compare configurations on fixed work before changing defaults

Warp’s [benchmark documentation](https://docs.warp.dev/factories/benchmarks/) describes suites for one agent, Tasks with correctness criteria, multiple configurations and repetitions. It retains trial inputs, scores terminal trials, exposes partial results and includes judge usage in reported cost. Recommendations are comparisons within that suite, not universal model rankings.

For Ted, a replay needs pinned repo commits, Original request and available context at the chosen starting point, Workflow layers, Stage files, dependency lockfile, tools and agent versions, and model and effort settings. Exclude the original solution and later steering from inputs. Separate fresh trials from retained agent memory. Give each trial an isolated worktree and sandbox, use normal queue limits, and prohibit real issue mutations, pushes and merges. A budget and cancellation path belong in the first experiment.

Start with an offline, manually curated comparison rather than automatic model routing. Ted’s existing lead/reviewer/planner settings give a place to apply a result after review. Keep the reviewer’s rubric stable while varying the implementation configuration, and preserve failed, blocked and canceled trials in the denominator. Quality and cost must be shown together.

### 4. Turn recurring failures into reviewed changes

Warp’s [Self-improvement documentation](https://docs.warp.dev/factories/measure-and-improve/self-improvement/) groups repeated scorer failures into follow-up Runs. Those can propose application or Factory definition changes. The proposed PR links to the failures and scorer results; adoption requires review.

For Ted, first produce an advisory weekly report grouping repeated Findings and send-backs, linking to their Tasks and configuration versions. A proposed fix should name the failure pattern, evidence, change and acceptance criterion. Let the human select a follow-up Task, which then follows the ordinary Workflow. Do not grant a reporting Run authority to rewrite the Library, relax permissions, approve Gates or change Checks. Exclude accepted contextual failures from automatic claims that the failure was fixed.

### 5. Keep evidence and integrations purposeful

Two useful ideas from the landing page need little new machinery in Ted. Require visual evidence to identify the behavior tested and its result; the screenshot should help the human decide whether the work is correct. For integrations, return useful status to the source of the work. Ted already does that for Linear.

Warp’s broader event intake may be useful when scheduled polling demonstrably delays important work. Any future webhook design needs authenticated deliveries, deduplication, replay handling, queue admission and untrusted-content boundaries. Cloud runners and broader forge support should follow demonstrated demand; matching Warp’s infrastructure breadth is not itself a reason to change Ted’s local execution model.

## A practical first experiment

These numbers are a proposed small pilot, not statistical assurance or Warp defaults.

1. Manually inspect 10–20 recent Tasks, including failed and sent-back work. Produce a table of outcomes, waits, interventions, configuration references, evidence and known usage. Record missing data rather than filling it with guesses.
2. Pick the most frequent observable failure. Label its examples manually, write one rubric and compare any judge’s classifications with those labels. Report disagreements and false positives.
3. Propose one Stage-file or configuration change. If replay is practical, compare it on 5–10 fixed examples with two repetitions and an agreed spend ceiling. Otherwise use a prospective observation period and state the weaker causal evidence.
4. Review the proposed change through the existing settings/Task path. Monitor later Tasks with the same rubric; revert the change if delivery quality worsens. Expand only if the report changes a real decision.

The first follow-up can be the read-only report and metric definitions. Replay execution, scoring infrastructure and event integrations are separate follow-ups, each needing its own scope and design. This research creates none of them automatically.

## How much confidence to put in Warp’s claims

Warp’s [WarpBench case study](https://www.warp.dev/factories/benchmarks/warpbench), dated 2 September 2026, reports an internal 30-task suite and a cost-per-PR reduction from about $80 to $30. It reports $2,130.57 and 3h 46m for the benchmark, which is a useful reminder that evaluation has a cost. These are vendor-reported internal results, with no independently reproduced dataset or causal experiment established here. They do not predict Ted’s savings.

That older case study says cross-harness benchmarking was not fully supported and prospective A/B testing was future work. The current benchmark documentation, updated 7 November, describes harness selection. Treat the discrepancy as dated documentation, and verify access before depending on it. Similarly, the landing page’s broad scoring language is qualified by the scorer docs’ configurable sampling. Prefer detailed, current operational documentation over illustrations and slogans.

This investigation read public first-party documentation and Ted source. It did not create a Warp account, execute a Warp factory, verify its security controls in operation or measure comparative performance. The recommendation rests on the usefulness of the method and Ted’s existing evidence, not assumed product parity.
