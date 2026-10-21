import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Exercise the actual entry point and its production 11-second delay. The fast
// suite injects shorter delays; this check intentionally takes about 10 seconds.
test('real process exceeds 10s client timeout before/after acceptance', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: '0', PAYHUB_TOKEN: 'integration-payhub', ADMIN_KEY: 'integration-admin',
      SALESFORCE_CALLBACK_URL: '', SALESFORCE_ACCESS_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const deadline = performance.now() + 3000;
  while (!/listening on port (\d+)/.test(output)) {
    assert.ok(performance.now() < deadline, `server startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const url = `http://127.0.0.1:${output.match(/listening on port (\d+)/)[1]}`;
  assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { status: 'ok' });
  const payload = { merchantRef: 'RR-timeout', orderNumber: '123', amount: 100, currency: 'VND', reason: 'CUSTOMER_RETURN' };
  const request = (scenario, signal, includeScenario = true) => fetch(`${url}/v1/refunds`, {
    method: 'POST', headers: { Authorization: 'Bearer integration-payhub', 'Content-Type': 'application/json',
      'Idempotency-Key': 'stable-key', 'X-Mock-Test-Id': scenario,
      ...(includeScenario ? { 'X-Mock-Scenario': scenario } : {}) },
    body: JSON.stringify(payload), signal,
  });
  await Promise.all(['TIMEOUT', 'SUCCESS_THEN_TIMEOUT'].map(async scenario => {
    const started = performance.now();
    await assert.rejects(request(scenario, AbortSignal.timeout(10000)), { name: 'TimeoutError' });
    assert.ok(performance.now() - started >= 9900);
    if (scenario === 'SUCCESS_THEN_TIMEOUT') {
      const replay = await request(scenario, AbortSignal.timeout(1000), false);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).status, 'SUCCESS');
    }
    const log = await (await fetch(`${url}/__mock/attempts?testId=${scenario}`, {
      headers: { 'X-Admin-Key': 'integration-admin' },
    })).json();
    assert.equal(log.acceptedCount, scenario === 'TIMEOUT' ? 0 : 1);
    assert.equal(log.attempts.length, scenario === 'TIMEOUT' ? 1 : 2);
  }));
  for (const secret of ['integration-payhub', 'integration-admin', payload.merchantRef]) assert.ok(!output.includes(secret));
});
