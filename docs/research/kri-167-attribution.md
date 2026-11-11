# agent-orchestrator attribution (KRI-167)

Checked 2026-11-10 for [KRI-167](https://linear.app/kriyadesign/issue/KRI-167/is-teds-attribution-for-agent-orchestrator-code-correct).

## Evidence

The reference snapshot is upstream commit [`5cde191aad88cf58867c49e5a841f24816815118`](https://github.com/OrchestratorInc/agent-orchestrator/tree/5cde191aad88cf58867c49e5a841f24816815118), dated 2026-11-07T22:22:38Z. It was selected through GitHub’s commits API as the latest commit before 2026-11-08 UTC, before KRI-122’s packaging work. This is a reproducible verification snapshot, not a claim that TED originally ported this exact revision; TED’s source headers do not record that revision.

- The snapshot’s [LICENSE](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/LICENSE) includes Apache-2.0’s terms and appendix, with “Copyright 2026 Untrivial”. TED’s previous copy stopped at the end of the terms. The restored bundled LICENSE matches all 201 upstream lines byte for byte.
- The complete recursive Git tree returned by GitHub’s API was not truncated and contains no file named NOTICE. It does contain [wake-helper/THIRD_PARTY_NOTICES.md](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/frontend/native/wake-helper/THIRD_PARTY_NOTICES.md), an MIT notice crediting Krish Garg. That belongs to the native wake helper, outside the source paths identified in TED’s ports below. This review does not establish that every upstream release distribution lacks a NOTICE.
- Each upstream source below was read in full. None contains a copyright, SPDX, “licensed under”, or “all rights reserved” notice. TED’s corresponding files already name the source and describe TED’s changes at the top.

| TED file | Upstream source at the reference snapshot |
| --- | --- |
| `packages/daemon/src/agents/codex-chat.ts` | [codexappserver/normalize.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/backend/internal/adapters/chatdriver/codexappserver/normalize.go), [commanddetail/command.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/backend/internal/adapters/chatdriver/commanddetail/command.go) |
| `packages/daemon/src/agents/diff.ts` | [acp/diff_stats.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/backend/internal/adapters/chatdriver/acp/diff_stats.go), normalize.go above |
| `packages/app/src/renderer/components/RunChat.tsx` | [ActivityRun.tsx](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/frontend/src/renderer/components/chat/ActivityRun.tsx), [ChatTimelineItems.tsx](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/frontend/src/renderer/components/chat/ChatTimelineItems.tsx) |
| `packages/daemon/src/tasks/github-activity.ts` | [lifecycle/reactions.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/backend/internal/lifecycle/reactions.go), [domain/pr.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/5cde191aad88cf58867c49e5a841f24816815118/backend/internal/domain/pr.go) |

A repo-wide search for agent-orchestrator identifies these four marked source files. This inventory covers declared ports; it cannot prove that no unmarked copying occurred.

## Assessment and correction

[Apache-2.0 section 4](https://www.apache.org/licenses/LICENSE-2.0) requires supplying the license, marking modified files and preserving applicable source notices. Its upstream NOTICE preservation condition applies when the distributed work includes such a file; it also permits added attribution that does not change the license. This supports keeping factual TED-authored credit, rather than describing it as a substitute for an upstream NOTICE. It does not establish a blanket legal compliance conclusion.

TED’s attribution now explicitly identifies its author, retains the verified copyright, and includes the GitHub activity port omitted from the previous list. The full upstream LICENSE follows it in the existing generated Third-party licenses output. The generator and packaging already use these files; neither needs a behavior change.

The shorter alternative is to retain the applicable upstream copyright/license header and full license, with adaptation details confined to source headers. Asking the upstream authors about preferred credit remains another option. No outreach was sent. Human confirmation of the finished wording remains necessary under KRI-167 before release.
