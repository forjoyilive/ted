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

### Mac → phone

`{"type":"reply","ok":true,"body":{…}}` or `{"type":"reply","ok":false,"error":{"code":"<code>","message":"<plain sentence>"}}`, plus the common fields.

- `pair` → `{"state":"waiting","code":"482913"}`.
- `pair-status` → `{"state":"waiting"}`, `{"state":"approved","mac":"Studio Mac"}`, `{"state":"refused"}` or `{"state":"expired"}`.
- `status` → `{"mac":"Studio Mac","edition":"dev","version":"1.4.0","protocol":3}`.
- `requests` → `{"requests":[<summary>, …],"more":0}`.
- `request` → `{"request":<detail>}`.
- `answer` → `{"answered":true}`.
- `push-token` → `{}`.
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
| `gone` | The request was answered, withdrawn or superseded elsewhere, or its Task, plan or Automation is gone. The phone says so and drops it from the list. |
| `answer-on-mac` | The phone may not answer this request. The daemon refuses it whatever the phone sends. |
| `refused` | Ted’s own answer code refused the answer (for example a choice that isn’t offered). `message` is the daemon’s sentence. |

A phone that gets a reply with a `protocol` above its own says “Update the Ted app on your phone.”

## Inbox requests

Protocol 2 adds three routes. They show the open requests the desktop Inbox shows and answer some of them. A phone gets nothing else: no settings, Factories, Runs, Comments outside an answer, or Task changes.

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
  "form": { "type": "choices", "choices": ["Yes", "No"], "multiple": false, "text": true }
}
```

- `body`: the request’s text as Markdown. `cut` is `true` when the daemon shortened it to fit; the phone then shows “The rest is on your Mac”. Images in the Markdown and `attachments` (a count) show as “Open on your Mac”.
- `form` is one of:
  - `{"type":"choices","choices":[…],"multiple":false,"text":true}`: pick one choice (or several with `multiple`), and when `text` is `true`, optionally add text.
  - `{"type":"text"}`: free text only.
  - `{"type":"round","questions":[{"question":"…","choices":["…"],"multiple":false,"recommended":"…","recommendedChoices":["…"]}]}`: a question round; `choices`, `multiple` and `recommendedChoices` are optional.
  - `{"type":"permission","command":"<full command>","cut":false}`: allow or deny.
  - `{"type":"signoff","stage":"Design","brief":"<Markdown>","cut":false}`: the Task brief, then approve or request changes with text. The user approves without seeing the diff.
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

## Pairing

1. The app asks the daemon for a pairing link. The daemon makes a pairing ID and secret, keeps them in memory, connects to the relay if it isn’t already, and sends `pairing` with the ticket hash. It returns the link only after `pairing-ok`; with no answer in 5 seconds the app says Ted can’t reach the relay. A new link cancels the previous one.
2. The phone makes its box and relay key pairs, works out the ticket, opens a `pairing` socket, and sends `pair`.
3. The daemon checks the pairing ID, expiry and secret (constant-time), then the edition and protocol, then `relayProof`, and that no paired phone already has that relay key. A correct secret uses up the pairing, whatever happens next. The daemon remembers the phone’s keys and name, sends `pairing-candidate` for the phone’s relay key, and works out the short code. From then on it answers only `pair-status` from that phone until the pairing ends.
4. Both screens show the **short code**: the first 4 bytes of `SHA-256(macKey ‖ phoneKey ‖ secret)` as a big-endian unsigned integer, modulo 1,000,000, zero-padded to six digits, shown as `482 913`.
5. The user chooses Approve or Refuse on the Mac. Only the Ted app can. Approve records `v2.PhonePaired` with the relay key and sends the new phone list; the phone sees `approved` on its next `pair-status` only after `phones-ok`. The phone then reconnects in `phone` mode.

The daemon sends `pairing-end` right after it answers a `pair-status` with `approved`, `refused` or `expired`; two minutes after the pairing is approved, refused or expires; and at once when the link is cancelled or replaced before a phone used it.

## Paired phones

The daemon answers a paired phone only on routes marked for phones: `status`, `requests`, `request`, `answer`, `push-token` and `problems`. Removing a phone on the Mac records `v1.PhoneRemoved` and sends the new list; the relay then refuses that phone. A message that still reaches the daemon from a removed key gets `not-paired`. Unpairing on the phone clears only the phone; the Mac lists it until the user removes it there. Phones paired before protocol 3 have no relay key, so they aren’t on the relay’s list and must pair again.

The daemon keeps its relay socket open while a pairing link is live, for two minutes after it ends (so a waiting phone hears it was refused or expired), and from the first phone ever paired on, even after every phone is removed (so the relay’s list stays current). It reconnects with backoff (1, 2, 5, 10, 30 seconds).

If the relay answers `phones-stale` or `phones-conflict`, Ted’s data was restored from an older copy and its phone list may include phones the user later removed. The daemon then disconnects, removes every phone and records `v1.PhoneRelayReset` with the old channel, makes a new Mac relay key (so a new channel), and Settings → Phones says “Pair your phones again.” If the key change didn’t happen (a crash, or a Keychain error), the daemon makes the new key before the next pairing, because the latest reset still names the current channel. No phone can reach the old channel’s Mac again.
