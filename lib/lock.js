/**
 * Single-holder lock.
 *
 * One ClawChat identity admits exactly one live connection. Two holders do not
 * "share" it: the server closes one with 4001 (takeover), the loser reconnects
 * on its backoff, takes it back, and the two trade the identity indefinitely.
 * That is not a race that settles — it runs until one side exits.
 *
 * So every process that could hold this identity takes this lock first, and a
 * process that cannot get it simply does not connect. The lock is advisory and
 * local: it protects holders on THIS machine, which is where more than one
 * holder realistically appears (a resident bridge plus an in-process channel).
 *
 * Liveness is the owning pid, not a timestamp: a holder killed with SIGKILL
 * leaves the file behind, and a stale-by-time lock would then block a healthy
 * successor for as long as the timeout, while a stale-by-pid lock is reclaimed
 * immediately.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Is this pid alive? Signal 0 performs the permission and existence checks only. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return e?.code === 'EPERM';
  }
}

export function readLock(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Try to take the lock.
 *
 * @returns {{ok: true, file: string, release: () => void}
 *          | {ok: false, holder: {pid: number, owner: string} | null}}
 */
export function acquireLock(file, owner = 'unknown') {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    return { ok: false, holder: { pid: existing.pid, owner: String(existing.owner ?? 'unknown') } };
  }

  const payload = {
    pid: process.pid,
    owner,
    host: safeHostname(),
    since: new Date().toISOString(),
  };

  // Exclusive create would race between two simultaneous starters; writing then
  // re-reading the pid makes the winner unambiguous, and the loser releases.
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (e) {
    return { ok: false, holder: null, error: e.message };
  }

  const verify = readLock(file);
  if (!verify || verify.pid !== process.pid) {
    return { ok: false, holder: verify ? { pid: verify.pid, owner: String(verify.owner ?? 'unknown') } : null };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only remove it if it is still ours — never delete a successor's lock.
    const now = readLock(file);
    if (now && now.pid === process.pid) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  };

  return { ok: true, file, release };
}

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}
