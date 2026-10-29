import test from 'node:test';
import express from 'express';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRefundEventLog } from '../src/refund-event-log.js';

const config = { payhubToken: 'test-payhub-secret', adminKey: 'test-admin-secret',
  clientId: 'test-client', clientSecret: 'test-client-secret' };
const payload = { merchantRef: 'RR-2610-00015', orderNumber: '00012345', amount: 1992000, currency: 'VND', reason: 'CUSTOMER_RETURN' };
async function setup(t, options = {}) {
  const received = [];
  const receiver = express();
  receiver.use('/services/oauth2/token', express.urlencoded({ extended: false }));
  receiver.post('/services/oauth2/token', (req, res) => {
    if (req.body.client_id !== 'salesforce-client' || req.body.client_secret !== 'salesforce-secret') {
      return res.status(401).json({ error: 'invalid_client' });
    }
    res.json({ access_token: 'salesforce-private-token', token_type: 'Bearer' });
  });
  receiver.use(express.text({ type: 'application/json' }));
  receiver.post('/callback', (req, res) => {
    received.push({ raw: req.body, body: JSON.parse(req.body), authorization: req.get('Authorization'), at: performance.now() });
    if (options.callbackHandler) options.callbackHandler(req, res);
    else res.sendStatus(204);
  });
  const receiverUrl = await serve(t, receiver);
  const app = createApp({ ...config, timeoutMs: 80, callbackUrl: `${receiverUrl}/callback`,
    salesforceClientId: 'salesforce-client', salesforceClientSecret: 'salesforce-secret', ...options });
  t.after(() => app.locals.dispose());
  const url = await serve(t, app);
  const request = async (headers = {}, body = payload) => {
    const response = await fetch(`${url}/v1/refunds`, { method: 'POST', headers: { Authorization: `Bearer ${config.payhubToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1', ...headers }, body: JSON.stringify(body) });
    return { code: response.status, body: await response.json() };
  };
  const trace = async (testId = 'default') => (await fetch(`${url}/__mock/attempts?testId=${testId}`, { headers: { 'X-Admin-Key': config.adminKey } })).json();
  const transaction = async (merchantRef = payload.merchantRef, testId = 'default') => {
    const query = new URLSearchParams({ merchantRef, testId });
    const response = await fetch(`${url}/__mock/transactions?${query}`, { headers: { 'X-Admin-Key': config.adminKey } });
    return { code: response.status, body: await response.json() };
  };
  return { url, request, trace, transaction, received };
}

export async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('health endpoint', async t => {
  const url = await serve(t, createApp(config));
  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('refund event snapshot is admin-only and bounded by limit', async t => {
  const eventLog = createRefundEventLog();
  eventLog.setSubscription({ state: 'subscribed' });
  eventLog.record({ replayId: '1', outcome: 'COMPLETED' });
  eventLog.record({ replayId: '2', outcome: 'REFUND_FAILED' });
  const url = await serve(t, createApp({ ...config, refundEventLog: eventLog }));

  assert.equal((await fetch(`${url}/__mock/refund-events`)).status, 401);
  assert.equal((await fetch(`${url}/__mock/refund-events?limit=0`, {
    headers: { 'X-Admin-Key': config.adminKey },
  })).status, 400);

  const response = await fetch(`${url}/__mock/refund-events?limit=1`, {
    headers: { 'X-Admin-Key': config.adminKey },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text();
  assert.match(text, /\n  "subscription": \{/);
  assert.match(text, /\n    "state": "subscribed"/);
  const body = JSON.parse(text);
  assert.equal(body.subscription.state, 'subscribed');
  assert.equal(body.retainedCount, 2);
  assert.deepEqual(body.events, [{ replayId: '2', outcome: 'REFUND_FAILED' }]);
});

test('refund event SSE endpoint streams the retained tail and new events', async t => {
  const eventLog = createRefundEventLog();
  const url = await serve(t, createApp({ ...config, refundEventLog: eventLog }));

  const response = await fetch(`${url}/__mock/refund-events/tail`, {
    headers: { 'X-Admin-Key': config.adminKey },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /event: subscription/);
  assert.match(first, /data: \{\ndata:   "state": "disabled"/);

  eventLog.record({ replayId: '10', requestNumber: 'RR-DEMO' });
  const next = decoder.decode((await reader.read()).value);
  assert.match(next, /event: refund/);
  assert.match(next, /data:   "requestNumber": "RR-DEMO"/);
  await reader.cancel();
});

test('refund event SSE endpoint supports a bounded REST Client tail', async t => {
  const url = await serve(t, createApp(config));
  const headers = { 'X-Admin-Key': config.adminKey };

  assert.equal((await fetch(`${url}/__mock/refund-events/tail?durationMs=0`, {
    headers,
  })).status, 400);

  const response = await fetch(`${url}/__mock/refund-events/tail?durationMs=20`, {
    headers,
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: subscription/);
});

test('OAuth client credentials return a bearer token usable for refunds', async t => {
  const { url, request, trace } = await setup(t);
  const response = await fetch(`${url}/v1/token`, { method: 'POST', body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret,
  }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Pragma'), 'no-cache');
  const token = await response.json();
  assert.deepEqual(token, { access_token: config.payhubToken, token_type: 'Bearer' });
  assert.equal((await trace()).attempts.length, 0);
  const refund = await request({ Authorization: `${token.token_type} ${token.access_token}` });
  assert.equal(refund.code, 200);
  assert.equal(refund.body.status, 'SUCCESS');
});

test('OAuth client credentials support form-encoded HTTP Basic authentication', async t => {
  const clientId = 'client +:/';
  const clientSecret = 'secret +:%';
  const { url } = await setup(t, { clientId, clientSecret });
  const encode = value => new URLSearchParams({ v: value }).toString().slice(2);
  const basic = Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64');
  const response = await fetch(`${url}/v1/token`, { method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: config.payhubToken, token_type: 'Bearer' });
});

test('OAuth errors reject invalid credentials, grants, scope and malformed requests safely', async t => {
  const { url, trace } = await setup(t);
  const valid = { grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret };
  for (const [body, headers, code, error] of [
    [new URLSearchParams(), {}, 400, 'invalid_client'],
    [new URLSearchParams({ ...valid, client_id: 'wrong' }), {}, 400, 'invalid_client'],
    [new URLSearchParams({ ...valid, client_secret: 'wrong' }), {}, 400, 'invalid_client'],
    [new URLSearchParams({ grant_type: 'client_credentials' }), { Authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, 401, 'invalid_client'],
    [new URLSearchParams({ grant_type: 'client_credentials' }), { Authorization: 'Bearer wrong' }, 401, 'invalid_client'],
    [new URLSearchParams(valid), { Authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, 400, 'invalid_request'],
    [new URLSearchParams({ ...valid, grant_type: '' }), {}, 400, 'invalid_request'],
    [new URLSearchParams({ ...valid, grant_type: 'password' }), {}, 400, 'unsupported_grant_type'],
    [new URLSearchParams({ ...valid, scope: 'refunds' }), {}, 400, 'invalid_scope'],
    [new URLSearchParams([...Object.entries(valid), ['grant_type', 'password']]), {}, 400, 'invalid_request'],
    [JSON.stringify(valid), { 'Content-Type': 'application/json' }, 400, 'invalid_request'],
    [new URLSearchParams({ ...valid, extra: 'x'.repeat(17000) }), {}, 413, 'invalid_request'],
  ]) {
    const response = await fetch(`${url}/v1/token`, { method: 'POST', headers, body });
    assert.equal(response.status, code);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    if (code === 401) assert.equal(response.headers.get('WWW-Authenticate'), 'Basic realm="PayHub"');
    assert.deepEqual(await response.json(), { error });
  }
  const response = await fetch(`${url}/v1/token`, { method: 'POST' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_request' });
  assert.equal((await trace()).attempts.length, 0);
});

test('OAuth credentials are optional together; unconfigured token endpoint stays closed', async t => {
  assert.throws(() => createApp({ ...config, clientId: '' }));
  assert.throws(() => createApp({ ...config, clientSecret: '' }));
  const { url, request } = await setup(t, { clientId: '', clientSecret: '' });
  const response = await fetch(`${url}/v1/token`, { method: 'POST' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  assert.equal((await request()).code, 200);
});


test('default SUCCESS and stable accepted response', async t => {
  const { request, trace } = await setup(t);
  const first = await request();
  assert.equal(first.code, 200);
  assert.equal(first.body.status, 'SUCCESS');
  assert.match(first.body.refundId, /^PH-RF-/);
  assert.deepEqual(await request(), first);
  assert.deepEqual(await request({ 'Idempotency-Key': 'key-2' }), first);
  const log = await trace();
  assert.equal(log.acceptedCount, 1);
  assert.equal(log.attempts.length, 3);
  assert.equal(log.attempts[1].replayed, true);
});

test('conflicting key and merchant payloads', async t => {
  const { request, trace } = await setup(t);
  await request();
  assert.equal((await request({}, { ...payload, amount: 1 })).code, 409);
  assert.equal((await request({ 'Idempotency-Key': 'another' }, { ...payload, amount: 1 })).code, 409);
  assert.equal((await trace()).acceptedCount, 1);
});

test('concurrent duplicate keys and merchant references accept only once', async t => {
  const { request, trace } = await setup(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => request({ 'Idempotency-Key': `key-${i % 5}` })));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await trace()).acceptedCount, 1);
});

test('test namespaces isolate key and merchant reference', async t => {
  const { request, trace } = await setup(t);
  const a = await request({ 'X-Mock-Test-Id': 'a' });
  const b = await request({ 'X-Mock-Test-Id': 'b' });
  assert.notEqual(a.body.refundId, b.body.refundId);
  assert.equal((await trace('a')).attempts.length, 1);
  assert.equal((await trace('b')).acceptedCount, 1);
  assert.equal((await trace('unused')).attempts.length, 0);
});

test('authentication and payload validation', async t => {
  const { request } = await setup(t);
  for (const Authorization of ['', 'Bearer wrong', 'Basic test-payhub-secret']) {
    assert.equal((await request({ Authorization })).code, 401);
  }
  assert.equal((await request({ 'Idempotency-Key': '' })).code, 400);
  for (const amount of [0, -1, 1.2, '12', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.deepEqual(await request({}, { ...payload, amount }), { code: 422, body: { errorCode: 'INVALID_AMOUNT' } });
  }
  assert.equal((await request({}, { ...payload, currency: 'USD' })).code, 422);
  for (const body of [null, [], {}, { ...payload, merchantRef: '' }, { ...payload, extra: 'private' }]) {
    assert.equal((await request({}, body)).code, 400);
  }
});

test('protected attempt tracing excludes secrets and private payload', async t => {
  const { request, trace, url } = await setup(t);
  await request();
  await request({ Authorization: 'Bearer private-invalid-token' });
  for (const key of ['', 'wrong']) {
    assert.equal((await fetch(`${url}/__mock/attempts`, { headers: { 'X-Admin-Key': key } })).status, 401);
  }
  const log = await trace();
  assert.deepEqual(log.attempts.map(x => x.responseCode), [200, 401]);
  for (const attempt of log.attempts) {
    assert.ok(attempt.durationMs >= 0);
    assert.ok(Date.parse(attempt.startedAt));
    assert.ok(Date.parse(attempt.finishedAt));
  }
  for (const secret of [...Object.values(config), 'private-invalid-token', payload.merchantRef, payload.orderNumber, payload.reason]) {
    assert.ok(!JSON.stringify(log).includes(secret));
  }
});

test('protected transaction trace correlates a refund without exposing credentials', async t => {
  const { request, transaction } = await setup(t);
  const accepted = await request();
  await request();

  const result = await transaction();
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.payment, {
    refundId: accepted.body.refundId,
    initialStatus: 'SUCCESS',
    finalStatus: 'SUCCESS',
    scenario: 'SUCCESS',
    acceptedAt: result.body.payment.acceptedAt,
  });
  assert.ok(Date.parse(result.body.payment.acceptedAt));
  assert.equal(result.body.merchantRef, payload.merchantRef);
  assert.deepEqual(result.body.attempts.map(attempt => ({
    responseCode: attempt.responseCode,
    accepted: attempt.accepted,
    replayed: attempt.replayed,
  })), [
    { responseCode: 200, accepted: true, replayed: false },
    { responseCode: 200, accepted: false, replayed: true },
  ]);
  assert.deepEqual(result.body.callbackAttempts, []);
  for (const secret of Object.values(config)) assert.ok(!JSON.stringify(result.body).includes(secret));
});

test('transaction trace shows pre-acceptance failures by merchant reference', async t => {
  const { request, transaction } = await setup(t);
  assert.equal((await request({ 'X-Mock-Scenario': 'HTTP_503' })).code, 503);

  const result = await transaction();
  assert.equal(result.code, 200);
  assert.equal(result.body.payment, null);
  assert.equal(result.body.attempts.length, 1);
  assert.equal(result.body.attempts[0].scenario, 'HTTP_503');
  assert.equal(result.body.attempts[0].responseCode, 503);
});

test('transaction trace requires admin access and valid lookup values', async t => {
  const { url, transaction } = await setup(t);
  const endpoint = `${url}/__mock/transactions`;
  assert.equal((await fetch(`${endpoint}?merchantRef=${payload.merchantRef}`)).status, 401);
  assert.equal((await fetch(`${endpoint}?merchantRef=`, { headers: { 'X-Admin-Key': config.adminKey } })).status, 400);
  assert.equal((await fetch(`${endpoint}?merchantRef=${payload.merchantRef}&testId=`, { headers: { 'X-Admin-Key': config.adminKey } })).status, 400);
  assert.deepEqual(await transaction('RR-UNKNOWN'), {
    code: 404,
    body: { errorCode: 'TRANSACTION_NOT_FOUND' },
  });
});

test('admin can set and reset the default scenario for new requests', async t => {
  const { url, request } = await setup(t);
  const endpoint = `${url}/__mock/scenario`;
  const admin = { 'X-Admin-Key': config.adminKey };

  assert.equal((await fetch(endpoint)).status, 401);
  assert.deepEqual(await (await fetch(endpoint, { headers: admin })).json(), { scenario: 'SUCCESS' });

  const updated = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'TIMEOUT' }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { scenario: 'TIMEOUT' });
  assert.equal((await request()).code, 504);
  assert.equal((await request({ 'X-Mock-Test-Id': 'another' })).code, 504);
  assert.equal((await request({
    'Idempotency-Key': 'success-key',
    'X-Mock-Test-Id': 'explicit',
    'X-Mock-Scenario': 'SUCCESS',
  })).code, 200);

  const reset = await fetch(endpoint, { method: 'DELETE', headers: admin });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { scenario: 'SUCCESS' });
  assert.equal((await request({
    'Idempotency-Key': 'new-key',
    'X-Mock-Test-Id': 'reset',
  })).code, 200);
});

test('default scenario validation cannot alter existing request sequences', async t => {
  const { url, request } = await setup(t);
  const endpoint = `${url}/__mock/scenario`;
  const headers = { 'X-Admin-Key': config.adminKey, 'Content-Type': 'application/json' };

  assert.equal((await request({ 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS' })).code, 503);
  for (const body of [{ scenario: 'UNKNOWN' }, {}, { scenario: 'TIMEOUT', extra: true }, []]) {
    const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { errorCode: 'INVALID_SCENARIO' });
  }
  await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ scenario: 'TIMEOUT' }) });
  assert.equal((await request()).code, 503);
  assert.equal((await request()).code, 200);
});

test('startup requires distinct configured credentials', () => {
  assert.throws(() => createApp({ payhubToken: '', adminKey: '' }));
  assert.throws(() => createApp({ payhubToken: 'same', adminKey: 'same' }));
});


for (const [scenario, codes, status] of [
  ['SUCCESS', [200], 'SUCCESS'], ['PENDING_SUCCESS', [200], 'PENDING'],
  ['PENDING_FAILED', [200], 'PENDING'], ['DUPLICATE_CALLBACK', [200], 'PENDING'],
  ['INVALID_AMOUNT', [422, 422]], ['HTTP_500', [500, 500]], ['HTTP_503', [503, 503]],
  ['RETRY_503_3', [503, 503, 503, 200], 'SUCCESS'],
  ['RETRY_503_2_SUCCESS', [503, 503, 200], 'SUCCESS'],
]) {
  test(`scenario ${scenario} preserves sequence without repeat headers`, async t => {
    const { request, trace } = await setup(t);
    for (const [i, code] of codes.entries()) {
      const result = await request(i === 0 ? { 'X-Mock-Scenario': scenario } : {});
      assert.equal(result.code, code);
      if (code === 200) assert.equal(result.body.status, status);
    }
    assert.deepEqual((await trace()).attempts.map(x => x.responseCode), codes);
    assert.equal((await trace()).acceptedCount, codes.includes(200) ? 1 : 0);
  });
}

test('scenario conflict cannot overwrite pre-acceptance state; accepted result always replays', async t => {
  const { request, trace } = await setup(t);
  assert.equal((await request({ 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS' })).code, 503);
  assert.equal((await request({ 'X-Mock-Scenario': 'SUCCESS' })).code, 409);
  assert.equal((await request()).code, 503);
  const accepted = await request();
  assert.equal(accepted.body.status, 'SUCCESS');
  assert.deepEqual(await request({ 'X-Mock-Scenario': 'HTTP_500' }), accepted);
  assert.deepEqual(await request({ 'X-Mock-Scenario': 'unknown' }), accepted);
  assert.deepEqual((await trace()).attempts.slice(0, 4).map(x => x.scenarioAttempt), [1, undefined, 2, 3]);
});

test('retry counters isolate test runs and keys and consume each concurrent HTTP attempt', async t => {
  const { request, trace } = await setup(t);
  assert.equal((await request({ 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS', 'X-Mock-Test-Id': 'a' })).code, 503);
  assert.equal((await request({ 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS', 'X-Mock-Test-Id': 'b' })).code, 503);
  assert.equal((await request({ 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS', 'X-Mock-Test-Id': 'a', 'Idempotency-Key': 'second' })).code, 503);
  assert.equal((await request({ 'X-Mock-Test-Id': 'a' })).code, 503);
  assert.equal((await request({ 'X-Mock-Test-Id': 'b' })).code, 503);
  assert.equal((await trace('a')).acceptedCount, 0);
  const responses = await Promise.all(Array.from({ length: 6 }, () => request({ 'X-Mock-Test-Id': 'concurrent', 'X-Mock-Scenario': 'RETRY_503_2_SUCCESS' })));
  assert.deepEqual(responses.map(x => x.code).sort(), [200, 200, 200, 200, 503, 503]);
  assert.equal((await trace('concurrent')).acceptedCount, 1);
});

test('invalid mock headers do not establish scenario', async t => {
  const { request, trace } = await setup(t);
  for (const value of ['BOGUS', 'success', 'SUCCESS, HTTP_500', '']) {
    assert.equal((await request({ 'X-Mock-Scenario': value })).code, 400);
  }
  for (const name of ['X-Mock-Delay-Ms', 'X-Mock-Callback-Delay-Ms']) {
    for (const value of ['-1', 'NaN', '1.5', '120001', '']) assert.equal((await request({ [name]: value })).code, 400);
  }
  assert.equal((await request({ 'X-Mock-Test-Id': '' })).code, 400);
  assert.equal((await trace()).acceptedCount, 0);
  assert.equal((await request()).body.status, 'SUCCESS');
});

test('TIMEOUT is delayed and never accepted, including disconnected retries', async t => {
  const { request, trace, url } = await setup(t);
  const start = performance.now();
  assert.equal((await request({ 'X-Mock-Scenario': 'TIMEOUT' })).code, 504);
  assert.ok(performance.now() - start >= 70);
  const controller = new AbortController();
  const pending = fetch(`${url}/v1/refunds`, { method: 'POST', headers: { Authorization: `Bearer ${config.payhubToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify(payload), signal: controller.signal });
  await waitFor(async () => (await trace()).attempts.length === 2);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await waitFor(async () => (await trace()).attempts[1].disconnected);
  const log = await trace();
  assert.equal(log.acceptedCount, 0);
  assert.equal(log.attempts[1].responseCode, null);
  assert.equal(log.attempts[1].scenarioAttempt, 2);
});

async function waitFor(condition) {
  const end = performance.now() + 2000;
  while (!(await condition())) {
    assert.ok(performance.now() < end, 'condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('SUCCESS_THEN_TIMEOUT accepts before lost response and retries immediately replay one refund', async t => {
  const { request, trace, url } = await setup(t, { timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = fetch(`${url}/v1/refunds`, { method: 'POST', headers: { Authorization: `Bearer ${config.payhubToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1', 'X-Mock-Scenario': 'SUCCESS_THEN_TIMEOUT' }, body: JSON.stringify(payload), signal: controller.signal });
  await waitFor(async () => (await trace()).acceptedCount === 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const replay = await request();
  assert.equal(replay.body.status, 'SUCCESS');
  assert.deepEqual(await request({ 'X-Mock-Scenario': 'HTTP_503' }), replay);
  const log = await trace();
  assert.equal(log.acceptedCount, 1);
  assert.equal(log.refunds[0].refundId, replay.body.refundId);
  assert.equal(log.attempts[1].replayed, true);
});

test('X-Mock-Delay-Ms delays response but acceptance remains atomic', async t => {
  const { request, trace } = await setup(t);
  const start = performance.now();
  const response = await request({ 'X-Mock-Delay-Ms': '40' });
  assert.equal(response.code, 200);
  assert.ok(performance.now() - start >= 35);
  assert.ok((await trace()).attempts[0].durationMs >= 35);
});


for (const scenario of ['PENDING_SUCCESS', 'PENDING_FAILED', 'DUPLICATE_CALLBACK']) {
  test(`${scenario} delivers authenticated final callbacks once per acceptance`, async t => {
    const { request, trace, transaction, received } = await setup(t);
    const started = performance.now();
    const pending = await request({ 'X-Mock-Scenario': scenario, 'X-Mock-Callback-Delay-Ms': '40' });
    assert.equal(pending.body.status, 'PENDING');
    const count = scenario === 'DUPLICATE_CALLBACK' ? 2 : 1;
    await waitFor(async () => (await trace()).callbackAttempts.filter(x => x.outcome === 'DELIVERED').length === count);
    assert.equal(received.length, count);
    const status = scenario === 'PENDING_FAILED' ? 'FAILED' : 'SUCCESS';
    for (const callback of received) {
      assert.equal(callback.authorization, 'Bearer salesforce-private-token');
      assert.equal(callback.body.refundId, pending.body.refundId);
      assert.equal(callback.body.merchantRef, payload.merchantRef);
      assert.equal(callback.body.status, status);
      assert.ok(Date.parse(callback.body.processedAt));
      assert.ok(callback.at - started >= 35);
      assert.deepEqual(Object.keys(callback.body).sort(), ['refundId', 'merchantRef', 'status', 'processedAt', ...(status === 'FAILED' ? ['failureReason'] : [])].sort());
      if (status === 'FAILED') assert.equal(callback.body.failureReason, 'CARD_CLOSED');
    }
    if (count === 2) assert.equal(received[0].raw, received[1].raw);
    assert.deepEqual(await request({ 'X-Mock-Scenario': 'SUCCESS' }), pending);
    assert.deepEqual(await request({ 'Idempotency-Key': 'second-key' }), pending);
    const log = await trace();
    assert.equal(log.acceptedCount, 1);
    assert.equal(log.refunds[0].finalStatus, status);
    assert.equal(log.callbackAttempts.length, count);
    for (const callback of log.callbackAttempts) {
      assert.equal(callback.responseCode, 204);
      assert.ok(callback.durationMs >= 0);
      assert.ok(Date.parse(callback.finishedAt));
    }
    const demo = await transaction();
    assert.equal(demo.body.payment.initialStatus, 'PENDING');
    assert.equal(demo.body.payment.finalStatus, status);
    assert.equal(demo.body.callbackAttempts.length, count);
    for (const secret of ['salesforce-private-token', payload.merchantRef, payload.orderNumber]) {
      assert.ok(!JSON.stringify(log).includes(secret));
    }
  });
}

test('callback HTTP errors and sensitive response bodies are recorded safely', async t => {
  const { request, trace } = await setup(t, { callbackHandler: (_req, res) => res.status(401).send('salesforce-private-token private-error-body') });
  await request({ 'X-Mock-Scenario': 'PENDING_SUCCESS', 'X-Mock-Callback-Delay-Ms': '0' });
  await waitFor(async () => (await trace()).callbackAttempts[0]?.outcome === 'HTTP_ERROR');
  const log = await trace();
  assert.equal(log.callbackAttempts[0].responseCode, 401);
  assert.ok(!JSON.stringify(log).includes('salesforce-private-token'));
  assert.ok(!JSON.stringify(log).includes('private-error-body'));
});

test('callback redirects are never followed', async t => {
  let redirected = 0;
  const destination = express();
  destination.all('/leak', (_req, res) => { redirected += 1; res.sendStatus(204); });
  const target = await serve(t, destination);
  const { request, trace } = await setup(t, { callbackHandler: (_req, res) => res.redirect(307, `${target}/leak`) });
  await request({ 'X-Mock-Scenario': 'PENDING_SUCCESS', 'X-Mock-Callback-Delay-Ms': '0' });
  await waitFor(async () => (await trace()).callbackAttempts[0]?.outcome === 'HTTP_ERROR');
  assert.equal((await trace()).callbackAttempts[0].responseCode, 307);
  assert.equal(redirected, 0);
});

test('callback network failures and timeouts do not change accepted response', async t => {
  for (const callbackHandler of [(_req, res) => res.destroy(), () => {}]) {
    const { request, trace } = await setup(t, { callbackHandler, callbackTimeoutMs: 30 });
    const first = await request({ 'X-Mock-Scenario': 'PENDING_SUCCESS', 'X-Mock-Callback-Delay-Ms': '0' });
    await waitFor(async () => ['NETWORK_ERROR', 'TIMEOUT'].includes((await trace()).callbackAttempts[0]?.outcome));
    const log = await trace();
    assert.equal(log.callbackAttempts[0].outcome, callbackHandler.length ? 'NETWORK_ERROR' : 'TIMEOUT');
    assert.equal(log.callbackAttempts[0].responseCode, null);
    assert.deepEqual(await request(), first);
  }
});

test('PENDING without callback configuration fails before acceptance', async t => {
  const { request, trace } = await setup(t, { callbackUrl: '', salesforceClientId: '', salesforceClientSecret: '' });
  assert.deepEqual(await request({ 'X-Mock-Scenario': 'PENDING_SUCCESS' }), { code: 503, body: { errorCode: 'CALLBACK_NOT_CONFIGURED' } });
  assert.equal((await trace()).acceptedCount, 0);
});

test('callback configuration rejects unsafe URLs and missing credentials', () => {
  for (const callbackUrl of ['http://example.com/callback', 'https://user:pass@example.com', 'file:///tmp/out', 'not-a-url', 'https://example.com/#fragment']) {
    assert.throws(() => createApp({ ...config, callbackUrl, salesforceClientId: 'id', salesforceClientSecret: 'secret' }));
  }
  assert.throws(() => createApp({ ...config, callbackUrl: 'https://example.com', salesforceClientId: '', salesforceClientSecret: '' }));
  assert.doesNotThrow(() => createApp({ ...config, callbackUrl: '', salesforceClientId: 'id', salesforceClientSecret: 'secret' }));
});

test('malformed JSON, large payloads and unsupported content types are safely traced', async t => {
  const { url, trace } = await setup(t);
  for (const [body, type, code] of [
    ['{"private":', 'application/json', 400],
    [JSON.stringify({ secret: 'x'.repeat(17000) }), 'application/json', 413],
    [JSON.stringify(payload), 'text/plain', 415],
  ]) {
    const response = await fetch(`${url}/v1/refunds`, { method: 'POST', headers: {
      Authorization: `Bearer ${config.payhubToken}`, 'Idempotency-Key': 'key-1', 'Content-Type': type,
    }, body });
    assert.equal(response.status, code);
    assert.ok(!(await response.text()).includes('private'));
  }
  const log = await trace();
  assert.deepEqual(log.attempts.map(x => x.responseCode), [400, 413, 415]);
  assert.equal(log.acceptedCount, 0);
});

test('canonical payload is independent of JSON field order', async t => {
  const { request } = await setup(t);
  const first = await request();
  assert.deepEqual(await request({}, Object.fromEntries(Object.entries(payload).reverse())), first);
});

test('a rejected payload does not reserve key or merchant reference', async t => {
  const { request, trace } = await setup(t);
  assert.equal((await request({}, { ...payload, amount: 0 })).code, 422);
  assert.equal((await request()).code, 200);
  assert.equal((await trace()).acceptedCount, 1);
});

test('second key with prior failures replays an accepted merchant without another refund', async t => {
  const { request, trace } = await setup(t);
  assert.equal((await request({ 'X-Mock-Scenario': 'HTTP_500' })).code, 500);
  const accepted = await request({ 'Idempotency-Key': 'second-key' });
  assert.equal(accepted.body.status, 'SUCCESS');
  assert.deepEqual(await request({ 'X-Mock-Scenario': 'TIMEOUT' }), accepted);
  assert.equal((await trace()).acceptedCount, 1);
});

test('concurrent delayed PENDING duplicates schedule one callback', async t => {
  const { request, trace, received } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => request({
    'Idempotency-Key': `pending-${i % 3}`, 'X-Mock-Scenario': 'PENDING_SUCCESS',
    'X-Mock-Delay-Ms': '20', 'X-Mock-Callback-Delay-Ms': '20',
    'X-Mock-Callback-Url': 'http://untrusted.invalid/steal',
  })));
  for (const response of responses) assert.deepEqual(response, responses[0]);
  await waitFor(async () => (await trace()).callbackAttempts[0]?.outcome === 'DELIVERED');
  assert.equal((await trace()).acceptedCount, 1);
  assert.equal((await trace()).callbackAttempts.length, 1);
  assert.equal(received.length, 1);
});

test('traces reject malformed testId queries and unknown routes return safe JSON', async t => {
  const { url } = await setup(t);
  for (const query of ['testId=', 'testId=a&testId=b', `testId=${'x'.repeat(101)}`]) {
    assert.equal((await fetch(`${url}/__mock/attempts?${query}`, { headers: { 'X-Admin-Key': config.adminKey } })).status, 400);
  }
  const response = await fetch(`${url}/unknown`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { errorCode: 'NOT_FOUND' });
});
