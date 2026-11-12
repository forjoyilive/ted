# LiveStore stays behind one store module, and events are never changed

Only `packages/daemon/src/store/` imports LiveStore. The rest of the daemon calls the `TedStore` interface, so if LiveStore hits a blocker, PowerSync (the named fallback) replaces one module. LiveStore runs through `@livestore/adapter-node` in single-threaded mode with its SQLite files under `TED_HOME/store/`; its SQLite is WASM, so nothing needs rebuilding for Electron.

Events are named `v<N>.<PastTense>`, such as `v1.TaskCreated`. A shipped event is never edited: a change gets a new name (`v2.TaskCreated`) and the old one keeps its materializer, so state can always be rebuilt from the log.

Materializers see only an event’s own data, so the daemon decides anything derived, such as a Task’s number (the highest number in its Factory plus one), before it commits the event.

Until Factories exist (KRI-124), every Task belongs to a built-in placeholder Factory with ID `dev` and key `DEV`, so Tasks show as `DEV-1`. `v1.TaskCreated` already carries `factoryId`, so real Factories need no new event version.
