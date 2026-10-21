import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const config = { payhubToken: 'test-payhub-secret', adminKey: 'test-admin-secret' };
const payload = { merchantRef: 'RR-2610-00015', orderNumber: '00012345', amount: 1992000, currency: 'VND', reason: 'CUSTOMER_RETURN' };
async function setup(t, options = {}) {
  const url = await serve(t, createApp({ ...config, ...options }));
  const request = async (headers = {}, body = payload) => {
    const response = await fetch(`${url}/v1/refunds`, { method: 'POST', headers: { Authorization: `Bearer ${config.payhubToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1', ...headers }, body: JSON.stringify(body) });
    return { code: response.status, body: await response.json() };
  };
  const trace = async (testId = 'default') => (await fetch(`${url}/__mock/attempts?testId=${testId}`, { headers: { 'X-Admin-Key': config.adminKey } })).json();
  return { url, request, trace };
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

test('startup requires distinct configured credentials', () => {
  assert.throws(() => createApp({ payhubToken: '', adminKey: '' }));
  assert.throws(() => createApp({ payhubToken: 'same', adminKey: 'same' }));
});
