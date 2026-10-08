# dsh-plugin-clawchat

Make DeepSeek Harness a first-class agent on ClawChat — **holding the connection
itself, with no ClawChat desktop app required**.

Install it, and dsh connects on startup. You message it in ClawChat, and it
answers with one headless dsh turn.

```
ClawChat server
   │  WebSocket  (held by this plugin)
   ▼
the clawchat plugin inside the dsh process
   │  for each message from you
   ▼
spawn one headless turn  (default: dsh --profile headless)
   │  stdout = the reply
   ▼
send it back to the same conversation
```

## Why this exists

The official path for dsh on ClawChat is **desktop-held**: the ClawChat desktop
app owns the WebSocket and dsh only produces the turns. That works, but it
comes with two constraints:

- **you are offline whenever the app is closed**, and messages sent while
  offline are never queued;
- the app and dsh have to stay in the pairing it arranged.

This plugin takes the **self-held** path instead (the wiki calls it the DIY
lane): dsh holds the connection. The app does not have to be installed at all.

## Install

```bash
cd ~/.dsh/profiles/<your-profile>
pnpm add dsh-plugin-clawchat
# or from a local path: pnpm add /path/to/dsh-plugin-clawchat
```

Then add the plugin to that profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-clawchat"
      ]
    }
  }
}
```

Restart dsh.

> The `desktop` profile is managed exclusively by the DSH Desktop app, and
> `dsh plugin --profile desktop` is refused. Install into a different profile,
> or edit that profile's `package.json` by hand.

## Pairing

You need a connect code for the first run (generate one from **Add Agent** in
the ClawChat app):

```yaml
- id: clawchat
  config:
    connectCode: 'XXXXXXXX'
```

**Remove it once pairing succeeds.** The code is single-use; leaving it in
place only invites a second redemption — and therefore a duplicate agent in
your contacts — if the state file is ever cleared.

The `X-Device-Id` used at pairing is recorded by the server, and **every** REST
call afterwards must send it byte-for-byte. If this identity was originally
paired by the ClawChat desktop app, you must set the value it used:

```yaml
    restDeviceId: 'clawchat-desktop-local-agents'
```

Otherwise token refresh returns `10003` — which is the *same code and the same
sentence* as a revoked credential, so the client concludes it must re-pair.
This one is expensive; see "Known pitfalls" below.

## Configuration

Put overrides in **your own profile's** `cordis.patch.yml`, keyed by id — do
not edit the plugin's bundled copy:

```yaml
- id: clawchat
  config:
    # identity state (contains tokens — treat as a secret)
    stateFile: '~/.clawchat/state.json'

    # single-holder lock
    lockFile: '~/.clawchat/holder.lock'
    takeover: false

    channel: 'dsh-clawchat'
    restDeviceId: ''

    # the command that runs one turn: prompt in, reply out
    command: 'dsh'
    args: ['--profile', 'headless']
    cwd: ''
    turnTimeoutMs: 600000

    greeting: "Hello — I'm online."

    # rolling transcript (see below)
    historyMaxTurns: 12
    historyMaxChars: 6000

    logFile: '~/.clawchat/channel.log'
```

| Field | Meaning |
|---|---|
| `stateFile` | tokens + WS device id. **Treat as a secret** |
| `lockFile` | single-holder lock; every holder on this machine must share this path |
| `takeover` | `true` = connect even if another holder owns the lock. Causes 4001 eviction |
| `channel` | channel name; feeds the WS device id derivation, so changing it looks like a new device |
| `restDeviceId` | the REST constant, **must match pairing** (above) |
| `command` / `args` / `cwd` | the turn command. Prefer **absolute paths** — a GUI-launched process has a minimal PATH |
| `turnTimeoutMs` | per-turn timeout; on expiry the process is SIGKILLed and whatever it printed is sent |
| `greeting` | sent once after the first successful pairing; empty string = stay silent |
| `historyMaxTurns` | how many turns of transcript to keep; `0` disables it |

### Not tied to dsh

`command` is not dsh-specific. Any CLI with a non-interactive mode works:

```yaml
    command: 'claude'
    args: ['-p']
```

```yaml
    command: 'codex'
    args: ['exec']
```

## Two behaviours you must know

### 1. One identity, one holder

A ClawChat identity admits exactly one live connection. Two holders do **not**
share it: the server closes one with code `4001`, the loser reconnects on its
backoff and takes the identity back, and the two trade it forever. **It does
not settle on its own.**

So the plugin takes a lock file at startup:

- lock acquired → connect normally;
- lock held by a live process (a resident bridge under launchd, another dsh
  instance, a leftover copy of this plugin) → **stand by, do not connect**, and
  log who holds it.

That is what makes "plugin and resident bridge coexist" work: first one in
wins, nobody evicts anybody. Set `takeover: true` to override and take the
identity anyway.

Liveness is decided by **whether the pid is alive**, not by a timestamp — a
holder killed with `SIGKILL` leaves the file behind, and a stale-by-time lock
would block a healthy successor for a full timeout, while a stale-by-pid lock
is reclaimed immediately.

### 2. The shipped headless profile cannot resume a session

`dsh --profile headless` answers one task and exits, and it **does not support
`--resume`** (measured: `unknown option '--resume'`). Left alone, every turn is
a brand-new session: the agent tells you it cannot see the earlier
conversation, and each turn re-explores from nothing (measured: one turn took
140 seconds).

So the plugin keeps a **rolling transcript** on its side (`historyMaxTurns` /
`historyMaxChars`) and folds the recent exchanges into each prompt. Measured
working: a fact stated in turn 1 was recalled correctly in turn 2.

The cost is resending context every turn. If your runtime can resume its own
session (`claude -p --resume` and the like), put that in `args` and set
`historyMaxTurns: 0`.

## Known pitfalls

- **The REST device id must be byte-identical to the value used at pairing.**
  A mismatch makes refresh return `10003 invalid refresh token` — the same code
  and the same sentence as a revoked credential. The server makes the two
  **deliberately indistinguishable**, so it cannot be diagnosed from the
  response; only the rule helps. Measured: an invalid token sent under a
  correct and an incorrect device id returns an identical response.
- **Node must be ≥ 22.18.0.** Lower versions (22.4.0 included) leave
  `import.meta.main` undefined and dsh **exits 0 having printed nothing** — a
  silent failure. The plugin itself needs only 22+, but the default `dsh`
  command carries the harder floor.
- **Never recompute the WS device id.** Keep the value the server echoed into
  the state file. An id built from a random suffix, a timestamp or a pid makes
  every reconnect look like a new device: the server replays your whole offline
  inbox, and every id you have ever sent keeps a server-side cursor that holds
  back cleanup.
- **`fetch` retains inbound messages only.** An empty read does not mean your
  own outbound messages failed.
- **The greeting is sent once**, and the flag is written only after the
  `message.ack` **arrives** — setting it at send time turns one network blip
  into permanent silence.
- **Reasoning goes to stderr.** dsh streams its reasoning trace there, tens of
  kilobytes per turn. That is diagnostics, not an error; the log keeps the
  first 600 characters.

## Testing

```bash
npm install
npm test
```

49 offline tests — no network, no credentials, no dsh process — covering the
places where being wrong is **silent**: the nine-step inbound filter chain, the
routing order (`permission_result` must precede the chain and lives only in
`payload.metadata`), reconnect backoff (the takeover floor is exactly
`[5,10,20,40,80,160,320,600,600]`), `hello-fail` classification (only
`authentication failed` is terminal), fragment splitting, the single-holder
lock, and turn serialization.

`npm run check` does a syntax check.

## Protocol source

The ClawChat wire protocol comes from the **ClawChat Connection Wiki**
(`https://agent-connection.clawling.com`, snapshot `2026-10-08-bc1f98a`), which
states that its published reference implementations are **safe to copy from**.
The protocol layer here is an independent implementation written against it;
constants cite their chapter inline (`connect/03-handshake.md`, and so on).

This plugin is not affiliated with ClawChat.

## License

MIT
