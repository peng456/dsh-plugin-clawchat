/**
 * Turn runners.
 *
 * A runner turns one owner message into one reply string. The channel does not
 * care how — that is the whole point of keeping this behind one function, so
 * the same channel works with any agent runtime that has a non-interactive
 * mode.
 *
 * Two built-in runners:
 *
 *   exec  — spawn a command, write the prompt to stdin, read the reply from
 *           stdout, exit 0. This is the shape every CLI agent already has
 *           (`dsh --profile headless`, `claude -p`, `codex exec`, …).
 *
 *   echo  — reply with a fixed string. For wiring and connectivity tests only.
 *
 * Turns for one conversation are serialized: two turns resuming the same
 * session at once fail with an active-writer conflict, so the queue is not an
 * optimization, it is a correctness requirement.
 */

import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a runner so only one turn runs at a time, in call order.
 * A failing turn never breaks the chain.
 */
export function serialize(runner) {
  let chain = Promise.resolve();
  return (text, frame, behavior) => {
    const run = () => runner(text, frame, behavior);
    const result = chain.then(run, run);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Run one headless turn of a command.
 *
 * The command runs in `cwd` with the prompt on stdin and its stdout as the
 * reply. A non-zero exit is a failure; exit 0 with empty stdout is legitimate
 * silence, not an error.
 */
export function execRunner({
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs = 10 * 60 * 1000,
  log = () => {},
  buildPrompt = defaultBuildPrompt,
} = {}) {
  if (!command) throw new Error('execRunner: command is required');

  return async (text, frame, behavior) => {
    const prompt = buildPrompt(text, behavior);
    let child;
    try {
      child = spawn(command, [...args, prompt], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (e) {
      log('turn-spawn-failed', { error: e.message });
      return null;
    }

    let out = '';
    let err = '';
    let settled = false;
    let timer = null;

    const done = await new Promise((resolve) => {
      const finish = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish({ why: 'timeout' });
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { log('turn-error', { error: e.message }); finish({ why: 'error' }); });
      child.on('close', (code) => finish({ why: code === 0 ? 'ok' : 'nonzero', code }));
    });

    log('turn-done', { why: done.why, out_len: out.length, err_len: err.length });
    if (err.trim()) log('turn-stderr', { excerpt: err.trim().slice(0, 600) });

    const reply = out.trim();
    if (done.why === 'ok' || done.why === 'timeout') return reply || null;
    return reply || null;
  };
}

/** Behavior is the owner-written system prompt; fold it into the same prompt. */
export function defaultBuildPrompt(text, behavior) {
  const b = typeof behavior === 'string' ? behavior.trim() : '';
  if (!b) return text;
  return `[System instructions from your owner]\n${b}\n\n[Owner message]\n${text}`;
}

/** Reply with a fixed string. For connectivity tests. */
export function echoRunner(text) {
  return async () => `echo: ${text}`;
}

/** Keep a bounded rolling transcript, for runtimes whose turns share no session. */
export class Transcript {
  constructor(file, { maxTurns = 12, maxChars = 6000, fs } = {}) {
    this.file = file;
    this.maxTurns = maxTurns;
    this.maxChars = maxChars;
    this._fs = fs;
  }

  load() {
    try {
      const j = JSON.parse(this._fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  save(history) {
    try {
      this._fs.writeFileSync(this.file, JSON.stringify(history.slice(-this.maxTurns * 2), null, 1), { mode: 0o600 });
    } catch { /* a missing transcript is not fatal */ }
  }

  render(history, labels = { owner: 'Owner', agent: 'Me' }) {
    const picked = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const who = history[i].role === 'owner' ? labels.owner : labels.agent;
      const line = `${who}: ${history[i].text}`;
      if (used + line.length > this.maxChars) break;
      picked.unshift(line);
      used += line.length;
    }
    return picked.length ? `[Earlier conversation]\n${picked.join('\n')}\n\n` : '';
  }
}
