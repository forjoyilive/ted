# Phone relay protocol

How a paired iPhone and the Ted daemon talk through the relay. The daemon lives in `forjoyilive/ted`; the relay (a Cloudflare Worker) and the phone app live in `forjoyilive/ted-mobile`, which keeps a copy of this file at `docs/phone-relay.md`. Change both copies together.

The daemon and the phone each open an outbound WebSocket to the relay. The daemon still listens only on `127.0.0.1`. Every message between phone and daemon is encrypted and authenticated with NaCl box (`tweetnacl`: X25519, XSalsa20-Poly1305). The relay sees only ciphertext, connection times and sizes.

All binary values are base64url without padding. All frames are UTF-8 JSON text frames.

## Keys

| Key | Kind | Where it lives |
| - | - | - |
| Mac box key | X25519 key pair | Daemon, in the OS Keychain (keyring accounts `phone-relay-box-key`). Never in `TED_HOME`. |
| Mac relay key | Ed25519 key pair | Daemon, in the OS Keychain (`phone-relay-sign-key`). Used only to log in to the relay. |
| Phone box key | X25519 key pair | Made on the phone, kept in `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Never leaves the phone. |
| Phone relay key | Ed25519 key pair | Made on the phone with the box key, kept the same way. Used only to log in to the relay. The Mac stores its public key with the pairing. |
| Pairing secret | 32 random bytes | Daemon memory only, and the QR code. Never written to disk or logs. |
| Pairing ticket | 32 bytes | `HMAC-SHA256(key = pairing secret, "ted-relay-pairing:v1:<channel>:<pairing ID>")`, worked out by both sides. Lets a pairing phone reach the relay. The relay stores only `SHA-256(ticket)`, the **ticket hash**. |

The **channel** is `base64url(SHA-256(Mac relay public key))`. It names the Mac at the relay.

## Pairing link (the QR code)

`ted-pair:` followed by `base64url(JSON)`:

```json
{
  "v": 1,
  "edition": "release",
  "relay": "https://relay.example.workers.dev",
  "channel": "<channel>",
  "macKey": "<Mac box public key, 32 bytes>",
  "pairing": "<pairing ID, 16 random bytes>",
  "secret": "<pairing secret, 32 bytes>",
  "expiresAt": 1795135669031
}
```

`edition` is `release` (Ted) or `dev` (Ted Dev). `relay` is an `http:` or `https:` URL (in the daemon: `defaultRelayUrl` in `packages/protocol/src/phones.ts` for Ted, `https://ted-relay.forjoyilive.workers.dev`; `http://127.0.0.1:8787` for Ted Dev, or `TED_RELAY_URL`); clients use `ws:` or `wss:` on the same host. `expiresAt` is milliseconds since the epoch, five minutes after the link was made. A phone refuses a link with an unknown `v`, a different edition from its own variant, or a past `expiresAt`. The Simulator has no camera, so the phone app also accepts the same link pasted as text.

## Relay

Routes:

- `GET /health` answers `{"ok":true}`.
- `GET /v1/mac/<channel>`: WebSocket for the daemon.
- `GET /v1/phone/<channel>`: WebSocket for a phone.
- `GET /v1/phone/<channel>/check`: tells a phone whether it would be let in, without opening a socket.

Everything else is 404, and a socket route without `Upgrade: websocket` is 426. One Durable Object per channel holds the sockets and the channel’s stored state. The relay never parses `data`, and logs no headers, frames, keys, tickets or hashes.

### Login

Every request to a socket route or `/check` carries a `Ted-Relay-Auth` header, checked before any socket opens. Credentials never go in the URL. The header is `base64url(JSON)`, at most 1,024 characters:

```json
{ "v": 2, "mode": "phone", "key": "<32 bytes>", "at": 1795135669031, "nonce": "<16 random bytes>", "sig": "<64 bytes>", "ticket": "<32 bytes, pairing mode only>" }
```

- `mode` is `mac` (the daemon, on the `mac` route), `phone` (a paired phone) or `pairing` (a phone that holds a pairing ticket); `phone` and `pairing` use the `phone` and `check` routes.
- `key` is the Mac relay public key or the phone relay public key. `at` is the sender’s clock in milliseconds; the relay refuses one more than 60 seconds from its own. Every request uses a new `nonce`.
- `sig` is an Ed25519 signature by `key` over the UTF-8 bytes of `ted-relay-login:v2:<mode>:<route>:<host>:<channel>:<at>:<nonce>:<ticket hash or ->`. `route` is `mac`, `phone` or `check`; `host` is the request URL’s host (with its port, if any).

The Worker refuses a missing or malformed header, a field of the wrong size, a `mode` that doesn’t match the route, a stale `at`, a bad signature, and in `mac` mode a key whose `SHA-256` isn’t the channel, with HTTP 401. The Durable Object then decides, in one step with no wait between the decision and opening the socket:

| Mode | Let in when | Otherwise |
| - | - | - |
| `mac` | always | — |
| `phone` | the channel has a stored phone list and `key` is on it | 503 with no stored list; 403 when `key` isn’t on it |
| `pairing` | the ticket hash is a live ticket: before a candidate is set, until the ticket’s `expiresAt` and while it has fewer than 2 sockets; after, only for the candidate’s `key`, and never later than two minutes after `expiresAt` | 403 |

Only a request it lets in has its `(key, nonce)` recorded, for 3 minutes; the same pair again is 401. When the paired-phone sockets are full, a new `phone` request gets 429. `/check` follows the same rules but answers 200 instead of opening a socket.

### Mac socket

On open the relay sends `{"t":"ready"}`, and every phone socket on the channel gets `{"t":"mac-online"}`. A new Mac socket replaces the old one, which is closed with code 4409; frames still arriving on the old one are ignored. When the Mac socket closes, every phone socket gets `{"t":"mac-offline"}`.

- Relay → Mac: `{"t":"msg","conn":<number>,"data":"<envelope>"}` for each phone frame, where `conn` numbers phone sockets on this channel. `{"t":"closed","conn":<number>}` when a phone socket closes.
- Mac → relay: `{"t":"msg","conn":<number>,"data":"<envelope>"}`. The relay sends `{"t":"msg","data":"<envelope>"}` to that phone socket, or drops it if that socket is gone.

The Mac also keeps the relay’s phone list and pairing tickets current. Each frame below gets an answer, and the daemon sends it again after a reconnect until it does:

| Mac → relay | Relay → Mac |
| - | - |
| `{"t":"phones","rev":<number>,"keys":["<phone relay key>", …],"base":"<list hash or null>"}`, at most 64 keys | `{"t":"phones-ok","rev":<n>}` when the list equals the stored one (same `rev` and keys), or when `rev` is above the stored one and `base` is the stored list’s hash (the list is stored). With no stored list, any `base` is accepted. `{"t":"phones-stale","rev":<stored>}` when `rev` is below the stored one. `{"t":"phones-conflict","rev":<n>}` otherwise: an equal `rev` with different keys, or a `base` that isn’t the stored list’s hash. |
| `{"t":"pairing","hash":"<ticket hash>","expiresAt":<ms>}` | `{"t":"pairing-ok","hash":"…"}` |
| `{"t":"pairing-candidate","hash":"…","key":"<phone relay key>"}` | `{"t":"pairing-candidate-ok","hash":"…"}`, or `{"t":"pairing-gone","hash":"…"}` when the ticket has ended |
| `{"t":"pairing-end","hash":"…"}` | `{"t":"pairing-end-ok","hash":"…"}` |

The daemon sends the full list right after `ready` and after every change. `rev` only grows on a Mac: it goes up with every phone paired or removed. A **list hash** is `base64url(SHA-256("<rev>:" + the keys sorted and joined with ","))`. `base` is the hash of the last list the relay acknowledged to this Mac, which the daemon records as `v1.PhoneRelayListAcked`, or `null` before the first. A restored copy of Ted’s data holds an older acknowledged hash, so the relay answers `phones-conflict` even when the restored `rev` has grown past the stored one. The daemon records each list before sending it, and after a reconnect or restart it sends an unacknowledged one again exactly (same `rev`, keys and `base`) before anything newer, which the relay acknowledges as an equal list. The daemon forwards no phone messages on a new Mac socket until its first list is acknowledged, and stops forwarding at once on `phones-stale` or `phones-conflict`. When a stored list drops a key, the relay closes that key’s `phone` socket with code 4403 at once. Setting a candidate closes the ticket’s other sockets with 4403. Ending a ticket deletes it and closes its sockets with 4403. The relay keeps at most 4 tickets per channel, dropping the oldest, and deletes a ticket by itself two minutes after its `expiresAt`.

### Phone socket

On open the relay sends `{"t":"mac-online"}` or `{"t":"mac-offline"}`. A phone relay key has one `phone` socket at a time: a new one closes the old one with 4409.

- Phone → relay: `{"t":"msg","data":"<envelope>"}`. With the Mac online the relay forwards it; otherwise it answers `{"t":"mac-offline"}`.
- Relay → phone: `{"t":"msg","data":"<envelope>"}`, `{"t":"mac-online"}`, `{"t":"mac-offline"}`.

When a socket fails to open, the phone asks `/check` with a fresh header. 403 means the Mac no longer recognises this phone: the phone says so and keeps its pairing, and the user can unpair in Settings. A 4403 close on an open `phone` socket means the same. Anything else is treated as the Mac being offline, and the phone retries.

### Limits

A frame over 65,536 bytes, a frame that isn’t JSON of the shapes above, or `data` that isn’t a string closes the socket with code 4400. At most 16 `phone` sockets per channel, and 2 per pairing ticket on top.

## Envelope

The `data` string is JSON:

```json
{ "v": 1, "from": "<sender box public key>", "nonce": "<24 random bytes>", "box": "<nacl.box ciphertext>" }
```

`box = nacl.box(utf8(JSON.stringify(message)), nonce, recipientPublicKey, senderSecretKey)`. The envelope format stays at `v: 1`; changes to messages go through `protocol` below. A receiver drops an envelope it can’t parse or open, without answering.

## Messages

Every message inside a box has:

```json
{ "protocol": 3, "id": "<16 random bytes>", "at": 1795135669031, "type": "…" }
```

`at` is the sender’s clock in milliseconds. The daemon drops a message whose `at` is more than 120 seconds from its own clock, or whose envelope `nonce` it has already seen from that sender in the last 120 seconds. A reply carries the request’s `id`; the phone ignores a reply whose `id` it isn’t waiting for.

### Phone → Mac

- `{"type":"pair","pairing":"<pairing ID>","secret":"<secret>","name":"iPhone 16","edition":"dev","relayKey":"<phone relay public key>","relayProof":"<Ed25519 signature>"}` sent from the phone’s new box key, over a `pairing` socket. `relayProof` is signed by the relay key over the UTF-8 bytes of `ted-relay-key:v1:<pairing ID>:<phone box public key>` (protocol 3).
- `{"type":"pair-status","pairing":"<pairing ID>"}` from the same key, polled every 2 seconds while waiting.
- `{"type":"request","route":"status"}` from a paired phone’s key.
- `{"type":"request","route":"requests"}`, `{"type":"request","route":"request","requestId":"<request ID>"}` and `{"type":"request","route":"answer","requestId":"<request ID>","answer":{…}}` from a paired phone’s key (protocol 2; see Inbox requests below). The request ID goes in `requestId` because `id` is the message’s own ID.
- `{"type":"request","route":"push-token","token":"ExponentPushToken[…]"}` from a paired phone’s key. The daemon accepts only `ExponentPushToken[…]` or `ExpoPushToken[…]` with 1 to 200 letters, digits, `_` or `-` inside the brackets, and stores it with that phone’s pairing; any other value gets `bad-request`. A token another paired phone held moves to this phone.
- `{"type":"request","route":"problems"}` from a paired phone’s key. A Mac older than this route answers `unknown-route`, which the phone treats as no problems.
- `{"type":"request","route":"tasks","group":"status","cursor":"<cursor>"}`, `{"type":"request","route":"task","taskId":"TED-786"}` and `{"type":"request","route":"task-comments","taskId":"TED-786","cursor":"<cursor>"}` from a paired phone’s key (see Tasks below). `group` is optional and `status` when left out; `cursor` is optional. `taskId` is 1 to 200 characters and `cursor` 1 to 512; anything else gets `bad-request`. A Mac older than these routes answers `unknown-route`.
- `{"type":"request","route":"task-start","taskId":"TED-788"}`, `task-stop`, `task-resume` (optional `text`), `task-priority` (`priority`), `task-comment` (`text`), `task-archive` (`hierarchyRevision`, `closePullRequests`, optional `children`) and `task-delete` (`hierarchyRevision`, optional `children`) from a paired phone’s key (see Task actions below). A Mac older than these routes answers `unknown-route`.
- `{"type":"request","route":"image","image":"<image ID>","part":0}` from a paired phone’s key (see Images below). `image` is 1 to 200 characters and `part` a whole number from 0; anything else gets `bad-request`. A Mac older than this route answers `unknown-route`.
- `{"type":"request","route":"factories"}` and `{"type":"request","route":"task-create","createId":"<16 random bytes>","factory":"NB","title":"…","description":"…","priority":"none","start":false}` from a paired phone’s key (see New Task below). A Mac older than these routes answers `unknown-route`.
- `{"type":"request","route":"chats","factoryId":"<Factory ID>","archived":false,"cursor":"<cursor>"}`, `{"type":"request","route":"chat","chatKind":"coordinator","chatId":"<chat ID>"}`, `{"type":"request","route":"chat-items","chatKind":"coordinator","chatId":"<chat ID>","before":"<cursor>"}` and `{"type":"request","route":"chat-item","chatKind":"plan","chatId":"<chat ID>","itemId":"<item ID>","offset":120}` from a paired phone’s key (see Chats below). `factoryId`, `archived`, `cursor`, `before` and `offset` are optional. `chatKind` is `coordinator` or `plan`; `factoryId`, `chatId` and `itemId` are 1 to 200 characters, `cursor` and `before` 1 to 512, and `offset` a whole number from 0; anything else gets `bad-request`. A Mac older than these routes answers `unknown-route`.

### Mac → phone

`{"type":"reply","ok":true,"body":{…}}` or `{"type":"reply","ok":false,"error":{"code":"<code>","message":"<plain sentence>"}}`, plus the common fields.

- `pair` → `{"state":"waiting","code":"482913"}`.
- `pair-status` → `{"state":"waiting"}`, `{"state":"approved","mac":"Studio Mac"}`, `{"state":"refused"}` or `{"state":"expired"}`.
- `status` → `{"mac":"Studio Mac","edition":"dev","version":"1.4.0","protocol":3}`.
- `requests` → `{"requests":[<summary>, …],"more":0}`.
- `request` → `{"request":<detail>}`.
- `answer` → `{"answered":true}`.
- `push-token` → `{}`.
- `tasks` → `{"rows":[<row>, …],"sections":[<section>, …],"cursor":"<cursor>","at":"<ISO time>"}`.
- `task` → `{"task":<task>}`.
- `task-comments` → `{"entries":[<entry>, …],"cursor":"<cursor>"}`.
- `task-start`, `task-stop`, `task-resume`, `task-priority` and `task-comment` → `{"task":<task>}`, the Task as the `task` route shows it after the change.
- `task-archive` and `task-delete` → `{}`.
- `image` → `{"mediaType":"image/jpeg","parts":3,"part":0,"data":"<base64url bytes>"}`.
- `factories` → `{"factories":[{"key":"NB","name":"Notebook","icon":<icon>,"defaultPriority":"none"}, …]}`.
- `task-create` → `{"task":<task>}`, the new Task as the `task` route shows it, with `"startRefused":"<sentence>"` added when Start now was asked for and the start was refused.
- `chats` → `{"factories":[<chat Factory>, …],"rows":[<chat row>, …],"archivedCount":3,"cursor":"<cursor>"}`.
- `chat` → `{"chat":<chat row>}`.
- `chat-items` → `{"items":[<chat item>, …],"cursor":"<cursor>"}`.
- `chat-item` → `{"lines":[<detail line>, …],"next":240}`.
- `problems` → `{"problems":[{"id":"clone-failed:<Factory ID>","factory":"Notebook","text":"Couldn’t clone …","raisedAt":"<ISO time>"}, …]}`: the current stops-work banners, newest first, never warnings. `factory` is the Factory’s name, cut to 200 characters, and is left out for a problem that affects every Factory. `text` is the banner’s text through `redactSecrets`, cut to 500 characters; at most 50 problems, and fewer when the next one would take the reply past `phoneReplyBodyMax` bytes.

### Push notifications

While the desktop app reports the user away (2 minutes idle or the screen locked, `POST /presence`), or hasn’t reported for 90 seconds, the daemon sends each phone with a push token one Expo notification per waiting Inbox request that counts (Inbox notifications on, globally and for its Factory, and not snoozed) and that started waiting while the user was away, and not before the phone was paired. The user counts as away from 2 minutes before an away report (the app’s idle time), from the last report when reports stop, or from the daemon’s start when there was none; a request that started waiting earlier is never sent, so stepping away, pairing a phone or pairing it again sends no backlog. Title: the Task, chat or Automation title; body: the question headline, both through `redactSecrets` and cut to 180 characters; a permission request’s body is “Permission requested”. `data.requestId` is the ID the `request` route takes. Each send is recorded as `v1.PhoneNotified` under the phone, request ID and time the request became waiting (its creation, or its last return from snooze). A request is sent to a phone at most once: a restart never resends it, and neither does a return from snooze. A request snoozed before it was sent and back from snooze while the user is away is sent then. A `DeviceNotRegistered` ticket clears the token.

With Problems notifications on (machine setting `notifyProblems`), the same away rule sends one notification per phone when a stops-work banner is raised, and none when it clears. A problem raised while the user was at the Mac, by the same 2-minute rule, or before the phone was paired is never sent. Title: “Work stopped · <Factory>”, or “Work stopped · Ted” for a problem that affects every Factory; body: the banner’s text, through `redactSecrets` and cut to 180 characters. `data` is `{"opens":"problems"}` instead of a `requestId`. It is recorded as `v1.PhoneNotified` with request ID `problem:<banner ID>` and the banner’s `raisedAt`, so a restart or a change to the banner’s text never resends it, and a problem that clears and comes back is sent again.

### Error codes

| Code | When |
| - | - |
| `not-paired` | The sender’s key isn’t a paired phone (never paired, or removed on the Mac). The phone clears its pairing. |
| `expired` | The pairing ID is unknown, cancelled or past five minutes. |
| `used` | The pairing already took a phone. |
| `wrong-edition` | Ted paired with Ted Dev’s phone app, or the other way round. |
| `too-old` | The phone’s `protocol` is below the daemon’s minimum. The phone says “Update the Ted app on your phone.” |
| `too-new` | The phone’s `protocol` is above the daemon’s. The phone says “Update Ted on your Mac.” |
| `bad-request` | The message has the wrong shape. |
| `unknown-route` | `request` names a route not marked for phones. |
| `gone` | The request was answered, withdrawn or superseded elsewhere, or its Task, plan or Automation is gone; or, on `task`, `task-comments` and the Task actions, no Task has that ID or the Task is archived; or, on a repeated `task-create`, the Task it made is deleted or archived; or, on `chat`, `chat-items` and `chat-item`, no chat of that kind has that ID (deleted on the Mac), or, on `chat-item`, the chat has no item with that ID. The phone says so and drops it from the list. |
| `answer-on-mac` | The phone may not answer this request. The daemon refuses it whatever the phone sends. |
| `refused` | Ted’s own code refused the answer (for example a choice that isn’t offered), the Task action (for example Stop on a Task that hasn’t started, or Archive after the Task’s family changed) or the new Task (for example no title, or an unknown Factory). `message` is the daemon’s sentence, through `redactSecrets`. |

A phone that gets a reply with a `protocol` above its own says “Update the Ted app on your phone.”

## Inbox requests

Protocol 2 adds three routes. They show the open requests the desktop Inbox shows and answer some of them. Apart from these, the read-only Tasks routes, the seven Task actions and New Task below, a phone gets nothing: no settings, Factory changes, Runs or other Task changes.

### `requests`

The open requests from every Factory, in the desktop Inbox’s order, leaving out snoozed ones. Each **summary**:

```json
{
  "id": "<request ID>",
  "source": "task",
  "kind": "question",
  "factory": "Ted",
  "title": "List and answer Inbox requests on the phone",
  "ref": "TED-700",
  "headline": "Which repo should hold the parser?",
  "createdAt": "2026-11-19T18:22:53.000Z",
  "failed": true,
  "onPhone": true
}
```

- `source`: `task`, `plan` (a planning chat), `automation` or `chat` (a Coordinator chat).
- `kind`: `question`, `round`, `permission`, `signoff`, `proposal`, `review` or `request` (anything else, such as a Coordinator confirmation).
- `title`: the Task title, plan title, Automation name or chat title. `ref` is the Task’s display ID, only for `task`.
- `headline`: at most 200 characters. `failed` appears only when the request comes from a failed Run.
- `onPhone`: whether the phone may answer it. When `false` the phone opens it read-only with “Answer on your Mac”.

The daemon keeps the reply under the frame limit. When requests had to be left out, `more` counts them and the phone says how many more are on the Mac.

### `request`

One request with what the phone needs to answer it. The **detail** is the summary plus:

```json
{
  "body": "<Markdown>",
  "cut": false,
  "attachments": 0,
  "images": [{ "image": "<image ID>", "caption": "sidebar.png" }],
  "form": { "type": "choices", "choices": ["Yes", "No"], "multiple": false, "text": true }
}
```

- `body`: the request’s text as Markdown. `cut` is `true` when the daemon shortened it to fit; the phone then shows “The rest is on your Mac”. Images linked in the Markdown show as “Open on your Mac”.
- `images`: the request’s image attachments, in order, each with its file name as `caption` (cut to 200 characters). The phone loads each one through the `image` route. Left out when there are none; an older Mac never sends it.
- `attachments` counts the attached files that aren’t in `images`; the phone shows them as “Open on your Mac”. For a design review, the files its `design` form names (screenshots, prototype, video) are in neither.
- `form` is one of:
  - `{"type":"choices","choices":[…],"multiple":false,"text":true}`: pick one choice (or several with `multiple`), and when `text` is `true`, optionally add text.
  - `{"type":"text"}`: free text only.
  - `{"type":"round","questions":[{"question":"…","choices":["…"],"multiple":false,"recommended":"…","recommendedChoices":["…"]}]}`: a question round; `choices`, `multiple` and `recommendedChoices` are optional.
  - `{"type":"permission","command":"<full command>","cut":false}`: allow or deny.
  - `{"type":"signoff","stage":"Design","brief":"<Markdown>","cut":false}`: the Task brief, then approve or request changes with text. The user approves without seeing the diff.
  - `{"type":"design","stage":"Design","brief":"<Markdown>","cut":false,"design":{…}}`: a design review (request `kind` `review`), answered like `signoff`. A phone that doesn’t know `design` shows it as `mac`. `design` holds:
    - `summary` (Markdown) and `worthYourEye` (a list of Markdown lines), each left out when empty.
    - `screenshots`: `[{"image":"<image ID>","caption":"Step 1 · Welcome"}]`, in order; `caption` is left out when the review has none.
    - `figma`: `{"url":"https://www.figma.com/…","label":"Onboarding v2"}`, `label` optional. The phone opens only `https://` Figma links.
    - `prototype` and `video`: `{"name":"onboarding.html","caption":"…"}`, `caption` optional. The phone names them and says to open them on the Mac.
    - `setup`: a Setup proposal, as plain lines: `{"workflow":[{"stage":"Clarify","setting":"few questions"}],"checks":[{"name":"Tests","command":"pnpm test","repo":"app","passed":false,"seconds":41,"reason":"…"}],"apps":[{"name":"Web","kind":"web","run":"pnpm dev","repo":"app","passed":true,"reason":"…"}],"agents":[{"name":"Reviewer","about":"…"}],"worktree":[{"repo":"app","step":"setup","access":["~/.npm"]}],"files":[{"path":".ted/workflow.yaml","about":"…"}],"defaults":"…"}`. Every list and optional field is left out when empty. Approving from the phone keeps every suggested Agent, as Approve on the Mac does when none is unticked.
    Every text goes through `redactSecrets`. Texts are cut to fit the reply: the brief first, then `worthYourEye`, then `summary`; `cut` is `true` when any of them was cut, and the phone shows “The rest is on your Mac”.
  - `{"type":"proposal","title":"…","summary":"…","rows":[{"title":"…","scope":"…","priority":"high","blockedBy":[1]}]}`: approve or send back with text. Rows can’t be edited on the phone.
  - `{"type":"mac","reason":"<plain sentence>"}`: read-only; answer on the Mac.

### `answer`

`answer` is one of:

- `{"action":"answer","choice":"…"}`, `{"action":"answer","choices":["…"]}` or `{"action":"answer","text":"…"}`, with optional `text` beside a choice, for `choices` and `text` forms.
- `{"action":"answer-round","answers":[{"answer":"…","choices":["…"]}]}`: one entry per question, in order. For a question with `multiple`, `choices` holds the picks and `answer` holds only extra typed text, usually `""`.
- `{"action":"approve"}` for `permission`, `signoff` and `proposal`.
- `{"action":"deny"}` for `permission`.
- `{"action":"request-changes","text":"…"}` for `signoff` and `proposal`.

The daemon answers through the same code as the desktop app, as the human. A “request changes” from the phone doesn’t send the line-comment drafts made on the Mac. The phone sends an answer only while the Mac is online and never stores one to send later.

## Tasks

Three read-only routes show Tasks as the phone app draws them. Nothing a phone sends through them changes anything on the Mac. Every text (titles, names, status lines, descriptions, comments) goes through `redactSecrets` first, and every reply’s JSON body stays under `phoneReplyBodyMax` (40,000 bytes).

### `tasks`

Open Tasks and Tasks that entered Done in the last 7 days, from every Factory. Archived Tasks are never listed. The Done time is when the Task last entered Done, else when it merged, else when it last changed.

`group` names the grouping, and the Mac groups and orders:

- `status`: sections `needs-you` (Needs you: waiting on you and not snoozed, failed, partly merged), `working` (Working: working, queued), `waiting` (Waiting or blocked: blocked, paused, waiting for GitHub, stopped, snoozed, and a Task outside Backlog with no status), `backlog` (Backlog: in Backlog with no status) and `done` (Done), in that order.
- `factory`: one section per Factory, keyed by Factory ID, in the Mac’s Factory order.
- `stage`: one section per Stage, keyed by Stage ID, in the default Workflow’s Stage order, with Stages only some Factories use after the Stage they follow in their own Workflow.

Inside a section, rows follow the Mac’s All Tasks order: priority, then rank, then creation time. A **row**:

```json
{
  "id": "<Task ID>",
  "ref": "TED-786",
  "title": "Build the phone Task routes",
  "factory": { "id": "<Factory ID>", "name": "Ted", "icon": { "kind": "symbol", "symbol": "code", "color": "blue" } },
  "stage": { "id": "work", "name": "Work" },
  "status": "Queued · 3rd",
  "tone": "working",
  "priority": "high",
  "section": "working",
  "updatedAt": "2026-11-20T09:00:00.000Z"
}
```

- `title` is cut to 500 characters; Factory, Stage and section names and `status` to 200.
- `icon` is `{"kind":"letter","color":…}`, `{"kind":"symbol","symbol":…,"color":…}` or `{"kind":"emoji","emoji":…}`. It is left out when the Factory has no icon or an image icon; the phone then draws its own letter.
- `status` uses the desktop’s wording (“Waiting on you”, “Queued · 3rd”, “Blocked by TED-12”), and is `""` when the Task has no status (Backlog and Done).
- `tone` is `working` (working, queued), `waiting` (waiting on you, blocked, paused, waiting for GitHub, snoozed), `failed` (failed, partly merged), `stopped`, `done` or `none` (no status).
- `section` is the row’s section key in the grouping asked for.
- `actions` lists the Task actions the Mac offers for the Task now, in this order: `start` (in Backlog), `stop` (where the Mac shows Stop Task), `resume` (stopped or failed; the Mac’s Retry does the same), `priority`, `comment` (left out while Ted is merging the Task’s pull requests, when the Mac offers only Send and cancel merge), `archive` and `delete`. At most one of `start`, `stop` and `resume` appears, and none in Done or when the Mac shows Move to Backlog. The phone offers only these; the daemon still decides each action when it arrives.

`sections` holds `{"key":"working","label":"Working","count":12}` for each section with at least one Task, in order, on every page; `count` counts the whole list, not the page. `sections` never takes more than half of `phoneReplyBodyMax`, so at least one row always fits: when it would, the Mac cuts every label to 100 characters, then 50, then 20, then none, and as a last resort sends only the sections that fit, with empty labels. `at` is when the Mac made the page.

**Paging.** A page holds as many rows as fit under the size limit. When rows are left, `cursor` is set; the phone sends it back to get the next page, with the same `group`. The last page has no `cursor`. A cursor is opaque base64url text of at most 512 characters, holding the last row’s place in the order (section, priority, rank, creation time, Task ID). The next page starts after that place in the current order, so it stays well defined when that Task has moved or gone. A Task that moves earlier between pages is skipped, and one that moves later can show again; the phone replaces a row whose Task ID it already holds. The Mac decodes a cursor strictly: one that doesn’t decode, or was made for another route, gets `bad-request`.

### `task`

One Task by its display ID (`TED-786`) or full ID, to refresh a row in place. The **task** is the row plus:

```json
{
  "description": "<Markdown>",
  "cut": false,
  "childTasks": 2,
  "openPullRequests": 1,
  "hierarchyRevision": "<revision>"
}
```

`section` here is the Task’s `status` section key. `childTasks` counts the Task’s child Tasks and theirs, as the Mac’s Archive and Delete dialogs do; `openPullRequests` counts its repos with a pull request that isn’t closed or merged, as the Mac’s Archive dialog does. `hierarchyRevision` is opaque text (a SHA-256 in hex) covering the Task and each of its child Tasks and theirs: for each, the fields the Mac’s hierarchy revision covers (parent, children, Stage, archived, blockers, status, Runs, last change and merge) and its open pull requests. Any change to one of them, such as an edit to the Task on the Mac, changes it. `task-archive` and `task-delete` send it back. The description is cut at 16,000 characters, then to the bytes left in the reply, and `cut` is `true` when either happened. An unknown or archived Task gets `gone`.

### `task-comments`

Every entry in the Task’s thread, newest first: notes from the user, the Task Lead and Ted, and every request kind. An **entry**:

```json
{
  "id": "<comment ID>",
  "author": "Task Lead",
  "kind": "request",
  "createdAt": "2026-11-20T09:00:00.000Z",
  "text": "<Markdown>",
  "cut": false,
  "images": 0,
  "imageList": [{ "image": "<image ID>", "caption": "before.png" }],
  "attachments": 1,
  "formattedBlocks": 2,
  "request": { "kind": "question", "stage": { "id": "clarify", "name": "Clarify" }, "open": true, "requestId": "<request ID>" }
}
```

- `author` is “You”, “Ted”, “Task Lead”, or for a message from another agent “Peer · <sender>” (or “Peer message”), as the Mac’s thread shows them.
- `kind` is `note` or `request`. Only a request has `request`.
- `text` is cut at 2,000 characters, and further only when a single entry would not fit the reply; `cut` says so.
- `images` counts the image attachments and `imageList` lists them, like a request’s `images`, for the phone to load through the `image` route (left out when there are none; an older phone uses the count). `attachments` counts the other files, and `formattedBlocks` the Markdown tables and fenced code blocks, which the phone says read better on the Mac.
- `request.kind` uses the same values as the Inbox `kind`. `stage` is left out when the request has none. `open` is `true` until the request is answered, withdrawn or superseded. `requestId` is the ID the `request` route takes, sent only while the request waits in the Inbox (open and not snoozed).

A page holds as many entries as fit; `cursor` (the last entry’s time and ID, opaque like the list cursor) gets older entries and is left out when none are left. A bad cursor gets `bad-request`; an unknown or archived Task gets `gone`.

## Images

The `image` route sends one image attachment of a Task comment, in parts, because a reply must stay under `phoneReplyBodyMax`.

- An **image ID** is opaque text the Mac makes for one attachment of one comment. The Mac answers it only while that comment’s Task isn’t archived and the attachment is still on the comment (an attachment, or a design review screenshot); otherwise `gone`. A phone can’t name any other file.
- The Mac shrinks the image to at most 1170 pixels wide (never wider than the original) and converts it to JPEG with macOS `sips`, keeping the result in its cache by attachment hash. An image `sips` can’t convert gets `refused` with “This image can’t be shown on your phone. Open it on your Mac.”, and the phone shows that in place of the image.
- `data` is base64url of the JPEG’s bytes from `part × 28,000` to the next 28,000, `parts` the number of parts and `part` the one sent. A `part` at or past `parts` gets `bad-request`. Each part decodes on its own (28,000 isn’t a multiple of 3, so the texts can’t be joined as they are). The phone asks for parts in order, joins the decoded bytes and keeps the image in memory until the app closes.

## Task actions

Seven routes change a Task. Each runs the same Tasks module code as the Mac’s button, as the user, so the Mac’s own rules decide: when the daemon refuses, the phone gets `refused` with the daemon’s sentence, through `redactSecrets`. Every route takes `taskId`, a display ID (`TED-788`) or full ID of 1 to 200 characters. An unknown or archived Task gets `gone`, and a missing or wrong field gets `bad-request`. The protocol number doesn’t change: a Mac without these routes answers `unknown-route`. Nothing on the Mac turns them off; pairing the phone is the gate.

| Route | Fields | Does |
| - | - | - |
| `task-start` | `taskId` | Start, as the Mac’s Start: the Task leaves Backlog and joins the queue. The Mac’s Factory setup reminder before a Start isn’t shown. |
| `task-stop` | `taskId` | Stop Task. Refused when the Task hasn’t started, is Done or is already stopped. |
| `task-resume` | `taskId`, optional `text` | Resume (or Retry, for a failed Task). `text` is at most 10,000 characters and is posted as the user’s comment first when it isn’t blank. Refused when the Task isn’t stopped or failed. |
| `task-priority` | `taskId`, `priority` | Sets `urgent`, `high`, `medium`, `low` or `none`. |
| `task-comment` | `taskId`, `text` | Posts `text` (1 to 10,000 characters, not only spaces) as the user’s comment, text only. Refused while Ted is merging the Task’s pull requests. |
| `task-archive` | `taskId`, `hierarchyRevision`, `closePullRequests`, optional `children` | Archive. `closePullRequests` (`true` or `false`, always sent) closes the Task’s open pull requests on GitHub. `children` is `archive` (the child Tasks too, also when left out) or `detach` (archive only this Task; its direct children lose their parent). |
| `task-delete` | `taskId`, `hierarchyRevision`, optional `children` | Delete. `children` is `delete` (the child Tasks and theirs too) or `unparent` (delete only this Task; its direct children lose their parent). With child Tasks and no `children`, it is refused. |

The phone sends back the `hierarchyRevision` it read with the Task. When it no longer matches, the daemon refuses with “TED-788 or its child Tasks changed since your phone read it. Open it again and choose again.”, and the phone reads the Task again and asks again. This plays the part of the Mac’s hierarchy revision check, which the Mac’s dialogs keep current as Tasks change; the Mac’s revision covers every Task in the Factory and would go stale on the phone whenever any of them changed, so the phone’s covers the same fields for this Task’s family only. When the phone’s revision matches, the daemon passes the Mac’s current revision to the Tasks module in the same step, so the Mac’s own checks (for example a child Task being set up or deleted at that moment) still apply.

A comment, or Resume text, from the phone is the user’s, but never sends the Task’s line comment drafts made on the Mac, because they can’t be seen on the phone. The daemon’s HTTP routes, the Mac’s own buttons and the tokens that may call them don’t change.

## New Task

Two routes let the phone create a Task. The protocol number doesn’t change: a Mac without them answers `unknown-route`. Nothing on the Mac turns them off; pairing the phone is the gate.

### `factories`

Lists every Factory the Mac’s New Task dialog offers, in the sidebar’s order:

```json
{ "factories": [{ "key": "NB", "name": "Notebook", "icon": { "kind": "letter", "color": "blue" }, "defaultPriority": "none" }] }
```

`icon` has the same shape as a Task row’s Factory icon and is left out when the Factory has none. `name` goes through `redactSecrets` and is cut to 200 characters. The list stops before the Factory that would take the reply past `phoneReplyBodyMax` (40,000 bytes of JSON). `defaultPriority` is the priority the phone’s form starts at; Factories have no priority setting, so it is always `none`, the Mac dialog’s starting value. Nothing else about a Factory is sent.

### `task-create`

| Field | Rules |
| - | - |
| `createId` | 16 random bytes in base64url, made once per New Task the user sends and reused on every resend of it. |
| `factory` | The Factory’s `key`, 1 to 200 characters. |
| `title` | At most 500 characters. Missing, or only spaces, is `refused` with “A Task needs a title.” Spaces at either end are trimmed. |
| `description` | Optional, at most 10,000 characters; empty when left out. |
| `priority` | Optional `urgent`, `high`, `medium`, `low` or `none`; `none` when left out. |
| `start` | `true` or `false`, always sent: Start now. |

A wrong type, a value past its limit or a bad `createId` gets `bad-request`. No other field is read: the Task Lead and Clarify depth are the Factory’s Task defaults, the same values the Mac’s New Task dialog starts with (the Workflow’s Clarify depth, and its lead adjusted for installed, enabled and paused agents), and there are no blockers, parent or files. An unknown `factory` is `refused` with “no Factory with key <key>”.

The daemon creates the Task with the same Tasks module call as the Mac’s New Task dialog, as the user (`createdBy` is `human`), in Backlog. When the daemon refuses, for example an unknown Factory, the phone gets `refused` with the daemon’s sentence, through `redactSecrets`, and nothing is created. With `start` on, the daemon then starts the Task with the same call as the Mac’s Start button; if that start is refused, the Task stays in Backlog and the reply carries `startRefused` with the daemon’s sentence, through `redactSecrets`, cut to 500 characters. With `start` off, the Task stays in Backlog.

**Sending twice.** When a reply is lost, the phone sends the same `task-create` again as a new message (new `id`, nonce and `at`, because the daemon drops a repeated nonce and any `at` more than 120 seconds off) with the same `createId`. The daemon records `v1.PhoneTaskCreated` under the phone and `createId` in the same store commit that creates the Task, and waits for it to reach disk before it starts the Task or answers, so a resend, even after the Mac restarts, gets the first Task as it is now and creates nothing, whatever the other fields say. Two sends with the same `createId` at once share one create. A resend for a Task since deleted or archived gets `gone`. A refused create records nothing, so the phone may send it again. The `createId` belongs to one phone: the same value from another phone is a different Task.

## Chats

Four read-only routes show the Mac’s agent chats: Coordinator chats, planning chats and chats with Agents a Factory defines, the same chats the Mac’s Agents screens show, from every Factory. Nothing a phone sends through them changes anything on the Mac, and chat requests can’t be answered through them. Every text goes through `redactSecrets` first, and every reply’s JSON body stays under `phoneReplyBodyMax` (40,000 bytes). The protocol number doesn’t change: a Mac without these routes answers `unknown-route`, and the phone’s Chats tab then says “Update Ted on your Mac to use Chats.”

A chat is named by `chatKind` and `chatId`: `coordinator` with the Coordinator chat’s ID (Coordinator chats and chats with a Factory’s own Agents), or `plan` with the planning chat’s ID.

### `chats`

Chats newest activity first: by `lastAt`, then kind, then ID. With `archived` left out or `false`, open chats only; with `archived` `true`, archived chats only (a Coordinator chat with `endedAt`, a planning chat with `archivedAt`). `factoryId` limits the list to one Factory; an unknown `factoryId` gives an empty list. A **chat row**:

```json
{
  "kind": "coordinator",
  "id": "<chat ID>",
  "title": "Clean up the stale Validate failures",
  "agent": "Coordinator",
  "factory": { "id": "<Factory ID>", "name": "Ted", "icon": { "kind": "emoji", "emoji": "🛠️" } },
  "status": "Working",
  "tone": "working",
  "waiting": false,
  "archived": false,
  "lastAt": "2026-11-20T09:00:00.000Z"
}
```

- `title` is the Mac’s chat title, else “<Agent> chat”, cut to 500 characters. `agent` is the chat’s Agent name, and the Factory name and `status` are cut to 200. `icon` has the same shape as a Task row’s Factory icon and is left out when the Factory has none or an image icon.
- `status` uses the Mac’s Agents screen wording. Coordinator chats: Waiting on you (when `waiting`), Ready, Queued, Working, Paused, Failed. Planning chats: Waiting on you, Working, Idle, Queued (or “Queued · 3rd”), “Paused · <reason>” (“Paused · usage limit” without one), Failed, Finished, Stopped. An archived chat is “Archived”.
- `tone` is `working` (working, queued), `waiting` (waiting on you, paused), `failed`, `stopped` (stopped, archived), `done` (finished) or `none` (ready, idle).
- `waiting` is `true` when the chat has an open request for the user, as the Mac’s Waiting chip: an unanswered question, round, proposal, Agent draft, outside command, confirmation or automation card in a Coordinator chat, or a planning chat waiting on the user or with an open request. It is always `false` for an archived chat.

`factories` lists `{"id":"<Factory ID>","name":"Ted","icon":<icon>}` for every Factory that has at least one chat, open or archived, in the sidebar’s order, on every page, so the phone can offer its Factory filter. `factories` never takes more than half of `phoneReplyBodyMax`, so at least one row always fits: when it would, the Mac cuts every name to 100 characters, then 50, then 20, then none, and as a last resort sends only the Factories that fit, with empty names and no icons. `archivedCount` counts the archived chats the same `factoryId` would list, on every page.

**Paging.** As `tasks`: a page holds as many rows as fit; `cursor` holds the last row’s place (`lastAt`, kind, ID) and is sent back with the same `factoryId` and `archived` for the next page. A bad cursor, or one made for another route, gets `bad-request`. A chat that moves between pages may be skipped or show twice; the phone replaces a row it already holds.

### `chat`

One chat’s row, to draw the chat screen’s header and refresh it. An unknown chat gets `gone`.

### `chat-items`

The chat’s conversation as the Mac draws it, oldest to newest: the Run chat’s items for every Run of the chat, merged by time with, for a Coordinator chat, its Task action results, requests, confirmation cards and automation cards, and, for a planning chat, its rounds, proposals, notes and the final “Planning Run finished”, “failed” or “stopped” line. The instructions Ted sends the agent are left out (the Mac shows them collapsed).

Without `before`, the reply holds the newest items that fit, ending with the newest item. With `before`, it holds the items that fit just before the item that cursor names. `cursor` is set when older items are left; the phone sends it back as `before`. A cursor holds the chat kind and an item ID, not a time, because several item kinds have no time; a cursor made for the other chat kind gets `bad-request`. A cursor whose item is no longer in the chat gets `gone`, and the phone starts again from the newest page.

A **chat item** has `id`, `kind` and, when the Mac knows it, `at` (ISO time), plus:

| `kind` | Fields |
| - | - |
| `human` | `text` (Markdown), `cut`, `images` (the names of image attachments), `files` (the number of other attachments), and `unsent: true` when the Mac shows the message as Not sent. |
| `agent` | `text` (Markdown), `cut`. `agent` is the Agent’s name. |
| `ted` | `title`, `text`, `cut`: a message from Ted, such as “New Run”, the opening prompt when the Mac shows it as a Prompt, or a planning chat’s final line. |
| `interrupted` | Nothing more. |
| `tool` | `tool` (such as `Bash` or `Edit`), `title`, `status` (`running`, `done`, `failed` or `stopped`), `additions` and `deletions` (diff line counts, when it has diffs), `lines` (output line count, when it has output) and `detail: true` when it has detail, diffs or output to open. |
| `command` | `name`, `status` (`running`, `passed`, `failed` or `stopped`), `exitCode` when known, `lines` (output line count, 0 when none), `detail: true` when it has output. |
| `action` | `text`, the Task action result as the Mac’s line says it, and `taskRef` (such as `TED-788`) when it names a Task. |
| `request` | `requestKind` (Question, Round, Proposal, Agent draft, Outside command, Note), `title` (the request’s title, else a label such as “Round 2” or “Proposal · 3 Tasks”), `text` (Markdown: the request’s body, then its choices, each round question with its choices and recommended answer, each proposed Task with its priority, scope and the rows it waits for, an Agent draft’s name, powers and instructions, or an outside command line and its folder), `cut`, `open`. Shown read-only; an open one says to answer on the Mac. |
| `card` | `text`: a confirmation card, automation card or permission request as one line, and `open`. |

`text` is cut at 4,000 characters, and further only when a single item would not fit the reply; `cut` is then `true`, and `chat-item` returns the whole text. Tool titles and command names are cut to 200 characters.

The phone refreshes an open chat by asking again without `before` and replacing items by `id`, so an item that changed, such as a tool call going from running to done, is updated in place. If the new page shares no item with what the phone shows, the phone drops what it had and starts from that page.

### `chat-item`

One item’s whole content, in pieces, for the phone’s detail screen: a tool call’s detail, diffs and output; a command’s output; or the whole text of an item whose `text` was cut. The content is a list of **detail lines**:

```json
{ "kind": "added", "text": "+     timeout: 600" }
```

`kind` is `heading` (a section such as Detail, Output or a file path with its counts, as in `src/a.ts +3 −1`), `text`, `added`, `removed` or `context` (diff lines, starting with `+`, `-` or a space). A diff the Mac cut short ends with the text line “Longer than shown”. A line longer than 2,000 characters is split into several lines of the same kind. `offset` is the index of the first line to send, 0 when left out; the reply holds as many lines as fit from there, and `next` is the index to ask for next, left out after the last line. An item with nothing to open returns no lines. A Mac keeps a tool call’s output to 8,000 characters, its diffs to 400 lines per file and a command’s output to its last 4 KB, so the phone shows what the Mac shows.

## Pairing

1. The app asks the daemon for a pairing link. The daemon makes a pairing ID and secret, keeps them in memory, connects to the relay if it isn’t already, and sends `pairing` with the ticket hash. It returns the link only after `pairing-ok`; with no answer in 5 seconds the app says Ted can’t reach the relay. A new link cancels the previous one.
2. The phone makes its box and relay key pairs, works out the ticket, opens a `pairing` socket, and sends `pair`.
3. The daemon checks the pairing ID, expiry and secret (constant-time), then the edition and protocol, then `relayProof`, and that no paired phone already has that relay key. A correct secret uses up the pairing, whatever happens next. The daemon remembers the phone’s keys and name, sends `pairing-candidate` for the phone’s relay key, and works out the short code. From then on it answers only `pair-status` from that phone until the pairing ends.
4. Both screens show the **short code**: the first 4 bytes of `SHA-256(macKey ‖ phoneKey ‖ secret)` as a big-endian unsigned integer, modulo 1,000,000, zero-padded to six digits, shown as `482 913`.
5. The user chooses Approve or Refuse on the Mac. Only the Ted app can. Approve records `v2.PhonePaired` with the relay key and sends the new phone list; the phone sees `approved` on its next `pair-status` only after `phones-ok`. The phone then reconnects in `phone` mode.

The daemon sends `pairing-end` right after it answers a `pair-status` with `approved`, `refused` or `expired`; two minutes after the pairing is approved, refused or expires; and at once when the link is cancelled or replaced before a phone used it.

## Paired phones

The daemon answers a paired phone only on routes marked for phones: `status`, `requests`, `request`, `answer`, `push-token`, `problems`, `tasks`, `task`, `task-comments`, `task-start`, `task-stop`, `task-resume`, `task-priority`, `task-comment`, `task-archive`, `task-delete`, `factories`, `task-create`, `chats`, `chat`, `chat-items` and `chat-item`. Removing a phone on the Mac records `v1.PhoneRemoved` and sends the new list; the relay then refuses that phone. A message that still reaches the daemon from a removed key gets `not-paired`. Unpairing on the phone clears only the phone; the Mac lists it until the user removes it there. Phones paired before protocol 3 have no relay key, so they aren’t on the relay’s list and must pair again.

The daemon keeps its relay socket open while a pairing link is live, for two minutes after it ends (so a waiting phone hears it was refused or expired), and from the first phone ever paired on, even after every phone is removed (so the relay’s list stays current). It reconnects with backoff (1, 2, 5, 10, 30 seconds).

If the relay answers `phones-stale` or `phones-conflict`, Ted’s data was restored from an older copy and its phone list may include phones the user later removed. The daemon then disconnects, removes every phone and records `v1.PhoneRelayReset` with the old channel, makes a new Mac relay key (so a new channel), and Settings → Phones says “Pair your phones again.” If the key change didn’t happen (a crash, or a Keychain error), the daemon makes the new key before the next pairing, because the latest reset still names the current channel. No phone can reach the old channel’s Mac again.
