// Service worker: borrows the maker portal's own bearer token (read from the
// portal's outgoing API requests, kept in memory-only session storage) and
// answers run-history questions from the content script.
//
// Two APIs serve the same Flow data:
// - Power Platform API, https://{env}.environment.api.powerplatform.com/powerautomate/...
//   (what both portals call today; token audience https://api.powerplatform.com)
// - Flow API, https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/...
//   (older; token audience https://service.flow.microsoft.com), used as a fallback.
importScripts('lib/core.js');

const L = self.FlowRunLens;

const RUNS_PER_FLOW = 25;
const RUN_CACHE_TTL_MS = 60 * 1000;
const FLOW_LIST_TTL_MS = 5 * 60 * 1000;
const MAX_PARALLEL = 4;
const MAX_LIST_PAGES = 10;
const PORTAL_HOSTS = new Set(['make.powerautomate.com', 'make.powerapps.com']);
const PORTAL_ORIGINS = new Set([...PORTAL_HOSTS].map((h) => 'https://' + h));

const PP_HOST_RE = /^https:\/\/[a-z0-9.-]+\.(environment|tenant)\.api\.powerplatform\.com$/i;
const FLOW_HOST_RE = /^https:\/\/([a-z0-9-]+\.)?api\.flow\.microsoft\.com$/i;

const SOURCES = {
  pp: {
    key: 'token.pp',
    hostRe: PP_HOST_RE,
    audience: L.isPowerPlatformAudience,
    runsUrl: (env, flowId) => L.environmentApiOrigin(env) + '/powerautomate/flows/' + flowId + '/runs?api-version=1',
    flowsUrl: (env, filter) => L.environmentApiOrigin(env) + "/powerautomate/flows?api-version=1&$top=50&$filter=search('" + filter + "')",
  },
  flow: {
    key: 'token.flow',
    hostRe: FLOW_HOST_RE,
    audience: L.isFlowServiceAudience,
    runsUrl: (env, flowId, origin) => origin + '/providers/Microsoft.ProcessSimple/environments/' + encodeURIComponent(env) +
      '/flows/' + flowId + '/runs?api-version=2016-11-01&$top=' + RUNS_PER_FLOW,
    flowsUrl: (env, filter, origin) => origin + '/providers/Microsoft.ProcessSimple/environments/' + encodeURIComponent(env) +
      "/flows?api-version=2016-11-01&$filter=search('" + filter + "')",
  },
};

// Session storage lives in memory and is cleared when the browser closes.
// Only trusted extension contexts can read it, not content scripts.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const lastSeen = {};

chrome.webRequest.onBeforeSendHeaders.addListener(
  captureToken,
  {
    urls: [
      'https://*.api.powerplatform.com/*',
      'https://api.flow.microsoft.com/*',
      'https://*.api.flow.microsoft.com/*',
    ],
  },
  ['requestHeaders', 'extraHeaders']
);

function captureToken(details) {
  // Only learn from the maker portals' own requests (which may come from a
  // page service worker, so tabId is not a reliable filter), never our own.
  if (!details.initiator || !PORTAL_ORIGINS.has(details.initiator)) return;
  const header = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'authorization');
  const match = header && /^Bearer\s+(.+)$/i.exec(header.value || '');
  if (!match) return;
  const origin = new URL(details.url).origin;
  for (const [name, source] of Object.entries(SOURCES)) {
    if (!source.hostRe.test(origin) || match[1] === lastSeen[name]) continue;
    const claims = L.decodeJwtPayload(match[1]);
    if (!claims || !claims.exp || !source.audience(claims.aud)) continue;
    lastSeen[name] = match[1];
    chrome.storage.session.set({ [source.key]: { token: match[1], exp: claims.exp, origin } });
  }
}

async function getToken(name) {
  const key = SOURCES[name].key;
  const { [key]: entry } = await chrome.storage.session.get(key);
  if (!entry || entry.exp * 1000 - 60 * 1000 < Date.now()) return null;
  return entry;
}

async function clearToken(name) {
  delete lastSeen[name];
  await chrome.storage.session.remove(SOURCES[name].key);
}

class ApiError extends Error {
  constructor(code, status) {
    super(code + (status ? ' ' + status : ''));
    this.code = code;
    this.status = status || null;
  }
}

// Simple semaphore so a long list does not fire dozens of requests at once.
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

async function apiGet(name, url, retried) {
  const auth = await getToken(name);
  if (!auth) throw new ApiError('auth');
  // Never send the token anywhere but the API it was issued for
  // (nextLink is server-supplied, so it is checked too).
  if (!SOURCES[name].hostRe.test(new URL(url).origin)) throw new ApiError('bad-host');
  const res = await withSlot(() => fetch(url, {
    headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/json' },
    credentials: 'omit',
  }));
  if (res.status === 401) {
    await clearToken(name);
    throw new ApiError('auth', 401);
  }
  if (res.status === 429 && !retried) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return apiGet(name, url, true);
  }
  if (!res.ok) throw new ApiError('http', res.status);
  return res.json();
}

// Tries the Power Platform API first, then the Flow API. An auth error only
// falls through when the next source has a token to try.
async function withSource(call) {
  let lastError = new ApiError('auth');
  for (const name of Object.keys(SOURCES)) {
    const auth = await getToken(name);
    if (!auth) continue;
    try {
      return await call(name, auth.origin);
    } catch (err) {
      lastError = err;
      if (err.code !== 'auth' && !(err.code === 'http' && err.status === 404)) throw err;
    }
  }
  throw lastError;
}

const runCache = new Map();
const flowListCache = new Map();

function cached(cache, key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

function getRunSummary(env, flowId) {
  return cached(runCache, env + '/' + flowId, RUN_CACHE_TTL_MS, () => withSource(async (name, origin) => {
    const body = await apiGet(name, SOURCES[name].runsUrl(env, flowId, origin));
    const runs = (body.value || []).slice(0, RUNS_PER_FLOW).map(L.normalizeRun);
    return L.summarizeRuns(runs);
  }));
}

// Used to match grid rows that carry no flow link (the solution view on
// make.powerapps.com) by display name: the user's own and shared flows.
function listFlows(env) {
  return cached(flowListCache, env, FLOW_LIST_TTL_MS, () => withSource(async (name, origin) => {
    const flows = new Map();
    for (const filter of ['personal', 'team']) {
      let next = SOURCES[name].flowsUrl(env, filter, origin);
      for (let page = 0; next && page < MAX_LIST_PAGES; page += 1) {
        const body = await apiGet(name, next);
        for (const f of body.value || []) {
          const id = String(f.name || '').toLowerCase();
          if (L.isGuid(id)) flows.set(id, { id, displayName: (f.properties && f.properties.displayName) || '' });
        }
        next = body.nextLink || null;
      }
    }
    return [...flows.values()];
  }));
}

function fromPortal(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab) return true; // the toolbar popup
  try {
    return PORTAL_HOSTS.has(new URL(sender.url).hostname);
  } catch (_) {
    return false;
  }
}

async function tokenStatus() {
  const out = {};
  for (const name of Object.keys(SOURCES)) {
    const auth = await getToken(name);
    out[name] = auth ? { host: new URL(auth.origin).hostname, expiresInMin: Math.round((auth.exp * 1000 - Date.now()) / 60000) } : null;
  }
  return out;
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'getRuns': {
      if (!L.isEnvironmentId(msg.env) || !L.isGuid(msg.flowId)) throw new ApiError('bad-input');
      return { summary: await getRunSummary(msg.env, msg.flowId.toLowerCase()) };
    }
    case 'listFlows': {
      if (!L.isEnvironmentId(msg.env)) throw new ApiError('bad-input');
      return { flows: await listFlows(msg.env) };
    }
    case 'clearCache':
      runCache.clear();
      flowListCache.clear();
      return { ok: true };
    case 'status':
      return { tokens: await tokenStatus() };
    case 'forgetToken':
      for (const name of Object.keys(SOURCES)) await clearToken(name);
      runCache.clear();
      flowListCache.clear();
      return { ok: true };
    default:
      throw new ApiError('bad-input');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!fromPortal(sender)) return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: err.code || 'error', status: err.status || null }));
  return true;
});
