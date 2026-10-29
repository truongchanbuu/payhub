export const REFUND_OUTCOME_TOPIC = "/event/Refund_Outcome__e";

export function createRefundEventLog({ capacity = 100 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("Refund event log capacity must be a positive integer");
  }

  const events = [];
  const listeners = new Set();
  let subscription = {
    state: "disabled",
    topic: REFUND_OUTCOME_TOPIC,
    updatedAt: new Date().toISOString(),
  };

  function emit(type, data) {
    for (const listener of listeners) listener({ type, data });
  }

  return {
    record(event) {
      const entry = Object.freeze({ ...event });
      events.push(entry);
      if (events.length > capacity) events.shift();
      emit("refund", entry);
    },

    setSubscription(update) {
      subscription = {
        ...subscription,
        ...update,
        updatedAt: new Date().toISOString(),
      };
      emit("subscription", subscription);
    },

    snapshot(limit = capacity) {
      const size = Math.min(Math.max(limit, 0), capacity);
      return {
        subscription: { ...subscription },
        retainedCount: events.length,
        capacity,
        events: events.slice(-size).map((event) => ({ ...event })),
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
