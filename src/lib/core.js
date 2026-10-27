// Pure helpers shared by the service worker, the content script and the tests.
// Loaded as a classic script (importScripts / content_scripts), so it attaches
// to globalThis instead of using ES module exports.
(function (root) {
  'use strict';

  const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const FLOW_LINK_RE = new RegExp('/(?:flows|cloudflows)/(' + GUID + ')', 'i');
  const FLOW_DETAIL_RE = new RegExp('/(?:flows|cloudflows)/' + GUID + '(?:[/?#]|$)', 'i');
  const GUID_RE = new RegExp('^' + GUID + '$', 'i');
  const ENV_RE = /\/environments\/([^/?#]+)/i;
  const ENV_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

  const STATUS_TONE = {
    Succeeded: 'ok',
    Failed: 'fail',
    TimedOut: 'fail',
    Running: 'run',
    Waiting: 'run',
    Suspended: 'run',
    Cancelled: 'cancel',
    Skipped: 'cancel',
  };

  function parseEnvironmentId(url) {
    const m = ENV_RE.exec(url || '');
    if (!m) return null;
    const env = decodeURIComponent(m[1]);
    return ENV_ID_RE.test(env) ? env : null;
  }

  function flowIdFromHref(href) {
    const m = FLOW_LINK_RE.exec(href || '');
    return m ? m[1].toLowerCase() : null;
  }

  // A single flow's own page already shows its run history; the extension
  // only decorates list pages.
  function isFlowDetailUrl(url) {
    return FLOW_DETAIL_RE.test(url || '');
  }

  function isGuid(value) {
    return typeof value === 'string' && GUID_RE.test(value);
  }

  function isEnvironmentId(value) {
    return typeof value === 'string' && ENV_ID_RE.test(value);
  }

  // Reads the claims of a JWT without verifying it. Only used to check the
  // audience and expiry of a token the portal itself sent.
  function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (_) {
      return null;
    }
  }

  function isFlowServiceAudience(aud) {
    const list = Array.isArray(aud) ? aud : [aud];
    return list.some((a) => /^https:\/\/service\.flow\.microsoft\.com\/?$/i.test(String(a)));
  }

  function isPowerPlatformAudience(aud) {
    const list = Array.isArray(aud) ? aud : [aud];
    return list.some((a) => /^https:\/\/api\.powerplatform\.com\/?$/i.test(String(a)));
  }

  // Power Platform API host for an environment: the id lower-cased without
  // dashes, with a dot before the last two characters
  // ("Default-1a2b...9f" -> "default1a2b....9f.environment.api.powerplatform.com").
  function environmentApiOrigin(env) {
    const id = String(env).toLowerCase().replace(/-/g, '');
    return 'https://' + id.slice(0, -2) + '.' + id.slice(-2) + '.environment.api.powerplatform.com';
  }

  function normalizeRun(raw) {
    const p = (raw && raw.properties) || {};
    const start = p.startTime ? Date.parse(p.startTime) : NaN;
    const end = p.endTime ? Date.parse(p.endTime) : NaN;
    const error = p.error || {};
    return {
      name: raw && raw.name,
      status: p.status || 'Unknown',
      startTime: p.startTime || null,
      endTime: p.endTime || null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
      trigger: (p.trigger && p.trigger.name) || null,
      errorCode: error.code || p.code || null,
      errorMessage: error.message || null,
    };
  }

  // runs: normalized runs, newest first (the API's order).
  function summarizeRuns(runs) {
    const summary = { total: runs.length, ok: 0, fail: 0, run: 0, cancel: 0, other: 0, last: null, lastFailure: null, recent: [] };
    for (const r of runs) {
      summary[statusTone(r.status)] += 1;
      if (!summary.lastFailure && statusTone(r.status) === 'fail') summary.lastFailure = r;
    }
    summary.last = runs[0] || null;
    summary.recent = runs.slice(0, 10);
    return summary;
  }

  function statusTone(status) {
    return STATUS_TONE[status] || 'other';
  }

  function formatRelative(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round(((now == null ? Date.now() : now) - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '';
    if (ms < 1000) return ms + ' ms';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function runUrl(env, flowId, runName) {
    return 'https://make.powerautomate.com/environments/' + encodeURIComponent(env) +
      '/flows/' + encodeURIComponent(flowId) + '/runs/' + encodeURIComponent(runName);
  }

  function runHistoryUrl(env, flowId) {
    return 'https://make.powerautomate.com/environments/' + encodeURIComponent(env) +
      '/flows/' + encodeURIComponent(flowId) + '/details';
  }

  const api = {
    parseEnvironmentId,
    flowIdFromHref,
    isFlowDetailUrl,
    isGuid,
    isEnvironmentId,
    decodeJwtPayload,
    isFlowServiceAudience,
    isPowerPlatformAudience,
    environmentApiOrigin,
    normalizeRun,
    summarizeRuns,
    statusTone,
    formatRelative,
    formatDuration,
    runUrl,
    runHistoryUrl,
  };

  root.FlowRunLens = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
