# Security policy

## Reporting a vulnerability

Report security problems privately through GitHub: open the repo’s [Security tab](https://github.com/forjoyilive/ted/security) and click **Report a vulnerability**. The report stays private.

Don’t open a public issue, discussion or pull request for a security problem.

A useful report says:

- what the problem is and what an attacker could do with it
- the steps to reproduce it, or a proof of concept
- the TED version and operating system you used

Responses are best effort. There is no set time for a reply or a fix.

## Supported versions

Only the [latest release](https://github.com/forjoyilive/ted/releases/latest) gets security fixes. Update TED before reporting, and check whether the problem still happens.

## In scope

Problems in TED’s own code, such as:

- the daemon’s local API, its tokens and who can call it
- the OS sandbox around Checks, worktree setup and Apps, and what a Run can reach outside its Task
- how TED stores and uses credentials (the Linear API key, Asana and GitHub access)
- in-app updates and the release feed
- the Electron app, including the HTML and prototypes it shows

## Out of scope

- Bugs in the agent CLIs TED starts, such as Claude Code and Codex. Report those to their makers.
- Bugs in GitHub, Linear, Asana or other services TED connects to.
- Commands that run outside TED’s sandbox in a Factory set to Bypass, which turns the sandbox off on purpose. TED’s other protections, such as the daemon’s token checks, still apply in Bypass, and flaws in them are in scope.
- Problems that need someone who already controls your computer or your user account.
