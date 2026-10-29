import { REFUND_OUTCOME_TOPIC } from "./refund-event-log.js";

const RECONNECT_DELAY_MS = 5000;

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const unwrap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const entries = Object.entries(value);
  return entries.length === 1 ? unwrap(entries[0][1]) : value;
};

const text = (value) => {
  const unwrapped = unwrap(value);
  return unwrapped === null || unwrapped === undefined
    ? null
    : String(unwrapped);
};

const integer = (value) => {
  const unwrapped = unwrap(value);
  if (typeof unwrapped === "bigint") {
    const parsed = Number(unwrapped);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  const parsed = Number(unwrapped);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

function eventTime(value) {
  const unwrapped = unwrap(value);
  if (unwrapped === null || unwrapped === undefined) return null;

  const parsed =
    typeof unwrapped === "number" || typeof unwrapped === "bigint"
      ? new Date(Number(unwrapped))
      : new Date(String(unwrapped));

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function refundOutcome(data, receivedAt = new Date()) {
  const payload = data?.payload ?? {};

  return {
    receivedAt: receivedAt.toISOString(),
    replayId: text(data?.replayId),
    requestNumber: text(payload.Request_Number__c),
    outcome: text(payload.Outcome__c),
    refundAmount: integer(payload.Refund_Amount__c),
    storeCode: text(payload.Store_Code__c),
    occurredAt: eventTime(payload.Occurred_At__c),
  };
}

function validateConfiguration({ enabled, loginUrl, clientId, clientSecret }) {
  if (!enabled) return;

  let url;
  try {
    url = new URL(loginUrl);
  } catch {
    throw new Error("Invalid Salesforce refund event configuration");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !clientId ||
    !clientSecret ||
    /[\r\n]/.test(clientId) ||
    /[\r\n]/.test(clientSecret)
  ) {
    throw new Error("Invalid Salesforce refund event configuration");
  }
}

async function defaultClient(configuration) {
  const { default: PubSubApiClient } = await import(
    "salesforce-pubsub-api-client"
  );

  return new PubSubApiClient(
    {
      authType: "oauth-client-credentials",
      loginUrl: configuration.loginUrl,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
    },
    silentLogger,
  );
}

const errorCode = (error) =>
  String(error?.code ?? error?.name ?? "SUBSCRIPTION_ERROR");

export function createRefundEventSubscriber({
  eventLog,
  enabled = false,
  loginUrl,
  clientId,
  clientSecret,
  createClient = defaultClient,
  reconnectDelayMs = RECONNECT_DELAY_MS,
} = {}) {
  if (!eventLog) throw new Error("Refund event log is required");
  validateConfiguration({ enabled, loginUrl, clientId, clientSecret });

  let client;
  let reconnectTimer;
  let stopped = false;
  let connecting = false;

  const setState = (state, details = {}) =>
    eventLog.setSubscription({ state, ...details });

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;

    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectDelayMs);
  }

  function handleSubscription(_subscription, callbackType, data) {
    if (callbackType === "event") {
      const event = refundOutcome(data);
      eventLog.record(event);
      setState("subscribed", {
        lastEventAt: event.receivedAt,
        lastErrorCode: null,
      });
      return;
    }

    if (callbackType === "error") {
      setState("error", { lastErrorCode: errorCode(data) });
      if (!data?.event) scheduleReconnect();
      return;
    }

    if (callbackType === "end") scheduleReconnect();
  }

  async function connect() {
    if (!enabled || stopped || connecting) return;

    connecting = true;
    setState("connecting", { lastErrorCode: null });

    try {
      client?.close();
      client = await createClient({ loginUrl, clientId, clientSecret });
      await client.connect();

      if (stopped) {
        client.close();
        return;
      }

      client.subscribe(REFUND_OUTCOME_TOPIC, handleSubscription, null);
      setState("subscribed", {
        connectedAt: new Date().toISOString(),
        lastErrorCode: null,
      });
    } catch (error) {
      setState("error", { lastErrorCode: errorCode(error) });
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  return {
    start() {
      if (!enabled) {
        setState("disabled");
        return Promise.resolve();
      }

      stopped = false;
      return connect();
    },

    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      client?.close();
      client = undefined;
      setState("stopped");
    },
  };
}
