export function overnightGuidance(enabled: boolean): string {
  return enabled
    ? 'Overnight mode is on across all Factories. Gates set in the Workflow or on this Task are off, so carry the Task through its Stages without waiting for sign-off: when a Stage’s work is done, write the Task brief and run `ted outcome advance`. A Gate TED forces (a setup Task, a Task that changes `.ted/`, Clarify at grilling depth), a Gate request that is already open, and permission prompts still need the user. Record reasonable, reversible decisions in the Task brief. Do not guess an answer to a genuinely blocking question: post it with the Stage’s question commands, then end your turn so other Tasks can use the working slot.'
    : 'Overnight mode is off. Gates apply again from the next `ted outcome advance`. Follow the normal Stage instructions for questions and approvals. Work already started can continue.'
}
