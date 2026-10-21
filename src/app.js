import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const fields = ['merchantRef', 'orderNumber', 'amount', 'currency', 'reason'];
const hash = value => createHash('sha256').update(value).digest('hex');
const matches = (actual, expected) => typeof actual === 'string'
  && timingSafeEqual(Buffer.from(hash(actual)), Buffer.from(hash(expected)));
const validText = (value, max = 200) => typeof value === 'string'
  && value.length > 0 && value.length <= max && value.trim() === value;

export function createApp({ payhubToken = process.env.PAYHUB_TOKEN,
  adminKey = process.env.ADMIN_KEY } = {}) {
  if (!validText(payhubToken) || !validText(adminKey) || payhubToken === adminKey) {
    throw new Error('Distinct PAYHUB_TOKEN and ADMIN_KEY are required');
  }
  const app = express();
  const runs = new Map();
  function runFor(id) {
    if (!runs.has(id)) runs.set(id, { keys: new Map(), merchants: new Map(), attempts: [], callbacks: [] });
    return runs.get(id);
  }
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/__mock/attempts', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!matches(req.get('X-Admin-Key'), adminKey)) return res.status(401).json({ errorCode: 'UNAUTHORIZED' });
    const id = req.query.testId ?? 'default';
    if (!validText(id, 100)) return res.status(400).json({ errorCode: 'INVALID_TEST_ID' });
    const run = runs.get(id);
    res.json({ testId: id, acceptedCount: run?.merchants.size ?? 0,
      refunds: run ? [...run.merchants.values()].map(record => ({
        refundId: record.response.refundId, status: record.response.status,
      })) : [], attempts: run?.attempts ?? [], callbackAttempts: run?.callbacks ?? [] });
  });
  app.use('/v1/refunds', (req, res, next) => {
    const id = req.get('X-Mock-Test-Id') ?? 'default';
    const run = runFor(validText(id, 100) ? id : '__invalid_test_id');
    const attempt = { number: run.attempts.length + 1, startedAt: new Date().toISOString(),
      method: req.method, idempotencyKeyHash: hash(req.get('Idempotency-Key') ?? ''),
      responseCode: null, durationMs: null, disconnected: false };
    run.attempts.push(attempt);
    const started = performance.now();
    let complete = false;
    const finish = disconnected => {
      if (complete) return;
      complete = true;
      attempt.responseCode = disconnected ? null : res.statusCode;
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Math.round((performance.now() - started) * 1000) / 1000;
      attempt.disconnected = disconnected;
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
    req.mock = { id, run, attempt };
    res.set('Cache-Control', 'no-store');
    if (!matches(req.get('Authorization'), `Bearer ${payhubToken}`)) {
      return res.status(401).json({ errorCode: 'UNAUTHORIZED' });
    }
    if (!validText(id, 100)) return res.status(400).json({ errorCode: 'INVALID_TEST_ID' });
    next();
  });
  app.post('/v1/refunds', express.json({ limit: '16kb' }), (req, res) => {
    const fail = (code, errorCode) => res.status(code).json({ errorCode });
    const key = req.get('Idempotency-Key');
    if (!validText(key)) return fail(400, 'INVALID_IDEMPOTENCY_KEY');
    if (!req.is('application/json')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE');
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).some(field => !fields.includes(field))
      || !['merchantRef', 'orderNumber', 'reason'].every(field => validText(body[field]))) {
      return fail(400, 'INVALID_PAYLOAD');
    }
    if (body.currency !== 'VND') return fail(422, 'INVALID_CURRENCY');
    if (!Number.isSafeInteger(body.amount) || body.amount <= 0) return fail(422, 'INVALID_AMOUNT');
    const fingerprint = hash(JSON.stringify(fields.map(field => body[field])));
    const { run, attempt } = req.mock;
    const existing = run.keys.get(key);
    if (existing && existing.fingerprint !== fingerprint) return fail(409, 'IDEMPOTENCY_CONFLICT');
    if (existing?.response) {
      attempt.replayed = true;
      return res.json(existing.response);
    }
    const merchant = run.merchants.get(body.merchantRef);
    if (merchant) {
      if (merchant.fingerprint !== fingerprint) return fail(409, 'MERCHANT_REF_CONFLICT');
      run.keys.set(key, merchant);
      attempt.replayed = true;
      return res.json(merchant.response);
    }
    // No await between lookup and acceptance: concurrent requests cannot accept twice.
    const record = { fingerprint, response: { refundId: `PH-RF-${randomUUID()}`, status: 'SUCCESS' } };
    run.keys.set(key, record);
    run.merchants.set(body.merchantRef, record);
    attempt.accepted = true;
    res.json(record.response);
  });
  app.use((err, _req, res, _next) => {
    const code = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(code).json({ errorCode: code === 500 ? 'INTERNAL_ERROR' : 'INVALID_JSON' });
  });
  app.use((_req, res) => res.status(404).json({ errorCode: 'NOT_FOUND' }));
  return app;
}
