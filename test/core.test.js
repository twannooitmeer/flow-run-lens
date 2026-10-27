const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/core.js');

const FLOW = '0a1b2c3d-1111-2222-3333-444455556666';

test('parseEnvironmentId reads both portals', () => {
  assert.equal(L.parseEnvironmentId('https://make.powerautomate.com/environments/Default-abc-123/flows?v=1'), 'Default-abc-123');
  assert.equal(L.parseEnvironmentId('https://make.powerapps.com/environments/7f2e-9a/solutions/x/objects/cloudflows'), '7f2e-9a');
  assert.equal(L.parseEnvironmentId('https://make.powerautomate.com/'), null);
  assert.equal(L.parseEnvironmentId('https://x/environments/bad%3Cscript%3E/flows'), null);
});

test('flowIdFromHref and isFlowDetailUrl', () => {
  assert.equal(L.flowIdFromHref('/environments/e/flows/' + FLOW.toUpperCase() + '/details'), FLOW);
  assert.equal(L.flowIdFromHref('/environments/e/solutions/s/objects/cloudflows/' + FLOW + '/view'), FLOW);
  assert.equal(L.flowIdFromHref('/environments/e/flows'), null);
  assert.equal(L.isFlowDetailUrl('https://make.powerautomate.com/environments/e/flows/' + FLOW + '/details'), true);
  assert.equal(L.isFlowDetailUrl('https://make.powerautomate.com/environments/e/flows/' + FLOW), true);
  assert.equal(L.isFlowDetailUrl('https://make.powerautomate.com/environments/e/flows?tab=shared'), false);
});

test('decodeJwtPayload and audience check', () => {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = b64url({ alg: 'none' }) + '.' + b64url({ aud: 'https://service.flow.microsoft.com/', exp: 123 }) + '.sig';
  const claims = L.decodeJwtPayload(jwt);
  assert.equal(claims.exp, 123);
  assert.equal(L.isFlowServiceAudience(claims.aud), true);
  assert.equal(L.isFlowServiceAudience('https://service.powerapps.com/'), false);
  assert.equal(L.isFlowServiceAudience('https://service.flow.microsoft.com.evil.example/'), false);
  assert.equal(L.decodeJwtPayload('not-a-jwt'), null);
  assert.equal(L.isPowerPlatformAudience('https://api.powerplatform.com'), true);
  assert.equal(L.isPowerPlatformAudience(['https://api.powerplatform.com/']), true);
  assert.equal(L.isPowerPlatformAudience('https://service.flow.microsoft.com/'), false);
});

test('environmentApiOrigin follows the Power Platform API host rule', () => {
  assert.equal(L.environmentApiOrigin('aaaabbbb-cccc-dddd-eeee-ffff00001111'),
    'https://aaaabbbbccccddddeeeeffff000011.11.environment.api.powerplatform.com');
  assert.equal(L.environmentApiOrigin('Default-0a1b2c3d-1111-2222-3333-444455556666'),
    'https://default0a1b2c3d1111222233334444555566.66.environment.api.powerplatform.com');
});

test('normalizeRun and summarizeRuns', () => {
  const raw = [
    { name: 'r3', properties: { status: 'Failed', startTime: '2026-10-27T10:00:00Z', endTime: '2026-10-27T10:00:05Z', error: { code: 'ActionFailed', message: 'boom' } } },
    { name: 'r2', properties: { status: 'Succeeded', startTime: '2026-10-27T09:00:00Z', endTime: '2026-10-27T09:01:00Z' } },
    { name: 'r1', properties: { status: 'Running', startTime: '2026-10-27T08:00:00Z' } },
  ];
  const runs = raw.map(L.normalizeRun);
  assert.deepEqual(runs[0], {
    name: 'r3', status: 'Failed', startTime: '2026-10-27T10:00:00Z', endTime: '2026-10-27T10:00:05Z',
    durationMs: 5000, trigger: null, errorCode: 'ActionFailed', errorMessage: 'boom',
  });
  assert.equal(runs[2].durationMs, null);
  const s = L.summarizeRuns(runs);
  assert.equal(s.total, 3);
  assert.equal(s.ok, 1);
  assert.equal(s.fail, 1);
  assert.equal(s.run, 1);
  assert.equal(s.last.name, 'r3');
  assert.equal(s.lastFailure.name, 'r3');
  assert.equal(L.summarizeRuns([]).last, null);
});

test('formatting helpers', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(L.formatRelative('2026-10-27T11:59:30Z', now), 'just now');
  assert.equal(L.formatRelative('2026-10-27T11:15:00Z', now), '45m ago');
  assert.equal(L.formatRelative('2026-10-27T02:00:00Z', now), '10h ago');
  assert.equal(L.formatRelative('2026-10-20T12:00:00Z', now), '7d ago');
  assert.equal(L.formatDuration(250), '250 ms');
  assert.equal(L.formatDuration(65000), '1m 5s');
  assert.equal(L.formatDuration(null), '');
  assert.equal(L.statusTone('TimedOut'), 'fail');
  assert.equal(L.runUrl('Default-1', FLOW, 'run1'), 'https://make.powerautomate.com/environments/Default-1/flows/' + FLOW + '/runs/run1');
});
