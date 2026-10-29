import assert from "node:assert/strict";
import test from "node:test";
import { createRefundEventLog } from "../src/refund-event-log.js";
import {
  createRefundEventSubscriber,
  refundOutcome,
} from "../src/refund-event-subscriber.js";

const configuration = {
  enabled: true,
  loginUrl: "https://smartreturn.my.salesforce.com",
  clientId: "salesforce-client",
  clientSecret: "salesforce-secret",
};

test("refund outcome fields are normalized for the demo log", () => {
  const event = refundOutcome(
    {
      replayId: 42n,
      payload: {
        Request_Number__c: { string: "RR-2610-00015" },
        Outcome__c: { string: "COMPLETED" },
        Refund_Amount__c: { long: 1992000n },
        Store_Code__c: { string: "HN-001" },
        Occurred_At__c: { long: 1793246400000n },
      },
    },
    new Date("2026-10-29T05:00:00.000Z"),
  );

  assert.deepEqual(event, {
    receivedAt: "2026-10-29T05:00:00.000Z",
    replayId: "42",
    requestNumber: "RR-2610-00015",
    outcome: "COMPLETED",
    refundAmount: 1992000,
    storeCode: "HN-001",
    occurredAt: "2026-10-29T04:00:00.000Z",
  });
});

test("event log retains a bounded tail and broadcasts new entries", () => {
  const eventLog = createRefundEventLog({ capacity: 2 });
  const received = [];
  const unsubscribe = eventLog.subscribe((entry) => received.push(entry));

  eventLog.record({ replayId: "1" });
  eventLog.record({ replayId: "2" });
  eventLog.record({ replayId: "3" });
  unsubscribe();
  eventLog.record({ replayId: "4" });

  assert.deepEqual(
    eventLog.snapshot().events.map((event) => event.replayId),
    ["3", "4"],
  );
  assert.deepEqual(
    received.map((entry) => entry.data.replayId),
    ["1", "2", "3"],
  );
});

test("subscriber connects, records events, reconnects and stops", async () => {
  const eventLog = createRefundEventLog();
  const clients = [];
  const createClient = async (receivedConfiguration) => {
    assert.deepEqual(receivedConfiguration, {
      loginUrl: configuration.loginUrl,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
    });

    const client = {
      closed: false,
      async connect() {},
      subscribe(topic, callback, requested) {
        this.topic = topic;
        this.callback = callback;
        this.requested = requested;
      },
      close() {
        this.closed = true;
      },
    };
    clients.push(client);
    return client;
  };

  const subscriber = createRefundEventSubscriber({
    eventLog,
    ...configuration,
    createClient,
    reconnectDelayMs: 1,
  });

  await subscriber.start();
  assert.equal(clients[0].topic, "/event/Refund_Outcome__e");
  assert.equal(clients[0].requested, null);
  assert.equal(eventLog.snapshot().subscription.state, "subscribed");

  clients[0].callback({}, "event", {
    replayId: 7,
    payload: {
      Request_Number__c: "RR-2610-00015",
      Outcome__c: "REFUND_FAILED",
      Refund_Amount__c: 500000,
      Store_Code__c: "HN-001",
      Occurred_At__c: "2026-10-29T05:00:00.000Z",
    },
  });
  assert.equal(eventLog.snapshot().events[0].outcome, "REFUND_FAILED");

  clients[0].callback({}, "error", { code: 14 });
  await waitFor(() => clients.length === 2);
  assert.equal(clients[0].closed, true);

  subscriber.stop();
  assert.equal(clients[1].closed, true);
  assert.equal(eventLog.snapshot().subscription.state, "stopped");
});

test("subscriber is disabled safely and rejects incomplete enabled config", async () => {
  const eventLog = createRefundEventLog();
  const subscriber = createRefundEventSubscriber({ eventLog });

  await subscriber.start();
  assert.equal(eventLog.snapshot().subscription.state, "disabled");

  assert.throws(
    () =>
      createRefundEventSubscriber({
        eventLog,
        enabled: true,
        loginUrl: "http://insecure.example.com",
        clientId: "client",
        clientSecret: "secret",
      }),
    /Invalid Salesforce refund event configuration/,
  );
});

async function waitFor(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
