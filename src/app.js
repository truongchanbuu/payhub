import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createRefundEventLog } from "./refund-event-log.js";

export const SCENARIOS = Object.freeze([
  "SUCCESS",
  "PENDING_SUCCESS",
  "PENDING_FAILED",
  "INVALID_AMOUNT",
  "HTTP_500",
  "HTTP_503",
  "RETRY_503_3",
  "RETRY_503_2_SUCCESS",
  "TIMEOUT",
  "SUCCESS_THEN_TIMEOUT",
  "DUPLICATE_CALLBACK",
]);

const fields = ["merchantRef", "orderNumber", "amount", "currency", "reason"];

const hash = (value) => createHash("sha256").update(value).digest("hex");

const matches = (actual, expected) =>
  typeof actual === "string" &&
  timingSafeEqual(Buffer.from(hash(actual)), Buffer.from(hash(expected)));

const validText = (value, max = 200) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value;

const prettyJson = (value) => JSON.stringify(value, null, 2);

const sseMessage = (type, data) => {
  const lines = prettyJson(data)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");

  return `event: ${type}\n${lines}\n\n`;
};

export function createApp({
  payhubToken = process.env.PAYHUB_TOKEN,
  clientId = process.env.PAYHUB_CLIENT_ID,
  clientSecret = process.env.PAYHUB_CLIENT_SECRET,
  adminKey = process.env.ADMIN_KEY,
  timeoutMs = 11000,
  callbackUrl = process.env.SALESFORCE_CALLBACK_URL,
  salesforceClientId = process.env.SALESFORCE_CLIENT_ID,
  salesforceClientSecret = process.env.SALESFORCE_CLIENT_SECRET,
  callbackTimeoutMs = 5000,
  refundEventLog = createRefundEventLog(),
} = {}) {
  if (
    !validText(payhubToken) ||
    !validText(adminKey) ||
    payhubToken === adminKey
  ) {
    throw new Error("Distinct PAYHUB_TOKEN and ADMIN_KEY are required");
  }

  if (
    (clientId || clientSecret) &&
    (!validText(clientId) || !validText(clientSecret))
  ) {
    throw new Error(
      "PAYHUB_CLIENT_ID and PAYHUB_CLIENT_SECRET must be configured together",
    );
  }

  if (callbackUrl) {
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new Error("Invalid Salesforce callback configuration");
    }

    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

    if (
      (!localHttp && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash ||
      !validText(salesforceClientId, 4096) ||
      !validText(salesforceClientSecret, 4096) ||
      /[\r\n]/.test(salesforceClientId) ||
      /[\r\n]/.test(salesforceClientSecret)
    ) {
      throw new Error("Invalid Salesforce callback configuration");
    }
  }

  const app = express();
  const runs = new Map();
  const timers = new Set();
  const controllers = new Set();
  let defaultScenario = "SUCCESS";

  app.locals.dispose = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();

    for (const controller of controllers) controller.abort();
    controllers.clear();
  };

  function send(res, code, body, delayMs = 0) {
    if (!delayMs) return res.status(code).json(body);

    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) res.status(code).json(body);
    }, delayMs);

    timers.add(timer);

    res.once("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  }

  function readDelay(req, name, fallback) {
    const value = req.get(name);
    if (value === undefined) return fallback;
    if (!/^\d{1,6}$/.test(value) || Number(value) > 120000) return null;
    return Number(value);
  }

  // Get a fresh Salesforce access token for each callback.
  async function getSalesforceAccessToken(signal) {
    const tokenUrl = `${new URL(callbackUrl).origin}/services/oauth2/token`;

    const response = await fetch(tokenUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: salesforceClientId,
        client_secret: salesforceClientSecret,
      }),
      signal,
    });

    if (!response.ok) {
      await response.body?.cancel();

      const error = new Error("Salesforce OAuth token request failed");
      error.oauthStatus = response.status;
      throw error;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!validText(data?.access_token, 8192)) {
      const error = new Error("Salesforce OAuth response has no access_token");
      error.oauthStatus = response.status;
      throw error;
    }

    return data.access_token;
  }

  function scheduleCallbacks(run, record, merchantRef, delayMs) {
    const timer = setTimeout(async () => {
      timers.delete(timer);

      const status =
        record.scenario === "PENDING_FAILED" ? "FAILED" : "SUCCESS";
      record.finalStatus = status;

      const payload = JSON.stringify({
        refundId: record.response.refundId,
        merchantRef,
        status,
        processedAt: new Date().toISOString(),
        ...(status === "FAILED" ? { failureReason: "CARD_CLOSED" } : {}),
      });

      const count = record.scenario === "DUPLICATE_CALLBACK" ? 2 : 1;

      for (let i = 0; i < count; i += 1) {
        const attempt = {
          number: run.callbacks.length + 1,
          refundId: record.response.refundId,
          status,
          startedAt: new Date().toISOString(),
          responseCode: null,
          outcome: "IN_FLIGHT",
        };

        run.callbacks.push(attempt);

        const started = performance.now();
        const controller = new AbortController();
        controllers.add(controller);

        try {
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(callbackTimeoutMs),
          ]);

          const accessToken = await getSalesforceAccessToken(signal);

          const response = await fetch(callbackUrl, {
            method: "POST",
            redirect: "manual",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: payload,
            signal,
          });

          attempt.responseCode = response.status;
          attempt.outcome = response.ok ? "DELIVERED" : "HTTP_ERROR";

          await response.body?.cancel();
        } catch (error) {
          attempt.outcome =
            error.oauthStatus !== undefined
              ? "AUTH_ERROR"
              : error.name === "TimeoutError"
                ? "TIMEOUT"
                : "NETWORK_ERROR";

          if (error.oauthStatus !== undefined) {
            attempt.oauthResponseCode = error.oauthStatus;
          }
        } finally {
          controllers.delete(controller);

          attempt.finishedAt = new Date().toISOString();
          attempt.durationMs =
            Math.round((performance.now() - started) * 1000) / 1000;
        }
      }
    }, delayMs);

    timers.add(timer);
  }

  function runFor(id) {
    if (!runs.has(id)) {
      runs.set(id, {
        keys: new Map(),
        merchants: new Map(),
        attempts: [],
        callbacks: [],
      });
    }

    return runs.get(id);
  }

  app.disable("x-powered-by");
  app.locals.refundEventLog = refundEventLog;

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.post(
    "/v1/token",
    (_req, res, next) => {
      res.set({
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      });

      next();
    },
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const fail = (code, error) => res.status(code).json({ error });

      if (!clientId || !clientSecret) {
        return fail(503, "temporarily_unavailable");
      }

      if (!req.is("application/x-www-form-urlencoded")) {
        return fail(400, "invalid_request");
      }

      const body = req.body ?? {};

      if (Object.values(body).some((value) => typeof value !== "string")) {
        return fail(400, "invalid_request");
      }

      let id = body.client_id;
      let secret = body.client_secret;

      const authorization = req.get("Authorization");

      if (authorization !== undefined) {
        if (id !== undefined || secret !== undefined) {
          return fail(400, "invalid_request");
        }

        const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);

        if (basic) {
          const credentials = Buffer.from(basic[1], "base64").toString("utf8");
          const separator = credentials.indexOf(":");

          if (separator >= 0) {
            try {
              id = decodeURIComponent(
                credentials.slice(0, separator).replace(/\+/g, " "),
              );

              secret = decodeURIComponent(
                credentials.slice(separator + 1).replace(/\+/g, " "),
              );
            } catch {
              return fail(400, "invalid_request");
            }
          }
        }
      }

      if (!matches(id, clientId) || !matches(secret, clientSecret)) {
        if (authorization !== undefined) {
          res.set("WWW-Authenticate", 'Basic realm="PayHub"');
        }

        return fail(authorization !== undefined ? 401 : 400, "invalid_client");
      }

      if (!body.grant_type) return fail(400, "invalid_request");

      if (body.grant_type !== "client_credentials") {
        return fail(400, "unsupported_grant_type");
      }

      if (body.scope) return fail(400, "invalid_scope");

      res.json({
        access_token: payhubToken,
        token_type: "Bearer",
      });
    },
    (err, _req, res, _next) => {
      const code = err.type === "entity.too.large" ? 413 : 400;
      res.status(code).json({ error: "invalid_request" });
    },
  );

  app.get("/__mock/attempts", (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    const id = req.query.testId ?? "default";

    if (!validText(id, 100)) {
      return res.status(400).json({ errorCode: "INVALID_TEST_ID" });
    }

    const run = runs.get(id);

    res.json({
      testId: id,
      acceptedCount: run?.merchants.size ?? 0,
      refunds: run
        ? [...run.merchants.values()].map((record) => ({
            refundId: record.response.refundId,
            status: record.response.status,
            finalStatus: record.finalStatus ?? null,
          }))
        : [],
      attempts: run
        ? run.attempts.map(
            ({ merchantRefHash: _merchantRefHash, ...attempt }) => attempt,
          )
        : [],
      callbackAttempts: run?.callbacks ?? [],
    });
  });

  app.get("/__mock/refund-events", (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    const requestedLimit = req.query.limit ?? "100";

    if (!/^\d{1,3}$/.test(requestedLimit)) {
      return res.status(400).json({ errorCode: "INVALID_LIMIT" });
    }

    const limit = Number(requestedLimit);
    if (limit < 1 || limit > 100) {
      return res.status(400).json({ errorCode: "INVALID_LIMIT" });
    }

    res.type("application/json").send(
      `${prettyJson(refundEventLog.snapshot(limit))}\n`,
    );
  });

  app.get("/__mock/refund-events/tail", (req, res) => {
    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    const requestedDurationMs = req.query.durationMs;
    if (
      requestedDurationMs !== undefined &&
      (!/^\d{1,5}$/.test(requestedDurationMs) ||
        Number(requestedDurationMs) < 1 ||
        Number(requestedDurationMs) > 60000)
    ) {
      return res.status(400).json({ errorCode: "INVALID_DURATION" });
    }

    res.set({
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const write = ({ type, data }) => {
      if (!res.destroyed) res.write(sseMessage(type, data));
    };

    const snapshot = refundEventLog.snapshot();
    write({ type: "subscription", data: snapshot.subscription });
    for (const event of snapshot.events) write({ type: "refund", data: event });

    const unsubscribe = refundEventLog.subscribe(write);
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 15000);
    timers.add(keepalive);

    const duration = requestedDurationMs
      ? setTimeout(() => res.end(), Number(requestedDurationMs))
      : undefined;
    if (duration) timers.add(duration);

    res.once("close", () => {
      unsubscribe();
      clearInterval(keepalive);
      timers.delete(keepalive);
      if (duration) {
        clearTimeout(duration);
        timers.delete(duration);
      }
    });
  });

  app.get("/__mock/transactions", (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    const id = req.query.testId ?? "default";
    const merchantRef = req.query.merchantRef;

    if (!validText(id, 100)) {
      return res.status(400).json({ errorCode: "INVALID_TEST_ID" });
    }

    if (!validText(merchantRef)) {
      return res.status(400).json({ errorCode: "INVALID_MERCHANT_REF" });
    }

    const run = runs.get(id);
    const record = run?.merchants.get(merchantRef);
    const attempts = (run?.attempts ?? []).filter(
      (attempt) => attempt.merchantRefHash === hash(merchantRef),
    );

    if (!record && attempts.length === 0) {
      return res.status(404).json({ errorCode: "TRANSACTION_NOT_FOUND" });
    }

    const callbacks = record
      ? (run?.callbacks ?? []).filter(
          (attempt) => attempt.refundId === record.response.refundId,
        )
      : [];

    res.json({
      testId: id,
      merchantRef,
      payment: record
        ? {
            refundId: record.response.refundId,
            initialStatus: record.response.status,
            finalStatus: record.finalStatus ?? record.response.status,
            scenario: record.scenario,
            acceptedAt: record.acceptedAt,
          }
        : null,
      attempts: attempts.map(
        ({
          number,
          startedAt,
          finishedAt,
          durationMs,
          responseCode,
          disconnected,
          scenario,
          scenarioAttempt,
          accepted,
          replayed,
        }) => ({
          number,
          startedAt,
          finishedAt: finishedAt ?? null,
          durationMs,
          responseCode,
          disconnected,
          scenario: scenario ?? null,
          scenarioAttempt: scenarioAttempt ?? null,
          accepted: accepted ?? false,
          replayed: replayed ?? false,
        }),
      ),
      callbackAttempts: callbacks,
    });
  });

  app.get("/__mock/scenario", (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    res.json({ scenario: defaultScenario });
  });

  app.put(
    "/__mock/scenario",
    express.json({ limit: "1kb" }),
    (req, res) => {
      res.set("Cache-Control", "no-store");

      if (!matches(req.get("X-Admin-Key"), adminKey)) {
        return res.status(401).json({ errorCode: "UNAUTHORIZED" });
      }

      if (
        !req.body ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 ||
        !SCENARIOS.includes(req.body.scenario)
      ) {
        return res.status(400).json({ errorCode: "INVALID_SCENARIO" });
      }

      defaultScenario = req.body.scenario;
      res.json({ scenario: defaultScenario });
    },
  );

  app.delete("/__mock/scenario", (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!matches(req.get("X-Admin-Key"), adminKey)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    defaultScenario = "SUCCESS";
    res.json({ scenario: defaultScenario });
  });

  app.use("/v1/refunds", (req, res, next) => {
    const id = req.get("X-Mock-Test-Id") ?? "default";
    const run = runFor(validText(id, 100) ? id : "__invalid_test_id");

    const attempt = {
      number: run.attempts.length + 1,
      startedAt: new Date().toISOString(),
      method: req.method,
      idempotencyKeyHash: hash(req.get("Idempotency-Key") ?? ""),
      responseCode: null,
      durationMs: null,
      disconnected: false,
    };

    run.attempts.push(attempt);

    const started = performance.now();
    let complete = false;

    const finish = (disconnected) => {
      if (complete) return;

      complete = true;
      attempt.responseCode = disconnected ? null : res.statusCode;
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs =
        Math.round((performance.now() - started) * 1000) / 1000;
      attempt.disconnected = disconnected;
    };

    res.once("finish", () => finish(false));
    res.once("close", () => finish(!res.writableFinished));

    req.mock = { id, run, attempt };

    res.set("Cache-Control", "no-store");

    if (!matches(req.get("Authorization"), `Bearer ${payhubToken}`)) {
      return res.status(401).json({ errorCode: "UNAUTHORIZED" });
    }

    if (!validText(id, 100)) {
      return res.status(400).json({ errorCode: "INVALID_TEST_ID" });
    }

    next();
  });

  app.post("/v1/refunds", express.json({ limit: "16kb" }), (req, res) => {
    const fail = (code, errorCode) => res.status(code).json({ errorCode });

    const key = req.get("Idempotency-Key");

    if (!validText(key)) return fail(400, "INVALID_IDEMPOTENCY_KEY");
    if (!req.is("application/json")) return fail(415, "UNSUPPORTED_MEDIA_TYPE");

    const body = req.body;

    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== "object" ||
      Object.keys(body).some((field) => !fields.includes(field)) ||
      !["merchantRef", "orderNumber", "reason"].every((field) =>
        validText(body[field]),
      )
    ) {
      return fail(400, "INVALID_PAYLOAD");
    }

    if (body.currency !== "VND") {
      return fail(422, "INVALID_CURRENCY");
    }

    if (!Number.isSafeInteger(body.amount) || body.amount <= 0) {
      return fail(422, "INVALID_AMOUNT");
    }

    const fingerprint = hash(
      JSON.stringify(fields.map((field) => body[field])),
    );

    const { run, attempt } = req.mock;
    attempt.merchantRefHash = hash(body.merchantRef);
    const existing = run.keys.get(key);

    if (existing && existing.fingerprint !== fingerprint) {
      return fail(409, "IDEMPOTENCY_CONFLICT");
    }

    if (existing?.response) {
      attempt.replayed = true;
      return res.json(existing.response);
    }

    const merchant = run.merchants.get(body.merchantRef);

    if (merchant) {
      if (merchant.fingerprint !== fingerprint) {
        return fail(409, "MERCHANT_REF_CONFLICT");
      }

      run.keys.set(key, merchant);
      attempt.replayed = true;
      return res.json(merchant.response);
    }

    const requestedHeader = req.get("X-Mock-Scenario");

    if (requestedHeader !== undefined && !SCENARIOS.includes(requestedHeader)) {
      return fail(400, "INVALID_SCENARIO");
    }

    const requested = requestedHeader ?? existing?.scenario ?? defaultScenario;

    const delayMs = readDelay(req, "X-Mock-Delay-Ms", existing?.delayMs ?? 0);

    const callbackDelayMs = readDelay(
      req,
      "X-Mock-Callback-Delay-Ms",
      existing?.callbackDelayMs ?? 1000,
    );

    if (delayMs === null || callbackDelayMs === null) {
      return fail(400, "INVALID_DELAY");
    }

    if (
      existing &&
      requestedHeader !== undefined &&
      requested !== existing.scenario
    ) {
      return fail(409, "SCENARIO_CONFLICT");
    }

    const record = existing ?? {
      fingerprint,
      scenario: requested,
      delayMs,
      callbackDelayMs,
      step: 0,
    };

    run.keys.set(key, record);

    record.step += 1;

    attempt.scenario = record.scenario;
    attempt.scenarioAttempt = record.step;

    const scenario = record.scenario;

    if (scenario === "INVALID_AMOUNT") {
      return send(res, 422, { errorCode: "INVALID_AMOUNT" }, delayMs);
    }

    if (scenario === "HTTP_500") {
      return send(res, 500, { errorCode: "INTERNAL_ERROR" }, delayMs);
    }

    if (
      scenario === "HTTP_503" ||
      (scenario === "RETRY_503_3" && record.step <= 3) ||
      (scenario === "RETRY_503_2_SUCCESS" && record.step <= 2)
    ) {
      return send(res, 503, { errorCode: "SERVICE_UNAVAILABLE" }, delayMs);
    }

    if (scenario === "TIMEOUT") {
      return send(
        res,
        504,
        { errorCode: "MOCK_TIMEOUT" },
        Math.max(timeoutMs, delayMs),
      );
    }

    const pending = [
      "PENDING_SUCCESS",
      "PENDING_FAILED",
      "DUPLICATE_CALLBACK",
    ].includes(scenario);

    if (pending && !callbackUrl) {
      return fail(503, "CALLBACK_NOT_CONFIGURED");
    }

    // No await between lookup and acceptance:
    // concurrent requests cannot accept twice.
    record.response = {
      refundId: `PH-RF-${randomUUID()}`,
      status: pending ? "PENDING" : "SUCCESS",
    };
    record.acceptedAt = new Date().toISOString();

    run.merchants.set(body.merchantRef, record);
    attempt.accepted = true;

    send(
      res,
      200,
      record.response,
      scenario === "SUCCESS_THEN_TIMEOUT"
        ? Math.max(timeoutMs, delayMs)
        : delayMs,
    );

    if (pending) {
      scheduleCallbacks(
        run,
        record,
        body.merchantRef,
        delayMs + callbackDelayMs,
      );
    }
  });

  app.use((err, _req, res, _next) => {
    const code =
      err.type === "entity.too.large"
        ? 413
        : err.type === "entity.parse.failed"
          ? 400
          : 500;

    res.status(code).json({
      errorCode: code === 500 ? "INTERNAL_ERROR" : "INVALID_JSON",
    });
  });

  app.use((_req, res) => res.status(404).json({ errorCode: "NOT_FOUND" }));

  return app;
}
