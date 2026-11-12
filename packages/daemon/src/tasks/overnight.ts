export function overnightGuidance(enabled: boolean): string {
  return enabled
    ? 'Overnight mode is on across all Factories. Sign-offs set in the Workflow or on this Task are off, so carry the Task through its Stages without waiting for sign-off: when a Stage’s work is done, write the Task brief and run `ted outcome advance`. A sign-off TED forces (a setup Task’s Design and Review sign-offs, a Task that changes `.ted/`), a sign-off request that is already open, and permission prompts still need the human. Record reasonable, reversible decisions in the Task brief. Do not guess an answer to a genuinely blocking question: post it with the Stage’s question commands, then end your turn so other Tasks can use the working slot.'
    : 'Overnight mode is off. Sign-offs apply again from the next `ted outcome advance`. Follow the normal Stage instructions for questions and approvals. Work already started can continue.'
}
