import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('connecting the console loads and refreshes global requests without a selected transaction', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        handlers: {},
        hidden: false,
        textContent: '',
        addEventListener(type, callback) {
          this.handlers[type] = callback;
        },
        focus() {},
        setAttribute() {},
        close() {},
      });
    return elements.get(id);
  }
  element('admin-key').value = 'console-test-admin-key';
  const calls = [];
  const scheduled = [];
  const snapshots = [];
  const events = [];
  const request = {
    merchantRef: 'RR-TEST',
    responseCode: 503,
    accepted: false,
  };
  const source = (
    await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ).replace(/^import[^;]+;\s*/, '');
  const context = vm.createContext({
    el: element,
    notice() {},
    clearTracking() {},
    render() {},
    renderRequests(rows) {
      snapshots.push(rows);
    },
    renderLiveEvents(snapshot) {
      events.push(snapshot);
    },
    document: { hidden: false, addEventListener() {} },
    AbortController,
    AbortSignal,
    URLSearchParams,
    setTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimeout() {},
    async fetch(url, options) {
      calls.push({ url, options });
      const body = url.endsWith('/requests')
        ? { requests: [request] }
        : url.includes('/refund-events')
          ? { events: [], subscription: { state: 'disabled' } }
          : { scenario: 'SUCCESS' };
      return {
        status: 200,
        ok: true,
        async json() {
          return body;
        },
      };
    },
  });
  vm.runInContext(source, context);
  await element('connect-form').handlers.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('workspace').hidden, false);
  assert.ok(calls.some((call) => call.url === '/__mock/requests'));
  assert.equal(snapshots.at(-1)[0].merchantRef, 'RR-TEST');
  assert.equal(events.at(-1).subscription.state, 'disabled');
  assert.equal(scheduled.at(-1).delay, 3000);
  assert.ok(!calls.some((call) => call.url.includes('/transactions?')));
  assert.ok(
    calls.every(
      (call) =>
        call.options.headers['X-Admin-Key'] === 'console-test-admin-key',
    ),
  );
  await scheduled.at(-1).callback();
  assert.equal(
    calls.filter((call) => call.url === '/__mock/requests').length,
    2,
  );
  element('live-toggle').handlers.click();
  await scheduled.at(-1).callback();
  assert.equal(
    calls.filter((call) => call.url === '/__mock/requests').length,
    2,
  );
});
