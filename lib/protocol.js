/**
 * ClawChat agent-side channel — protocol layer.
 *
 * Node 22+ only, no dependencies: the global WebSocket (undici) and fetch are
 * enough for the whole protocol.
 *
 * This is the self-held lane: the process holding this client owns the
 * WebSocket, the tokens and the reconnect loop. There must be exactly ONE
 * holder per identity — two holders evict each other forever.
 *
 * Protocol source: the ClawChat connection wiki
 * (agent-connection.clawling.com), which publishes its reference client as
 * safe to copy from. Constants below cite chapter numbers from that wiki.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// ── Constants (connect/09-constants.md) ─────────────────────────────────────

export const REST_BASE = 'https://app.clawling.com';
export const WS_URL = 'wss://app.clawling.com/ws';

/** connect.payload.protocol_version is a NUMBER — the string "2" fails the frame. */
export const PROTOCOL_VERSION = 2;

/** An OBJECT of booleans — never an array; never advertise reliable_delivery_v2. */
export const CAPABILITIES = Object.freeze({
  multi_device: false,
  device_replay: true,
  chat_meta_events: true,
  notify_signals: true,
  permission_events: true,
});

export const HANDSHAKE_TIMEOUT_MS = 15000;
export const PING_INTERVAL_MS = 20000;   // 04-lifecycle.md
export const PONG_TIMEOUT_MS = 10000;    // measured from the ping's send time
export const ACK_TIMEOUT_MS = 15000;     // 05-messaging.md
export const COUNTER_RESET_WINDOW_MS = 5000;
export const TAKEOVER_FLOOR_BASE_S = 5;
export const TAKEOVER_FLOOR_CAP_S = 600;
export const DUPLICATE_SESSION_BACKSTOP_S = 600;
export const DUPLICATE_SESSION_DEFAULT_MS = 30000;
export const REFRESH_MIN_INTERVAL_MS = 30000;
export const REFRESH_CHECK_MS = 60000;
export const BEHAVIOR_FETCH_TIMEOUT_MS = 10000;
export const REST_TIMEOUT_MS = 15000;

/** A single text fragment is capped at 4000 characters (05-messaging.md). */
export const MAX_FRAGMENT_CHARS = 4000;

// ── Small utilities ─────────────────────────────────────────────────────────

let traceCounter = 0;

/** Counter-style trace ids — never UUIDs, and never an 8-character run. */
export function newTraceId(kind) {
  traceCounter += 1;
  return `cli-${kind}-${String(traceCounter).padStart(4, '0')}`;
}

/** Prefix plus the first six characters, for logs. Never log a whole id. */
export function shortId(id) {
  if (typeof id !== 'string') return id;
  const m = /^([a-z]{3}_)(.{6})/i.exec(id);
  return m ? `${m[1]}${m[2]}…` : id;
}

/** Decode a JWT's claims locally. Never verify the signature. */
export function decodeJwtClaims(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

const CONVERSATION_ID = /^cnv_[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isValidConversationId(id) {
  return typeof id === 'string' && CONVERSATION_ID.test(id);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── State ───────────────────────────────────────────────────────────────────

export function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Runtime-only fields live under `_` and must never reach disk: a timer handle
 * on a persisted object makes JSON.stringify throw on a circular structure.
 */
export function persistState(file, state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
}

/**
 * The WebSocket device id identifies this installation. Derive it once and
 * persist the value the server echoes back — recomputing it per connection
 * (or letting it contain a random suffix, timestamp or pid) makes every
 * reconnect look like a brand-new device, so the server replays the whole
 * inbox every time and every id you ever sent keeps a server-side cursor.
 */
export function deriveWsDeviceId(channel, state) {
  const parts = [channel, state.ownerId ?? '', state.ownUserId ?? '', os.hostname()];
  const digest = crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${channel}-${digest.slice(0, 24)}`;
}

// ── REST (connect/02-pairing.md) ────────────────────────────────────────────

/**
 * Every response is {code, msg, data}. `code === 0` is the only success
 * signal — never branch on the HTTP status.
 */
export async function rest(method, pathname, { token = '', body, deviceId, timeoutMs = REST_TIMEOUT_MS } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (deviceId) headers['x-device-id'] = deviceId;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(REST_BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let envelope;
  try {
    envelope = await res.json();
  } catch {
    throw new Error(`${method} ${pathname}: non-JSON response (HTTP ${res.status})`);
  }
  return { ...envelope, _http: res.status };
}

/** Redeem a connect code. Omit `userId` for a first pairing. */
export async function pair(code, { channel, deviceId, userId } = {}) {
  const body = { code, platform: channel, type: 'clawbot' };
  // With a stored identity, sending user_id re-pairs THAT agent. Without it,
  // the server mints a brand-new agent — the duplicate nobody is warned about.
  if (userId) body.user_id = userId;
  const r = await rest('POST', '/v1/agents/connect', { deviceId, body });
  if (r.code !== 0) throw new Error(`activation failed: code=${r.code} msg=${r.msg}`);
  return r.data;
}

/** Read the owner-written behavior prompt. Re-read on every connect. */
export async function fetchBehavior(state, deviceId) {
  const r = await rest('GET', `/v1/agents/${state.agentId}`, {
    token: state.accessToken, deviceId, timeoutMs: BEHAVIOR_FETCH_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    const err = new Error(`behavior fetch failed: code=${r.code} msg=${r.msg}`);
    err.http = r._http;
    throw err;
  }
  return r.data?.agent?.behavior ?? '';
}

// ── Reconnect policy (connect/04-lifecycle.md) ──────────────────────────────

/** min(15000, 500 × 2^(attempt-1)) plus up to 30% jitter. */
export function ordinaryBackoff(attempt) {
  const base = Math.min(15000, 500 * 2 ** (attempt - 1));
  return base + Math.random() * base * 0.3;
}

/** min(5s × 2^n, 600s) — there is no zero-delay first attempt. */
export function takeoverFloor(n) {
  return Math.min(TAKEOVER_FLOOR_BASE_S * 2 ** n, TAKEOVER_FLOOR_CAP_S) * 1000;
}

/** Mutates the two streak counters; returns the delay in ms. */
export function computeReconnectDelay(state, outcome) {
  if (outcome.kind === 'auth_terminal') {
    state.rePairingRequired = true;
    return 0;
  }
  if (outcome.kind === 'handshake_transient') {
    state.reconnectAttempt = (state.reconnectAttempt ?? 0) + 1;
    return ordinaryBackoff(state.reconnectAttempt);
  }
  if (outcome.kind === 'refresh_close') {
    state.reconnectAttempt = 0;
    state.takeoverStreak = 0;
    return 1000 + Math.random() * 300;
  }
  if (outcome.kind === 'socket_closed' && outcome.side === 'server' && outcome.code === 4001) {
    const n = state.takeoverStreak ?? 0;
    state.takeoverStreak = n + 1;
    return takeoverFloor(n);
  }
  if (outcome.kind === 'socket_closed' && outcome.side === 'server' && outcome.code === 4002) {
    state.takeoverStreak = 0;
    const hinted = outcome.retryAfterMs ?? DUPLICATE_SESSION_DEFAULT_MS;
    return Math.min(hinted, DUPLICATE_SESSION_BACKSTOP_S * 1000);
  }
  state.takeoverStreak = 0;
  state.reconnectAttempt = (state.reconnectAttempt ?? 0) + 1;
  return ordinaryBackoff(state.reconnectAttempt);
}

/**
 * Exact string match after trimming and lowercasing. Only
 * "authentication failed" is terminal; everything else is transient, and the
 * answer is to back off and retry with the SAME token.
 */
export function classifyHelloFail(reason) {
  return String(reason ?? '').trim().toLowerCase() === 'authentication failed'
    ? 'auth_terminal'
    : 'handshake_transient';
}

/** A server 4002 may carry {"retry_after_ms": n} in its close reason. */
export function parseCloseReason(reason) {
  try {
    const j = JSON.parse(reason);
    if (j && Number.isFinite(j.retry_after_ms)) return { retryAfterMs: j.retry_after_ms };
  } catch { /* an ordinary reason string */ }
  return {};
}

// ── Token refresh (connect/04-lifecycle.md) ─────────────────────────────────

/** exp − max(30min, min(2h, 25% of lifetime)) ± 5min jitter, in epoch ms. */
export function refreshAtFromClaims(claims, activatedAtS) {
  const exp = Number(claims?.exp);
  const iat = Number(claims?.iat);
  if (Number.isFinite(exp) && exp > 0) {
    const lifetime = Number.isFinite(iat) ? exp - iat : 0;
    const lead = Math.max(30 * 60, Math.min(2 * 3600, 0.25 * lifetime));
    const jitter = Math.random() * 600 - 300;
    return (exp - lead + jitter) * 1000;
  }
  return ((activatedAtS ?? 0) + 24 * 3600) * 1000;
}

// ── Inbound filter chain (connect/05-messaging.md) ──────────────────────────

/**
 * The nine steps, in order. Fail-closed on an unknown own id: a guard that
 * fails open replies to its own messages and loops forever.
 * Step 8 (group mention gating) is deliberately not implemented here.
 */
export function passesInboundFilter(state, frame) {
  if (frame.event !== 'message.send' && frame.event !== 'message.reply') return { ok: false, step: 1 };
  if (!state.ownUserId) return { ok: false, step: 2 };
  if (!isValidConversationId(frame.chat_id)) return { ok: false, step: 3 };
  if (frame.sender?.id === 'system') return { ok: false, step: 4 };
  if (frame.sender?.id === state.ownUserId) return { ok: false, step: 5 };
  const mode = frame.payload?.message_mode ?? '';
  // "" and "normal" are the same value; anything else is rejected.
  if (mode !== 'normal' && mode !== '') return { ok: false, step: 6 };
  const fragments = frame.payload?.message?.body?.fragments;
  const text = Array.isArray(fragments)
    ? fragments.filter((f) => f && f.kind === 'text' && typeof f.text === 'string').map((f) => f.text).join('')
    : '';
  if (text.trim() === '') return { ok: false, step: 7 };
  return { ok: true, text };
}

/**
 * Split text into <=4000-character fragments, preferring paragraph, line and
 * sentence boundaries so a split never lands mid-construct.
 */
export function splitFragments(text, limit = MAX_FRAGMENT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    // Prefer a paragraph break, then a line break, then a sentence end, so a
    // split never lands inside an unterminated code fence or a mid-sentence run.
    const para = window.lastIndexOf('\n\n');
    if (para >= limit * 0.5) cut = para;
    if (cut < 0) {
      const line = window.lastIndexOf('\n');
      if (line >= limit * 0.5) cut = line + 1;
    }
    if (cut < 0) {
      const sentence = Math.max(window.lastIndexOf('。'), window.lastIndexOf('. '));
      if (sentence >= limit * 0.5) cut = sentence + 1;
    }
    if (cut < 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * One connection lifetime plus the reconnect loop. Everything host-specific
 * lives behind `onMessage`, which returns the reply text (or null for silence).
 */
export class ClawChatClient {
  /**
   * @param {object} opts
   * @param {string} opts.stateFile   where tokens and device id live
   * @param {string} opts.channel     channel name, stable for this implementation
   * @param {string} opts.restDeviceId constant for every REST call; MUST match pairing
   * @param {(text: string, frame: object, behavior: string) => Promise<string|null>} opts.onMessage
   * @param {(event: string, fields?: object) => void} [opts.log]
   * @param {(signal: object) => void} [opts.onPermissionResult]
   * @param {() => void} [opts.onBehaviorInvalidated]
   */
  constructor(opts) {
    if (!opts?.stateFile) throw new Error('stateFile is required');
    if (typeof opts.onMessage !== 'function') throw new Error('onMessage is required');
    this.stateFile = opts.stateFile;
    this.channel = opts.channel || 'clawchat-node';
    this.restDeviceId = opts.restDeviceId || this.channel;
    this.onMessage = opts.onMessage;
    this.log = opts.log || (() => {});
    this.onPermissionResult = opts.onPermissionResult || (() => {});
    this.onBehaviorInvalidated = opts.onBehaviorInvalidated || (() => {});

    this.state = loadState(this.stateFile);
    this.state.reconnectAttempt ??= 0;
    this.state.takeoverStreak ??= 0;
    this.state.lastRefreshAttemptAt ??= 0;
    this.state.greeted ??= false;
    this.state.activatedAt ??= 0;

    this._generation = 0;
    this._stopped = false;
    this._refreshTimer = null;
  }

  /** Redeem a connect code if no tokens are stored yet. */
  async ensurePaired(code) {
    if (this.state.accessToken && this.state.refreshToken) return false;
    if (!code) throw new Error(`no tokens in ${this.stateFile} and no connect code given`);
    const data = await pair(code, {
      channel: this.channel,
      deviceId: this.restDeviceId,
    });
    this.state.accessToken = data.access_token;
    this.state.refreshToken = data.refresh_token;
    this.state.agentId = data.agent?.id;
    this.state.conversationId = data.conversation?.id;
    this.state.activatedAt = Math.floor(Date.now() / 1000);
    this.state.greeted = false;
    persistState(this.stateFile, this.state);
    this.log('paired', { agent: shortId(this.state.agentId), conversation: shortId(this.state.conversationId) });
    return true;
  }

  /** Fill identity fields from the access token and persist the device id. */
  init() {
    const claims = decodeJwtClaims(this.state.accessToken);
    // The token's sub claim is the ONLY source of "who am I" — never a config value.
    this.state.ownUserId = claims.sub;
    this.state.agentId = claims.aid || this.state.agentId;
    this.state.ownerId = claims.oid;
    if (!this.state.wsDeviceId) this.state.wsDeviceId = deriveWsDeviceId(this.channel, this.state);
    if (!this.state.refreshAtMs) this.state.refreshAtMs = refreshAtFromClaims(claims, this.state.activatedAt);
    persistState(this.stateFile, this.state);
  }

  /** Run until stop(). Never rejects on a transport error — it reconnects. */
  async run() {
    this.init();
    this.log('client-start', {
      node: process.version,
      channel: this.channel,
      own: shortId(this.state.ownUserId),
      agent: shortId(this.state.agentId),
    });

    // A short periodic check, never one timer armed for refresh_at: Node clamps
    // a delay above 2^31-1 ms to 1 ms, which fires the refresh immediately.
    this._refreshTimer = setInterval(() => {
      if (Date.now() >= this.state.refreshAtMs) {
        this._refresh('timer').catch((e) => this.log('refresh-error', { error: e.message }));
      }
    }, REFRESH_CHECK_MS);
    this._refreshTimer.unref?.();

    while (!this._stopped) {
      if (Date.now() >= this.state.refreshAtMs) {
        await this._refresh('timer').catch((e) => this.log('refresh-error', { error: e.message }));
      }
      if (this.state.rePairingRequired) {
        this.log('re-pairing-required');
        return;
      }
      const outcome = await this._runOneConnection();
      if (this._stopped) return;
      const delay = computeReconnectDelay(this.state, outcome);
      this.log('close', {
        code: outcome.code,
        side: outcome.side ?? '',
        outcome: outcome.kind,
        delay_ms: Math.round(delay),
      });
      if (this.state.rePairingRequired) {
        this.log('re-pairing-required');
        return;
      }
      persistState(this.stateFile, this.state);
      await sleep(delay);
    }
  }

  stop() {
    this._stopped = true;
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    try { this._giveUp?.(1000, 'stopping'); } catch { /* not connected */ }
  }

  // ── one connection ────────────────────────────────────────────────────────

  async _runOneConnection() {
    const gen = ++this._generation;
    const live = () => gen === this._generation && !this._stopped;
    const ws = new WebSocket(WS_URL);
    const queue = makeFrameQueue();
    const pending = { acks: new Map(), pong: null };
    let settleClosed;
    const closed = new Promise((resolve) => { settleClosed = resolve; });
    const conn = { ws, pending, closed };
    let opened;
    const openP = new Promise((resolve) => { opened = resolve; });
    let stableTimer = null;

    // The client decides this socket is done: settle the outcome NOW, then
    // close best-effort. On a dead link the close event may never arrive, so
    // never gate the reconnect on it.
    const giveUp = (code, reason, kind = 'socket_closed') => {
      if (!live()) return;
      this._generation += 1;
      queue.end();
      settleClosed({ kind, code, reason, side: 'client' });
      try { ws.close(code, reason); } catch { /* already closing */ }
    };
    this._giveUp = giveUp;

    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => { if (live()) opened(true); });
    ws.addEventListener('error', () => { /* a close event follows */ });
    ws.addEventListener('close', (ev) => {
      if (!live()) return;
      this._generation += 1;
      queue.end();
      // 1006 means no Close frame arrived, so nobody "sent" it.
      settleClosed({
        kind: 'socket_closed',
        code: ev.code,
        reason: ev.reason,
        side: ev.code === 1006 ? 'unknown' : 'server',
        ...parseCloseReason(ev.reason),
      });
    });
    ws.addEventListener('message', (ev) => {
      if (!live()) return;
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch { return; }
      if (!frame || typeof frame !== 'object' || typeof frame.event !== 'string') return;
      queue.push(frame);
    });

    try {
      const up = await Promise.race([
        openP, closed.then(() => false), sleep(HANDSHAKE_TIMEOUT_MS).then(() => 'timeout'),
      ]);
      if (up !== true) {
        if (up === 'timeout') giveUp(4000, 'open timeout');
        return await closed;
      }

      const challenge = await queue.next(HANDSHAKE_TIMEOUT_MS);
      if (!challenge || challenge.event !== 'connect.challenge') {
        if (challenge === undefined) giveUp(4000, 'no connect.challenge');
        else if (challenge) giveUp(4002, 'expected connect.challenge');
        return await closed;
      }
      ws.send(JSON.stringify(this._buildConnectFrame(challenge)));

      const hello = await queue.next(HANDSHAKE_TIMEOUT_MS);
      if (hello === undefined) { giveUp(4000, 'no hello'); return await closed; }
      if (hello === null) return await closed;
      if (hello.event === 'hello-fail') {
        const kind = classifyHelloFail(hello.payload?.reason);
        this.log('hello-fail', { reason: hello.payload?.reason, class: kind });
        const info = await Promise.race([closed, sleep(2000).then(() => null)]);
        if (!info) giveUp(1000, 'hello-fail');
        return { kind, reason: hello.payload?.reason, code: info?.code, side: info?.side ?? 'client' };
      }
      if (hello.event !== 'hello-ok') { giveUp(4002, 'expected hello-ok'); return await closed; }

      const echoed = hello.payload?.device_id;
      this.log('hello-ok', { device_id_echoed: echoed === this.state.wsDeviceId });
      // Adopt the server's value verbatim, so this stays "the same device".
      if (echoed && echoed !== this.state.wsDeviceId) {
        this.state.wsDeviceId = echoed;
        persistState(this.stateFile, this.state);
      }

      // Re-read behavior on EVERY connect; fail-closed if it cannot be read.
      try {
        this._behavior = await fetchBehavior(this.state, this.restDeviceId);
      } catch (e) {
        this.log('behavior-fetch-failed', { error: e.message });
        if (e.http === 401) this._refresh('reactive').catch(() => {});
        giveUp(4000, 'behavior fetch failed');
        return await closed;
      }
      stableTimer = setTimeout(() => { this.state.reconnectAttempt = 0; }, COUNTER_RESET_WINDOW_MS);
      stableTimer.unref?.();

      const ctx = {
        state: this.state,
        pending,
        onError: (f) => this.log('message-error', {
          trace: f.trace_id, code: f.payload?.code, reason: f.payload?.reason,
        }),
        onRecall: (id) => this.log('recall', { target_message_id: shortId(id) }),
        onSignal: (p) => this.log('signal', { type: p?.type }),
        onPermissionResult: (meta) => this.onPermissionResult(meta),
        refetchBehavior: () => {
          fetchBehavior(this.state, this.restDeviceId)
            .then((b) => { this._behavior = b; this.log('behavior-refetched'); })
            .catch((e) => this.log('behavior-refetch-failed', { error: e.message }));
        },
        onDropped: (f, step) => this.log('dropped', { event: f.event, step }),
        onOwnerMessage: (text, frame) => {
          this.log('owner-message', {
            sender: shortId(frame.sender?.id),
            differs_from_sub: frame.sender?.id !== this.state.ownUserId,
            mode: frame.payload?.message_mode ?? '',
          });
          Promise.resolve(this.onMessage(text, frame, this._behavior))
            .then(async (reply) => {
              if (typeof reply !== 'string' || reply === '') return;
              const ok = await this.send(conn, frame.chat_id, reply);
              if (ok) this.log('reply', { acked: true });
            })
            .catch((e) => this.log('hook-error', { error: e.message }));
        },
      };

      // ONE reader owns the socket from here on.
      const reader = (async () => {
        for (;;) {
          const frame = await queue.next();
          if (frame === null) return;
          routeInbound(ctx, frame);
        }
      })();

      this._heartbeat(conn, giveUp);

      if (!this.state.greeted) {
        const text = this.welcomeText();
        if (text) {
          const ok = await this.send(conn, this.state.conversationId, text);
          if (ok) {
            // Only after the ack — setting it at send time turns a transient
            // failure into permanent silence.
            this.state.greeted = true;
            persistState(this.stateFile, this.state);
            this.log('welcome', { acked: true });
          }
        } else {
          this.state.greeted = true;
          persistState(this.stateFile, this.state);
        }
      }

      await reader;
      return await closed;
    } catch (e) {
      this.log('connection-error', { error: e.message });
      giveUp(4000, 'client error');
      return await closed;
    } finally {
      if (stableTimer) clearTimeout(stableTimer);
      if (this._giveUp === giveUp) this._giveUp = null;
    }
  }

  /** Override to change the one-time greeting. Return null to stay silent. */
  welcomeText() {
    return "Hello — I'm online.";
  }

  _buildConnectFrame(challenge) {
    return {
      version: '2',
      event: 'connect',
      trace_id: newTraceId('connect'),
      emitted_at: Date.now(),
      payload: {
        token: this.state.accessToken,
        nonce: challenge.payload.nonce,   // echoed byte-for-byte
        device_id: this.state.wsDeviceId,
        client_version: '1.0.0',
        protocol_version: PROTOCOL_VERSION,
        capabilities: { ...CAPABILITIES },
      },
    };
  }

  _heartbeat(conn, giveUp) {
    (async () => {
      for (;;) {
        await sleep(PING_INTERVAL_MS);
        if (this._stopped || this._generation === 0) return;
        if (conn.ws.readyState !== WebSocket.OPEN) return;
        const sentAt = Date.now();
        const traceId = newTraceId('ping');
        const pong = new Promise((resolve) => { conn.pending.pong = { emittedAt: sentAt, resolve }; });
        try {
          conn.ws.send(JSON.stringify({
            version: '2', event: 'ping', trace_id: traceId, emitted_at: sentAt, payload: {},
          }));
        } catch {
          conn.pending.pong = null;
          giveUp(4000, 'ping send failed');
          return;
        }
        const won = await Promise.race([
          pong.then((f) => ({ pong: f })),
          conn.closed.then(() => 'closed'),
          sleep(Math.max(0, sentAt + PONG_TIMEOUT_MS - Date.now())).then(() => 'timeout'),
        ]);
        conn.pending.pong = null;
        if (won === 'closed') return;
        if (won === 'timeout') {
          this.log('heartbeat-timeout', { trace: traceId });
          giveUp(4000, 'heartbeat timeout');
          return;
        }
        this.log('pong', {
          rtt_ms: Date.now() - sentAt,
          trace_ok: won.pong.trace_id === traceId,
          emitted_ok: won.pong.emitted_at === sentAt,
        });
      }
    })();
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  /** Send text, split into fragments, and resolve true only on a confirmed ack. */
  async send(conn, chatId, text) {
    for (const fragment of splitFragments(text)) {
      const ok = await this._sendOne(conn, chatId, fragment);
      if (!ok) return false;
    }
    return true;
  }

  async _sendOne(conn, chatId, text) {
    const traceId = newTraceId('send');
    const reply = new Promise((resolve) => conn.pending.acks.set(traceId, resolve));
    try {
      conn.ws.send(JSON.stringify({
        version: '2',
        event: 'message.send',
        trace_id: traceId,
        emitted_at: Date.now(),
        chat_id: chatId,
        payload: { message_mode: 'normal', message: { body: { fragments: [{ kind: 'text', text }] } } },
      }));
    } catch (e) {
      conn.pending.acks.delete(traceId);
      this.log('send-failed', { trace: traceId, error: e.message });
      return false;
    }
    const result = await Promise.race([
      reply, sleep(ACK_TIMEOUT_MS).then(() => null), conn.closed.then(() => null),
    ]);
    conn.pending.acks.delete(traceId);
    if (!result) { this.log('send-unanswered', { trace: traceId }); return false; }
    if (result.event === 'message.error') return false;
    return true;
  }

  // ── token refresh ─────────────────────────────────────────────────────────

  async _refresh(trigger = 'timer') {
    if (this.state._refreshInFlight) return 'in_flight';
    if (Date.now() - (this.state.lastRefreshAttemptAt ?? 0) < REFRESH_MIN_INTERVAL_MS) return 'throttled';
    this.state._refreshInFlight = true;
    this.state.lastRefreshAttemptAt = Date.now();
    try {
      const r = await rest('POST', '/v1/auth/refresh', {
        deviceId: this.restDeviceId,
        body: { refresh_token: this.state.refreshToken },
      });
      if (r.code === 10003) {
        // 10003 is ALSO what a benign race looks like: our own process already
        // rotated past this token. Check before treating it as terminal.
        const onDisk = loadState(this.stateFile);
        if (onDisk.refreshToken && onDisk.refreshToken !== this.state.refreshToken) {
          this.state.refreshToken = onDisk.refreshToken;
          this.state.accessToken = onDisk.accessToken;
          this.log('refresh', { trigger, code: 10003, action: 'retry-with-persisted-token' });
          this.state._refreshInFlight = false;
          this.state.lastRefreshAttemptAt = 0;
          return this._refresh(trigger);
        }
        this.state.rePairingRequired = true;
        this.log('refresh', { trigger, code: 10003, action: 're-pairing-required' });
        return 'terminal';
      }
      if (r.code !== 0) {
        this.log('refresh', { trigger, code: r.code, msg: r.msg, action: 'keep-old-token' });
        return 'transient';
      }
      // Persist BEFORE swapping in memory: the new refresh token is single-use,
      // so a crash between the two steps would leave nothing that works.
      persistState(this.stateFile, {
        ...this.state,
        accessToken: r.data.access_token,
        refreshToken: r.data.refresh_token,
      });
      this.state.accessToken = r.data.access_token;
      this.state.refreshToken = r.data.refresh_token;
      this.state.refreshAtMs = refreshAtFromClaims(decodeJwtClaims(this.state.accessToken), this.state.activatedAt);
      persistState(this.stateFile, this.state);
      this.log('refresh', { trigger, code: 0 });
      // The access token is only checked at handshake time, so a refresh needs
      // a fresh handshake to take effect.
      try { this._giveUp?.(1000, 'token refreshed', 'refresh_close'); } catch { /* not connected */ }
      return 'ok';
    } finally {
      this.state._refreshInFlight = false;
    }
  }
}

// ── Frame routing (connect/05, connect/06) ──────────────────────────────────

/**
 * Branch order matters: pong; ack/error; the four special frames; only then
 * the filter chain. `permission_result` arrives as event "message.send" with
 * sender.id "system", so it must be recognized by payload.metadata.kind —
 * inside payload, not on the envelope — or the chain drops it silently.
 */
export function routeInbound(ctx, frame) {
  const { state, pending } = ctx;

  if (frame.event === 'pong') {
    const p = pending?.pong;
    if (p && frame.emitted_at === p.emittedAt) p.resolve(frame);
    else ctx.onDropped?.(frame, 'stale-pong');
    return 'pong';
  }

  if (frame.event === 'message.ack' || frame.event === 'message.error') {
    // Log every error, matched or not: an unmatched one is the only signal
    // that something failed at all.
    if (frame.event === 'message.error') ctx.onError?.(frame);
    const waiter = pending?.acks.get(frame.trace_id);
    if (waiter) {
      pending.acks.delete(frame.trace_id);
      waiter(frame);
    }
    return frame.event === 'message.ack' ? 'ack' : 'error';
  }

  if (frame.event === 'message.recall') {
    ctx.onRecall?.(frame.payload?.target_message_id);
    return 'recall';
  }
  if (frame.event === 'notify.signal') {
    ctx.onSignal?.(frame.payload);
    return 'signal';
  }
  if (frame.event === 'chat.metadata.invalidated') {
    if (Array.isArray(frame.payload?.scope) && frame.payload.scope.includes('behavior')) {
      ctx.refetchBehavior?.();
    }
    return 'metadata';
  }
  if (frame.sender?.id === 'system' && frame.payload?.metadata?.kind === 'permission_result') {
    ctx.onPermissionResult?.(frame.payload.metadata);
    return 'permission_result';
  }

  const verdict = passesInboundFilter(state, frame);
  if (!verdict.ok) {
    ctx.onDropped?.(frame, verdict.step);
    return 'dropped';
  }
  ctx.onOwnerMessage?.(verdict.text, frame);
  return 'message';
}

/** A tiny async queue: the handshake reads it turn by turn, then one reader owns it. */
function makeFrameQueue() {
  const items = [];
  const waiters = [];
  let ended = false;
  return {
    push(frame) {
      const w = waiters.shift();
      if (w) w(frame); else items.push(frame);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()(null);
    },
    next(timeoutMs) {
      if (items.length) return Promise.resolve(items.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        let timer = null;
        const settle = (v) => { if (timer) clearTimeout(timer); resolve(v); };
        waiters.push(settle);
        if (timeoutMs) {
          timer = setTimeout(() => {
            const i = waiters.indexOf(settle);
            if (i >= 0) waiters.splice(i, 1);
            resolve(undefined);
          }, timeoutMs);
        }
      });
    },
  };
}
