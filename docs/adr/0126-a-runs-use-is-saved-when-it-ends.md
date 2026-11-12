# What a Run used is saved when it ends, and Settings shows it at API prices

The human pays for agents by subscription and wants to know what the same work would cost on API keys. TED already works out a Run’s tokens and cost from its output (`parsedOutput`), but only shows the cost under API-key billing, and the output is deleted `runOutputDays` after the Task is done (ADR 0098), so a month’s total can’t be read back from it.

- **Saved at the end of a Run.** When a Run finishes, `conversations.ts` reads its tokens and cost from the output it still has and commits `v1.RunUsageRecorded { runId, agent, model, input, output, cost, at }`, whatever the billing. A Run that ends again after being revived replaces its row. A Run with no tokens and no cost saves nothing.
- **Where the cost comes from.** Each agent module’s `costOf`: Claude Code’s own `total_cost_usd`, and for Codex TED’s price table in `agents/codex.ts` (standard tier, requests up to 272K input tokens). Antigravity reports no tokens, so it has no rows.
- **`store.apiCost(days)`** sums the rows of the last `days` per agent: Runs, Runs that had a cost, cost, input and output tokens, and when the first row was saved. `GET /agents/api-cost` answers the last 30 days.
- **Settings → Agents** shows it in each agent’s panel as “On an API key, last 30 days”, says for Codex that it is an estimate and for Antigravity that it isn’t available, and says since when rows have been saved while that is less than 30 days.

## Considered Options

- **Work it out from the output of the last month’s Runs.** Most of that output is gone, and reading what is left (over a gigabyte on one machine) inside the daemon is the kind of work that has been freezing it.
- **Backfill slowly in the background.** The same reading, spread out. The figures start from this release instead.

## Consequences

- The row outlives the Run’s output and its Task; it is not deleted with either.
- Codex’s figure is only as current as the price table. Update the table and its date when OpenAI’s prices change.
- The event adds one row per finished Run to the event log.
- A Run that changed model part-way is priced whole at its last model, and a Run on the agent’s default model at TED’s fallback price for Codex. Claude Code’s figure is summed across agent restarts by `costOf`, which tells a restart by the reported cost going down.
- A Run the daemon finds finished while it starts is saved then; one that finished under an older TED is not.
