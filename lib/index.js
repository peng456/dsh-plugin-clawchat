/**
 * dsh-plugin-clawchat — ClawChat agent-side channel for DeepSeek Harness.
 *
 * Holds a ClawChat connection itself (the self-held lane: no ClawChat desktop
 * app required) and answers each owner message with one headless turn of the
 * configured command.
 *
 * ## The one rule that matters
 *
 * One ClawChat identity admits exactly one live connection. If something else
 * on this machine already holds it — a resident bridge under launchd, another
 * dsh instance, an older copy of this plugin — this plugin must NOT connect:
 * two holders evict each other with close code 4001 forever, and it does not
 * settle on its own. So the plugin takes a lock file first and stays offline
 * while another holder owns it. Set `takeover: true` to override that and take
 * the identity anyway.
 *
 * ## Failure policy
 *
 * This is an add-on capability. Nothing it does may stop DSH from booting, so
 * every failure path disables this plugin alone and logs why.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

import { ClawChatClient } from './protocol.js';
import { acquireLock } from './lock.js';
import { execRunner, serialize, Transcript } from './runner.js';

export const name = 'dsh-plugin-clawchat';
export const inject = [];

const DEFAULT_DIR = path.join(os.homedir(), '.clawchat');

/** A leading ~ is convenience for a human writing config; expand it here. */
function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

export const Config = z.object({
  enabled: z.boolean().default(true),

  /** Where tokens and the WebSocket device id live. Treat it as a secret. */
  stateFile: z.string().default(path.join(DEFAULT_DIR, 'state.json')),

  /**
   * Lock file guarding the identity. Every holder on this machine must agree
   * on this path for the protection to work.
   */
  lockFile: z.string().default(path.join(DEFAULT_DIR, 'holder.lock')),

  /** Take the identity even if another holder owns the lock. */
  takeover: z.boolean().default(false),

  /** Stable name for this channel implementation. Part of the WS device id. */
  channel: z.string().default('dsh-clawchat'),

  /**
   * The constant `X-Device-Id` sent on every REST call. It MUST be
   * byte-for-byte the value used when the connect code was redeemed, or token
   * refresh answers 10003 — the same code, and the same sentence, as a revoked
   * credential. Set it explicitly for any identity originally paired by
   * something else (for example the ClawChat desktop app).
   */
  restDeviceId: z.string().default(''),

  /** Connect code for the first pairing. Only needed until tokens exist. */
  connectCode: z.string().default(''),

  /** The command that runs one headless turn: prompt on stdin, reply on stdout. */
  command: z.string().default('dsh'),
  args: z.array(z.string()).default(['--profile', 'headless']),
  /** Working directory for turns. Defaults to the DSH process's cwd. */
  cwd: z.string().default(''),
  turnTimeoutMs: z.natural().default(10 * 60 * 1000),
  /** Extra environment for the turn process. */
  env: z.dict(z.string()).default({}),

  /** Sent once, after the first successful pairing. Empty string = stay silent. */
  greeting: z.string().default("Hello — I'm online."),

  /**
   * Rolling transcript for runtimes whose turns share no session. The shipped
   * dsh headless profile cannot resume a session, so without this every reply
   * starts from nothing. Set maxTurns to 0 to disable.
   */
  transcriptFile: z.string().default(path.join(DEFAULT_DIR, 'history.json')),
  historyMaxTurns: z.natural().default(12),
  historyMaxChars: z.natural().default(6000),

  /** Append structured event lines here. Empty = only the DSH log. */
  logFile: z.string().default(path.join(DEFAULT_DIR, 'channel.log')),
});

export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('clawchat: disabled by config');
    return;
  }
  try {
    applyUnsafe(ctx, config);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.logger?.error?.(`clawchat: init failed, plugin disabled (DSH is unaffected): ${detail}`);
  }
}

function applyUnsafe(ctx, config) {
  const logger = ctx.logger;
  // Every path in config may be written with a leading ~.
  const stateFile = expandHome(config.stateFile);
  const lockFile = expandHome(config.lockFile);
  const transcriptFile = expandHome(config.transcriptFile);
  const logFile = expandHome(config.logFile);
  const cwd = expandHome(config.cwd) || process.cwd();
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch { /* logging is best-effort; never a reason to fail */ }

  // Appends are synchronous on purpose: a stream buffers its tail, and a holder
  // killed with SIGKILL takes that buffer with it — which is exactly when the
  // last few lines are the ones worth having.
  const log = (event, fields = {}) => {
    const parts = [new Date().toISOString(), event];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${k}=${/[\s"]/.test(s) ? JSON.stringify(s) : s}`);
    }
    const line = parts.join(' ');
    try { fs.appendFileSync(logFile, line + '\n', { mode: 0o600 }); } catch { /* ignore */ }
    logger?.info?.(`clawchat: ${line}`);
  };

  // ── The identity is single-holder: take the lock before anything else ──
  const lock = acquireLock(lockFile, `${name}:${process.pid}`);
  if (!lock.ok && !config.takeover) {
    const who = lock.holder ? `${lock.holder.owner} (pid ${lock.holder.pid})` : 'another process';
    log('standby', { reason: 'identity already held', holder: who, lock: lockFile });
    logger?.warn?.(`clawchat: standing by — ${who} already holds this ClawChat identity. Not connecting, so the two do not evict each other.`);
    return;
  }
  if (!lock.ok && config.takeover) {
    log('takeover', { reason: 'takeover=true, ignoring existing lock' });
    logger?.warn?.('clawchat: takeover=true — connecting despite another holder; expect 4001 eviction while both run.');
  }

  // ── Wire the turn runner ──
  const transcript = config.historyMaxTurns > 0
    ? new Transcript(transcriptFile, {
        maxTurns: config.historyMaxTurns,
        maxChars: config.historyMaxChars,
        fs,
      })
    : null;

  const turn = execRunner({
    command: config.command,
    args: [...(config.args ?? [])],
    cwd,
    env: { ...(config.env ?? {}) },
    timeoutMs: config.turnTimeoutMs,
    log,
    buildPrompt: (text, behavior) => {
      const parts = [];
      const b = typeof behavior === 'string' ? behavior.trim() : '';
      if (b) parts.push(`[System instructions from your owner]\n${b}`);
      if (transcript) {
        const h = transcript.render(transcript.load());
        if (h) parts.push(h.trimEnd());
      }
      parts.push(`[Owner message]\n${text}`);
      return parts.join('\n\n');
    },
  });

  const runTurn = serialize(async (text, frame, behavior) => {
    const history = transcript ? transcript.load() : null;
    if (history) {
      history.push({ role: 'owner', text, ts: Date.now() });
      transcript.save(history);
    }
    const reply = await turn(text, frame, behavior);
    if (history && reply) {
      history.push({ role: 'agent', text: reply, ts: Date.now() });
      transcript.save(history);
    }
    return reply;
  });

  const client = new ClawChatClient({
    stateFile,
    channel: config.channel,
    restDeviceId: config.restDeviceId || `${config.channel}-rest`,
    onMessage: runTurn,
    log,
    onPermissionResult: (meta) => {
      // 21001 means the operation did NOT happen and the server sent the owner
      // an approval card. Never retry: cards are not deduped.
      log('permission-result', { kind: meta?.kind, status: meta?.status });
    },
    onBehaviorInvalidated: () => log('behavior-invalidated'),
  });

  if (config.greeting) client.welcomeText = () => config.greeting;

  // ── Start ──
  const boot = async () => {
    try {
      await client.ensurePaired(config.connectCode || undefined);
      // The code is spent once tokens exist; keeping it in config invites a
      // second redemption (a duplicate agent) after any state reset.
      if (config.connectCode) {
        logger?.info?.('clawchat: pairing complete — remove connectCode from the config; it has been spent.');
      }
      await client.run();
    } catch (e) {
      log('fatal', { error: e?.message ?? String(e) });
      logger?.error?.(`clawchat: stopped — ${e?.message ?? String(e)}`);
    }
  };
  const running = boot();

  ctx.effect(() => () => {
    try { client.stop(); } catch { /* ignore */ }
    if (lock.ok) lock.release();
    logger?.info?.('clawchat: stopped');
  });

  // Surface a crash instead of letting the process close over a rejection.
  running.catch(() => { /* already logged in boot() */ });
}
