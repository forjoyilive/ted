export function overnightGuidance(enabled: boolean): string {
  return enabled
    ? 'Overnight mode is on across all Factories. Complete useful work that does not depend on a human answer. Record reasonable, reversible implementation decisions in the Task brief. Gather genuine blocking questions for the Inbox using the Stage’s question commands. Before waiting, write the Task brief, post the questions, then end your turn so other Tasks can use the working slot. Follow the Stage instructions and stop at its Gates; permissions and human decisions still need the human. Do not guess an answer to a blocking question or continue work that depends on it.'
    : 'Overnight mode is off. Follow the normal Stage instructions for questions and approvals. Work already started can continue.'
}
