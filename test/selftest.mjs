/**
 * Offline self-test. No network, no credentials, no DSH process.
 *
 *   node test/selftest.mjs
 *
 * Covers the parts that fail silently in production if they are wrong: the
 * inbound filter chain, the reconnect backoff numbers, the hello-fail
 * classifier, fragment splitting, the single-holder lock, and the turn queue.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  passesInboundFilter,
  computeReconnectDelay,
  ordinaryBackoff,
  takeoverFloor,
  classifyHelloFail,
  parseCloseReason,
  splitFragments,
  refreshAtFromClaims,
  decodeJwtClaims,
  shortId,
  isValidConversationId,
  routeInbound,
  MAX_FRAGMENT_CHARS,
} from '../lib/protocol.js';
import { acquireLock, isAlive, readLock } from '../lib/lock.js';
import { serialize, execRunner, Transcript } from '../lib/runner.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
}

async function testAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
}

const OWN = 'usr_01AAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER = 'usr_01BBBBBBBBBBBBBBBBBBBBBBBB';
const CNV = 'cnv_01TESTTESTTESTTESTTESTTEST';

const frame = (over = {}) => ({
  version: '2',
  event: 'message.send',
  trace_id: 't1',
  emitted_at: Date.now(),
  chat_id: CNV,
  chat_type: 'direct',
  sender: { id: OWNER, type: 'direct', nick_name: 'owner' },
  payload: {
    message_id: 'msg-1',
    message_mode: 'normal',
    message: { body: { fragments: [{ kind: 'text', text: 'hi' }] } },
  },
  ...over,
});

console.log('\ninbound filter chain (connect/05)');
const st = { ownUserId: OWN };
test('an owner message passes', () => assert.equal(passesInboundFilter(st, frame()).ok, true));
test('own message is a self-echo (step 5)', () => {
  const v = passesInboundFilter(st, frame({ sender: { id: OWN } }));
  assert.equal(v.ok, false);
  assert.equal(v.step, 5);
});
test('empty message_mode means normal (step 6)', () => {
  const f = frame();
  f.payload.message_mode = '';
  assert.equal(passesInboundFilter(st, f).ok, true);
});
test('an unknown message_mode is rejected', () => {
  const f = frame();
  f.payload.message_mode = 'bogus';
  assert.equal(passesInboundFilter(st, f).step, 6);
});
test('sender "system" is dropped (step 4)', () =>
  assert.equal(passesInboundFilter(st, frame({ sender: { id: 'system' } })).step, 4));
test('empty fragments are dropped (step 7)', () => {
  const f = frame();
  f.payload.message.body.fragments = [];
  assert.equal(passesInboundFilter(st, f).step, 7);
});
test('a media fragment with no text is dropped, not thrown on', () => {
  const f = frame();
  f.payload.message.body.fragments = [{ kind: 'image' }];
  assert.equal(passesInboundFilter(st, f).ok, false);
});
test('an unknown own id fails closed (step 2)', () =>
  assert.equal(passesInboundFilter({}, frame()).step, 2));
test('a malformed chat_id is rejected (step 3)', () =>
  assert.equal(passesInboundFilter(st, frame({ chat_id: 'usr_x' })).step, 3));
test('a non-message event is dropped (step 1)', () =>
  assert.equal(passesInboundFilter(st, frame({ event: 'typing.update' })).step, 1));
test('chat_id validator accepts cnv_ and rejects anything else', () => {
  assert.equal(isValidConversationId(CNV), true);
  assert.equal(isValidConversationId('usr_01TESTTESTTESTTESTTESTTEST'), false);
});

console.log('\nrouting order (connect/06)');
test('permission_result is diverted before the chain', () => {
  let got = null;
  const ctx = {
    state: st,
    pending: { acks: new Map(), pong: null },
    onPermissionResult: (m) => { got = m; },
    onOwnerMessage: () => { throw new Error('should not reach the chain'); },
  };
  const r = routeInbound(ctx, frame({
    sender: { id: 'system' },
    payload: { metadata: { kind: 'permission_result', status: 'approved' } },
  }));
  assert.equal(r, 'permission_result');
  assert.equal(got.status, 'approved');
});
test('a permission_result must NOT be read from the envelope', () => {
  // metadata on the envelope is not the field. A frame carrying it there is an
  // ordinary message and must fall through to the chain, not be misrouted.
  let delivered = false;
  const ctx = {
    state: st,
    pending: { acks: new Map(), pong: null },
    onOwnerMessage: () => { delivered = true; },
  };
  const r = routeInbound(ctx, { ...frame(), metadata: { kind: 'permission_result' } });
  assert.equal(r, 'message');
  assert.equal(delivered, true);
});
test('a pong only counts when emitted_at matches', () => {
  let resolved = false;
  const ctx = { state: st, pending: { acks: new Map(), pong: { emittedAt: 5, resolve: () => { resolved = true; } } } };
  routeInbound(ctx, { event: 'pong', emitted_at: 999 });
  assert.equal(resolved, false, 'a stale pong must not resolve the waiter');
  routeInbound(ctx, { event: 'pong', emitted_at: 5 });
  assert.equal(resolved, true);
});

console.log('\nreconnect backoff (connect/04)');
test('ordinary backoff is base plus at most 30%', () => {
  for (let a = 1; a <= 6; a++) {
    const base = Math.min(15000, 500 * 2 ** (a - 1));
    const d = ordinaryBackoff(a);
    assert.ok(d >= base && d <= base * 1.3, `attempt ${a}: ${d} outside [${base}, ${base * 1.3}]`);
  }
});
test('takeover floor is exactly 5,10,20,40,80,160,320,600,600', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => takeoverFloor(n) / 1000),
    [5, 10, 20, 40, 80, 160, 320, 600, 600]);
});
test('a server 4001 uses the takeover floor, never an immediate retry', () => {
  const s = { reconnectAttempt: 0, takeoverStreak: 0 };
  assert.equal(computeReconnectDelay(s, { kind: 'socket_closed', side: 'server', code: 4001 }), 5000);
});
test('a 4002 honours retry_after_ms under a 600s ceiling', () => {
  assert.equal(computeReconnectDelay({}, { kind: 'socket_closed', side: 'server', code: 4002, retryAfterMs: 30000 }), 30000);
  assert.equal(computeReconnectDelay({}, { kind: 'socket_closed', side: 'server', code: 4002, retryAfterMs: 9e9 }), 600000);
});
test('an auth_terminal outcome stops the loop', () => {
  const s = {};
  assert.equal(computeReconnectDelay(s, { kind: 'auth_terminal' }), 0);
  assert.equal(s.rePairingRequired, true);
});
test('our own refresh close resets both streaks', () => {
  const s = { reconnectAttempt: 7, takeoverStreak: 4 };
  computeReconnectDelay(s, { kind: 'refresh_close' });
  assert.equal(s.reconnectAttempt, 0);
  assert.equal(s.takeoverStreak, 0);
});
test('a 4002 resets the takeover streak', () => {
  const s = { takeoverStreak: 3 };
  computeReconnectDelay(s, { kind: 'socket_closed', side: 'server', code: 4002, retryAfterMs: 1000 });
  assert.equal(s.takeoverStreak, 0);
});
test('close reason JSON is parsed, plain text is not fatal', () => {
  assert.equal(parseCloseReason('{"retry_after_ms":1234}').retryAfterMs, 1234);
  assert.deepEqual(parseCloseReason('ordinary reason'), {});
  assert.deepEqual(parseCloseReason(undefined), {});
});

console.log('\nhello-fail classification (pitfall 13)');
test('only "authentication failed" is terminal', () => {
  assert.equal(classifyHelloFail('authentication failed'), 'auth_terminal');
  assert.equal(classifyHelloFail('  Authentication Failed  '), 'auth_terminal');
  for (const r of ['remote auth service unavailable', 'nonce mismatch', 'invalid connect payload', 'invalid connect event']) {
    assert.equal(classifyHelloFail(r), 'handshake_transient', r);
  }
});
test('classification is not a substring match', () => {
  assert.equal(classifyHelloFail('not authentication failed yet'), 'handshake_transient');
});

console.log('\nfragment splitting (05-messaging)');
test('short text is one fragment', () =>
  assert.deepEqual(splitFragments('hello'), ['hello']));
test('empty text produces no fragments', () =>
  assert.deepEqual(splitFragments(''), []));
test('long text is split under the limit', () => {
  const parts = splitFragments('a'.repeat(9000));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= MAX_FRAGMENT_CHARS);
  assert.equal(parts.join('').length, 9000, 'splitting must not lose characters');
});
test('splitting prefers a paragraph boundary', () => {
  const parts = splitFragments(`${'x'.repeat(3000)}\n\n${'y'.repeat(3000)}`);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith('x'));
});

console.log('\ntoken refresh timing (connect/04)');
test('the lead is clamped to the 2h ceiling', () => {
  const now = Math.floor(Date.now() / 1000);
  const at = refreshAtFromClaims({ iat: now, exp: now + 30 * 24 * 3600 }, now);
  const leadMs = (now + 30 * 24 * 3600) * 1000 - at;
  assert.ok(leadMs >= 1.5 * 3600 * 1000 && leadMs <= 2.5 * 3600 * 1000, `lead was ${leadMs}ms`);
});
test('an unparseable exp falls back to activatedAt + 24h', () => {
  const at = refreshAtFromClaims({}, 1000);
  assert.equal(at, (1000 + 24 * 3600) * 1000);
});

console.log('\nutilities');
test('JWT claims decode without verification', () => {
  const payload = Buffer.from(JSON.stringify({ sub: OWN, aid: 'agt_x' })).toString('base64url');
  assert.equal(decodeJwtClaims(`h.${payload}.s`).sub, OWN);
  assert.deepEqual(decodeJwtClaims('garbage'), {});
});
test('shortId masks everything after the prefix', () => {
  assert.equal(shortId('agt_01TESTTESTTESTTESTTESTTEST'), 'agt_01TEST…');
  assert.equal(shortId('not-an-id'), 'not-an-id');
});

console.log('\nsingle-holder lock');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-test-'));
const lockFile = path.join(tmp, 'holder.lock');
test('isAlive is true for this process and false for an unused pid', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(999999), false);
});
test('a second acquire from a live holder is refused', () => {
  const a = acquireLock(lockFile, 'A');
  assert.equal(a.ok, true);
  // Simulate another process by rewriting the pid to a live one that is not us.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, owner: 'other' }));
  const b = acquireLock(lockFile, 'B');
  assert.equal(b.ok, false, 'must not take a lock held by a live pid');
  assert.equal(b.holder.pid, 1);
  a.release();
});
test('a stale lock (dead pid) is reclaimed immediately', () => {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, owner: 'dead' }));
  const c = acquireLock(lockFile, 'C');
  assert.equal(c.ok, true);
  c.release();
});
test('release only removes our own lock', () => {
  const d = acquireLock(lockFile, 'D');
  assert.equal(d.ok, true);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, owner: 'successor' }));
  d.release();
  assert.equal(readLock(lockFile).owner, 'successor', "must not delete a successor's lock");
});
test('a corrupt lock file is treated as free', () => {
  fs.writeFileSync(lockFile, 'not json');
  const e = acquireLock(lockFile, 'E');
  assert.equal(e.ok, true);
  e.release();
});

console.log('\nturn queue (serialized)');
await testAsync('turns run one at a time, in order', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const runner = serialize(async (text) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    order.push(text);
    active--;
    return text;
  });
  await Promise.all([runner('a'), runner('b'), runner('c')]);
  assert.equal(maxActive, 1, 'two turns overlapped — the active-writer conflict this prevents');
  assert.deepEqual(order, ['a', 'b', 'c']);
});
await testAsync('a failing turn does not break the chain', async () => {
  let n = 0;
  const runner = serialize(async () => {
    n++;
    if (n === 1) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(() => runner('x'));
  assert.equal(await runner('y'), 'ok');
});

console.log('\nexec runner');
await testAsync('stdout becomes the reply', async () => {
  const run = execRunner({ command: process.execPath, args: ['-e', 'process.stdout.write("pong")'], cwd: tmp });
  assert.equal(await run('ignored', {}, ''), 'pong');
});
await testAsync('exit 0 with empty stdout is silence, not an error', async () => {
  const run = execRunner({ command: process.execPath, args: ['-e', ''], cwd: tmp });
  assert.equal(await run('ignored', {}, ''), null);
});
await testAsync('a non-zero exit does not throw', async () => {
  const run = execRunner({ command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: tmp });
  assert.equal(await run('ignored', {}, ''), null);
});
await testAsync('a missing command does not throw', async () => {
  const run = execRunner({ command: '/nonexistent/binary/xyz', cwd: tmp });
  assert.equal(await run('ignored', {}, ''), null);
});
await testAsync('the message reaches the command on stdin contract (via argv)', async () => {
  const run = execRunner({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1] ? "got" : "no")', '--'],
    cwd: tmp,
  });
  assert.equal(await run('hello', {}, ''), 'got');
});
await testAsync('behavior is folded into the prompt', async () => {
  const run = execRunner({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1].includes("BEHAVIOR_MARK") ? "yes" : "no")', '--'],
    cwd: tmp,
  });
  assert.equal(await run('hi', {}, 'BEHAVIOR_MARK'), 'yes');
});

console.log('\nrolling transcript');
test('the transcript renders and respects its budget', () => {
  const t = new Transcript(path.join(tmp, 'h.json'), { maxTurns: 4, maxChars: 100, fs });
  const h = [];
  for (let i = 0; i < 20; i++) h.push({ role: i % 2 ? 'agent' : 'owner', text: `line ${i} ${'z'.repeat(20)}` });
  const rendered = t.render(h);
  assert.ok(rendered.startsWith('[Earlier conversation]'));
  assert.ok(rendered.length < 400, 'budget not applied');
  assert.ok(rendered.includes('line 19'), 'the newest turn must survive');
  assert.ok(!rendered.includes('line 0 '), 'the oldest turn should be dropped');
});
test('an absent transcript file is not fatal', () => {
  const t = new Transcript(path.join(tmp, 'missing.json'), { fs });
  assert.deepEqual(t.load(), []);
});

console.log('\nplugin lifecycle (apply with a mock context)');
await testAsync('apply() starts, logs, and releases the lock on dispose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-apply-'));
  const lockFile = path.join(dir, 'holder.lock');
  const logFile = path.join(dir, 'channel.log');
  const logs = [];

  // Load the real plugin entry. schemastery may be absent outside a DSH
  // profile, so skip rather than fail the suite in that case.
  let mod;
  try {
    mod = await import('../lib/index.js');
  } catch (e) {
    if (String(e?.code) === 'ERR_MODULE_NOT_FOUND') {
      console.log('  skip (schemastery not resolvable outside a DSH profile)');
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    throw e;
  }

  const ctx = {
    logger: {
      info: (s) => logs.push(s),
      warn: (s) => logs.push(s),
      error: (s) => logs.push(s),
    },
    effect: (fn) => { ctx._dispose = fn(); },
  };

  // No state file and no connect code: pairing must fail cleanly, and that
  // failure must not escape and take DSH down with it.
  mod.apply(ctx, new mod.Config({
    stateFile: path.join(dir, 'state.json'),
    lockFile,
    logFile,
    command: process.execPath,
    args: ['-e', ''],
  }));

  await new Promise((r) => setTimeout(r, 1500));

  assert.ok(fs.existsSync(lockFile), 'the identity lock must be taken while running');
  assert.ok(fs.existsSync(logFile), 'the plugin must write its own log');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('fatal'), 'the missing-tokens failure must be recorded');
  assert.ok(logs.length > 0, 'the failure must reach the DSH logger too');

  assert.equal(typeof ctx._dispose, 'function', 'the plugin must register a disposer');
  ctx._dispose();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(lockFile), false, 'the lock must be released on dispose');

  fs.rmSync(dir, { recursive: true, force: true });
});
await testAsync('apply() stands by instead of double-holding the identity', async () => {
  let mod;
  try {
    mod = await import('../lib/index.js');
  } catch (e) {
    if (String(e?.code) === 'ERR_MODULE_NOT_FOUND') {
      console.log('  skip (schemastery not resolvable outside a DSH profile)');
      return;
    }
    throw e;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-standby-'));
  const lockFile = path.join(dir, 'holder.lock');
  // Pretend a live process already holds it — pid 1 is always alive.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, owner: 'resident-bridge' }));

  const logs = [];
  const ctx = {
    logger: { info: (s) => logs.push(s), warn: (s) => logs.push(s), error: (s) => logs.push(s) },
    effect: (fn) => { ctx._dispose = fn(); },
  };
  mod.apply(ctx, new mod.Config({
    stateFile: path.join(dir, 'state.json'),
    lockFile,
    logFile: path.join(dir, 'channel.log'),
  }));
  await new Promise((r) => setTimeout(r, 500));

  assert.ok(logs.some((l) => l.includes('standing by')), 'it must report standing by, not connect');
  // The other holder's lock must be untouched.
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).owner, 'resident-bridge');

  ctx._dispose?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
