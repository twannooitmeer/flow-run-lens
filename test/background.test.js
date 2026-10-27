// Runs the service worker in a VM with a stubbed chrome.* and fetch, using
// fake tokens and synthetic runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const ENV = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const FLOW = '0a1b2c3d-1111-2222-3333-444455556666';

function fakeJwt(aud, expInSec = 3600) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b({ alg: 'none' }) + '.' + b({ aud, exp: Math.floor(Date.now() / 1000) + expInSec }) + '.sig';
}

function load(fetchImpl) {
  const store = {};
  const listeners = {};
  const calls = [];
  const chrome = {
    runtime: { id: 'ext', onMessage: { addListener: (fn) => { listeners.message = fn; } } },
    webRequest: { onBeforeSendHeaders: { addListener: (fn, filter) => { listeners.request = fn; listeners.filter = filter; } } },
    storage: {
      session: {
        setAccessLevel() {},
        async get(key) { return { [key]: store[key] }; },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; },
      },
    },
  };
  const ctx = {
    chrome, console, URL, atob, setTimeout,
    fetch: async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return fetchImpl(url); },
  };
  ctx.self = ctx;
  ctx.importScripts = (p) => vm.runInContext(fs.readFileSync(path.join(SRC, p), 'utf8'), ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx);
  const send = (msg, sender = { id: 'ext', tab: {}, url: 'https://make.powerautomate.com/environments/x/flows' }) =>
    new Promise((resolve) => listeners.message(msg, sender, resolve));
  const request = (url, token, initiator = 'https://make.powerautomate.com') =>
    listeners.request({ url, initiator, tabId: 1, requestHeaders: [{ name: 'Authorization', value: 'Bearer ' + token }] });
  return { send, request, calls, store, listeners };
}

const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });

const RUNS = {
  value: [
    { name: 'r2', properties: { status: 'Failed', startTime: '2026-10-27T10:00:00Z', endTime: '2026-10-27T10:00:03Z', error: { code: 'X', message: 'y' } } },
    { name: 'r1', properties: { status: 'Succeeded', startTime: '2026-10-27T09:00:00Z', endTime: '2026-10-27T09:00:10Z' } },
  ],
};

test('without a captured token, getRuns reports auth', async () => {
  const bg = load(() => json(RUNS));
  assert.equal((await bg.send({ type: 'getRuns', env: ENV, flowId: FLOW })).error, 'auth');
  assert.equal(bg.calls.length, 0);
});

test('captures a Power Platform token and calls the environment host', async () => {
  const bg = load(() => json(RUNS));
  const token = fakeJwt('https://api.powerplatform.com');
  bg.request('https://aaaabbbbccccddddeeeeffff000011.11.environment.api.powerplatform.com/powerautomate/flows', token);
  await new Promise((r) => setImmediate(r));
  const res = await bg.send({ type: 'getRuns', env: ENV, flowId: FLOW });
  assert.equal(res.summary.total, 2);
  assert.equal(res.summary.fail, 1);
  assert.equal(bg.calls[0].url, 'https://aaaabbbbccccddddeeeeffff000011.11.environment.api.powerplatform.com/powerautomate/flows/' + FLOW + '/runs?api-version=1');
  assert.equal(bg.calls[0].auth, 'Bearer ' + token);
  // Cached for a minute.
  await bg.send({ type: 'getRuns', env: ENV, flowId: FLOW });
  assert.equal(bg.calls.length, 1);
});

test('ignores tokens from other initiators and wrong audiences', async () => {
  const bg = load(() => json(RUNS));
  bg.request('https://x1.environment.api.powerplatform.com/a', fakeJwt('https://api.powerplatform.com'), 'https://evil.example');
  bg.request('https://x1.environment.api.powerplatform.com/a', fakeJwt('https://graph.microsoft.com'));
  bg.request('https://api.flow.microsoft.com/a', fakeJwt('https://api.powerplatform.com'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Object.keys(bg.store), []);
});

test('falls back to the Flow API token', async () => {
  const bg = load(() => json(RUNS));
  bg.request('https://emea.api.flow.microsoft.com/providers/x', fakeJwt('https://service.flow.microsoft.com/'));
  await new Promise((r) => setImmediate(r));
  const res = await bg.send({ type: 'getRuns', env: ENV, flowId: FLOW });
  assert.equal(res.summary.total, 2);
  assert.match(bg.calls[0].url, /^https:\/\/emea\.api\.flow\.microsoft\.com\/providers\/Microsoft\.ProcessSimple\/environments\/aaaabbbb-[^/]+\/flows\/0a1b2c3d-[^/]+\/runs\?api-version=2016-11-01/);
});

test('a 401 drops the token', async () => {
  const bg = load(() => json({}, 401));
  bg.request('https://x1.environment.api.powerplatform.com/a', fakeJwt('https://api.powerplatform.com'));
  await new Promise((r) => setImmediate(r));
  const res = await bg.send({ type: 'getRuns', env: ENV, flowId: FLOW });
  assert.equal(res.error, 'auth');
  assert.equal(bg.store['token.pp'], undefined);
});

test('a nextLink to another host is refused', async () => {
  const bg = load((url) => url.includes('evil') ? json({ value: [] }) : json({ value: [], nextLink: 'https://evil.example/steal' }));
  bg.request('https://x1.environment.api.powerplatform.com/a', fakeJwt('https://api.powerplatform.com'));
  await new Promise((r) => setImmediate(r));
  const res = await bg.send({ type: 'listFlows', env: ENV });
  assert.equal(res.error, 'bad-host');
  assert.ok(bg.calls.every((c) => !c.url.includes('evil')));
});

test('rejects bad input and foreign senders', async () => {
  const bg = load(() => json(RUNS));
  assert.equal((await bg.send({ type: 'getRuns', env: '../x', flowId: FLOW })).error, 'bad-input');
  assert.equal((await bg.send({ type: 'getRuns', env: ENV, flowId: 'nope' })).error, 'bad-input');
  assert.equal(bg.listeners.message({ type: 'status' }, { id: 'ext', tab: {}, url: 'https://evil.example/' }, () => {}), false);
});
