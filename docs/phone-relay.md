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
| Pairing secret | 32 random bytes | Daemon memory only, and the QR code. Never written to disk or logs. |

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

`edition` is `release` (Ted) or `dev` (Ted Dev). `relay` is an `http:` or `https:` URL (in the daemon: `defaultRelayUrl` in `packages/protocol/src/phones.ts` for Ted, a placeholder `https://ted-relay.invalid` until the relay is deployed; `http://127.0.0.1:8787` for Ted Dev, or `TED_RELAY_URL`); clients use `ws:` or `wss:` on the same host. `expiresAt` is milliseconds since the epoch, five minutes after the link was made. A phone refuses a link with an unknown `v`, a different edition from its own variant, or a past `expiresAt`. The Simulator has no camera, so the phone app also accepts the same link pasted as text.

## Relay

Routes:

- `GET /health` answers `{"ok":true}`.
- `GET /v1/mac/<channel>`: WebSocket for the daemon.
- `GET /v1/phone/<channel>`: WebSocket for a phone.

Everything else is 404. One Durable Object per channel holds the sockets. The relay never parses `data`.

### Mac socket

1. Relay → Mac: `{"t":"challenge","nonce":"<32 random bytes>"}`.
2. Mac → relay: `{"t":"login","key":"<Mac relay public key>","sig":"<Ed25519 signature>"}`, signing the UTF-8 bytes of `ted-relay-login:v1:<channel>:<nonce>`.
3. The relay checks `SHA-256(key) == channel` and the signature (WebCrypto Ed25519). Good: `{"t":"ready"}`, and every phone socket on the channel gets `{"t":"mac-online"}`. Bad, or no login within 10 seconds: close with code 4401.

A new logged-in Mac socket replaces the old one, which is closed with code 4409. When the Mac socket closes, every phone socket gets `{"t":"mac-offline"}`.

After login:

- Relay → Mac: `{"t":"msg","conn":<number>,"data":"<envelope>"}` for each phone frame, where `conn` numbers phone sockets on this channel. `{"t":"closed","conn":<number>}` when a phone socket closes.
- Mac → relay: `{"t":"msg","conn":<number>,"data":"<envelope>"}`. The relay sends `{"t":"msg","data":"<envelope>"}` to that phone socket, or drops it if that socket is gone.

### Phone socket

On open the relay sends `{"t":"mac-online"}` or `{"t":"mac-offline"}`.

- Phone → relay: `{"t":"msg","data":"<envelope>"}`. With the Mac online the relay forwards it; otherwise it answers `{"t":"mac-offline"}`.
- Relay → phone: `{"t":"msg","data":"<envelope>"}`, `{"t":"mac-online"}`, `{"t":"mac-offline"}`.

### Limits

A frame over 65,536 bytes, a frame that isn’t JSON of the shapes above, or `data` that isn’t a string closes the socket with code 4400. At most 16 phone sockets per channel; the 17th is closed with code 4429.

## Envelope

The `data` string is JSON:

```json
{ "v": 1, "from": "<sender box public key>", "nonce": "<24 random bytes>", "box": "<nacl.box ciphertext>" }
```

`box = nacl.box(utf8(JSON.stringify(message)), nonce, recipientPublicKey, senderSecretKey)`. The envelope format stays at `v: 1`; changes to messages go through `protocol` below. A receiver drops an envelope it can’t parse or open, without answering.

## Messages

Every message inside a box has:

```json
{ "protocol": 1, "id": "<16 random bytes>", "at": 1795135669031, "type": "…" }
```

`at` is the sender’s clock in milliseconds. The daemon drops a message whose `at` is more than 120 seconds from its own clock, or whose envelope `nonce` it has already seen from that sender in the last 120 seconds. A reply carries the request’s `id`; the phone ignores a reply whose `id` it isn’t waiting for.

### Phone → Mac

- `{"type":"pair","pairing":"<pairing ID>","secret":"<secret>","name":"iPhone 16","edition":"dev"}` sent from the phone’s new box key.
- `{"type":"pair-status","pairing":"<pairing ID>"}` from the same key, polled every 2 seconds while waiting.
- `{"type":"request","route":"status"}` from a paired phone’s key.

### Mac → phone

`{"type":"reply","ok":true,"body":{…}}` or `{"type":"reply","ok":false,"error":{"code":"<code>","message":"<plain sentence>"}}`, plus the common fields.

- `pair` → `{"state":"waiting","code":"482913"}`.
- `pair-status` → `{"state":"waiting"}`, `{"state":"approved","mac":"Studio Mac"}`, `{"state":"refused"}` or `{"state":"expired"}`.
- `status` → `{"mac":"Studio Mac","edition":"dev","version":"1.4.0","protocol":1}`.

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

A phone that gets a reply with a `protocol` above its own says “Update the Ted app on your phone.”

## Pairing

1. The app asks the daemon for a pairing link. The daemon makes a pairing ID and secret, keeps them in memory, and connects to the relay if it isn’t already. A new link cancels the previous one.
2. The phone makes its box key pair, opens the phone socket, and sends `pair`.
3. The daemon checks the pairing ID, expiry and secret (constant-time), then the edition and protocol. A correct secret uses up the pairing, whatever happens next. The daemon remembers the phone’s key and name and works out the short code.
4. Both screens show the **short code**: the first 4 bytes of `SHA-256(macKey ‖ phoneKey ‖ secret)` as a big-endian unsigned integer, modulo 1,000,000, zero-padded to six digits, shown as `482 913`.
5. The user chooses Approve or Refuse on the Mac. Only the Ted app can. Approve records `v1.PhonePaired`; the phone sees `approved` on its next `pair-status`.

## Paired phones

The daemon answers a paired phone only on routes marked for phones. In this version that is `status`. Removing a phone on the Mac records `v1.PhoneRemoved`; its next message gets `not-paired`. Unpairing on the phone clears only the phone; the Mac lists it until the user removes it there.

The daemon keeps its relay socket open while a pairing link is live, for two minutes after it ends (so a waiting phone hears it was refused or expired), and from the first phone ever paired on, even after every phone is removed (so a removed phone always gets `not-paired`, not `mac-offline`). It reconnects with backoff (1, 2, 5, 10, 30 seconds).
