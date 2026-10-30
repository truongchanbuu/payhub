export const el = (id) => document.getElementById(id);
export function notice(message = "") {
  el("notice").textContent = message;
  el("notice").hidden = !message;
}
const time = (value) =>
  value ? new Date(value).toLocaleString("vi-VN", { hour12: false }) : "—";
const duration = (value) =>
  Number.isFinite(value)
    ? `${Math.round(value).toLocaleString("vi-VN")} ms`
    : "Đang chờ";
const tone = (value) =>
  ["SUCCESS", "COMPLETED", "DELIVERED", "Accepted", "Replayed"].includes(value)
    ? "success"
    : [
          "FAILED",
          "REFUND_FAILED",
          "HTTP_ERROR",
          "AUTH_ERROR",
          "NETWORK_ERROR",
          "TIMEOUT",
        ].includes(value)
      ? "error"
      : "warning";
function badge(value, type = tone(value)) {
  const node = document.createElement("span");
  node.className = `badge ${type}`;
  node.textContent = value;
  return node;
}
function cell(value) {
  const node = document.createElement("td");
  if (value instanceof Node) node.append(value);
  else node.textContent = value;
  return node;
}
function row(values) {
  const node = document.createElement("tr");
  values.forEach((value) => node.append(cell(value)));
  return node;
}
export function clearTracking() {
  el("tracking").hidden = true;
  el("empty").hidden = false;
  for (const id of ["attempts", "callbacks", "events"])
    el(id).replaceChildren();
  el("tracking-title").textContent = "";
  el("sync").textContent = "Chưa chọn yêu cầu";
}
export function render({ reference, testId, transaction, trace, events }) {
  el("empty").hidden = true;
  el("tracking").hidden = false;
  el("tracking-title").textContent = reference;
  el("namespace").textContent = `Namespace: ${testId} · Tự cập nhật mỗi 3 giây`;
  const attempts = transaction?.attempts ?? [];
  const callbacks = transaction?.callbackAttempts ?? [];
  const payment = transaction?.payment;
  el("accepted-count").textContent = payment ? "1" : "0";
  el("attempt-count").textContent = attempts.length;
  el("replay-count").textContent = attempts.filter(
    (item) => item.replayed,
  ).length;
  el("refund-id").textContent = payment?.refundId ?? "—";
  el("payment-status").textContent = payment?.finalStatus ?? "Chưa tiếp nhận";
  el("payment-detail").textContent = payment
    ? `${payment.scenario} · Tiếp nhận ${time(payment.acceptedAt)}`
    : "Chưa có giao dịch được PayHub chấp nhận cho mã này.";
  el("attempts-empty").hidden = attempts.length > 0;
  el("attempts-table").hidden = !attempts.length;
  const lookup = new Map(
    (trace?.attempts ?? []).map((item) => [item.number, item]),
  );
  const hashes = attempts.map(
    (item) => lookup.get(item.number)?.idempotencyKeyHash,
  );
  const known = hashes.filter(Boolean);
  const consistent =
    known.length === attempts.length && new Set(known).size === 1;
  const keyStatus = el("key-status");
  keyStatus.textContent = !attempts.length
    ? "Chưa có key"
    : known.length !== attempts.length
      ? "Đang đồng bộ key"
      : consistent
        ? "Cùng một key"
        : "Nhiều key khác nhau";
  keyStatus.className = `badge ${attempts.length ? (consistent ? "success" : "warning") : ""}`;
  el("attempts").replaceChildren(
    ...attempts.map((item, index) => {
      const hash = lookup.get(item.number)?.idempotencyKeyHash;
      const key = document.createElement("abbr");
      key.className = "hash";
      key.title = hash ?? "Đang đồng bộ";
      key.textContent = hash ? `${hash.slice(0, 14)}…` : "—";
      const result = item.responseCode
        ? `HTTP ${item.responseCode}`
        : item.disconnected
          ? "Mất kết nối"
          : "Đang chờ";
      const timestamp = document.createElement("span");
      timestamp.textContent = time(item.startedAt);
      const scenario = document.createElement("small");
      scenario.textContent = item.scenario ?? "Replay giao dịch đã có";
      timestamp.append(scenario);
      return row([
        String(index + 1),
        timestamp,
        badge(
          result,
          item.responseCode === 200
            ? "success"
            : item.responseCode || item.disconnected
              ? "error"
              : "warning",
        ),
        badge(
          item.accepted
            ? "Accepted"
            : item.replayed
              ? "Replayed"
              : "Chưa tiếp nhận",
          item.accepted || item.replayed ? "success" : "warning",
        ),
        key,
        duration(item.durationMs),
      ]);
    }),
  );
  el("callback-count").textContent = `${callbacks.length} callback`;
  el("callbacks-empty").hidden = callbacks.length > 0;
  el("callbacks-table").hidden = !callbacks.length;
  el("callbacks").replaceChildren(
    ...callbacks.map((item, index) =>
      row([
        String(index + 1),
        time(item.startedAt),
        badge(item.status),
        badge(item.outcome),
        item.responseCode ??
          (item.oauthResponseCode ? `OAuth ${item.oauthResponseCode}` : "—"),
        duration(item.durationMs),
      ]),
    ),
  );
  const subscription = events?.subscription?.state ?? "unknown";
  el("subscription").textContent = `Subscriber: ${subscription}`;
  el("subscription").className =
    `badge ${subscription === "subscribed" ? "success" : "warning"}`;
  const matches = (events?.events ?? []).filter(
    (event) => event.requestNumber === reference,
  );
  const nodes = matches.map((event) => {
    const node = document.createElement("div");
    node.className = "event-row";
    const detail = document.createElement("div");
    const status = document.createElement("strong");
    status.textContent = event.outcome;
    const meta = document.createElement("p");
    const amount = Number.isFinite(event.refundAmount)
      ? `${event.refundAmount.toLocaleString("vi-VN")} VND`
      : "—";
    meta.textContent = `${amount} · Store ${event.storeCode ?? "—"} · Nhận ${time(event.receivedAt)}`;
    detail.append(status, meta);
    node.append(detail, badge("Đã nhận event", "success"));
    return node;
  });
  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.className = "table-empty";
    empty.textContent =
      subscription === "disabled"
        ? "Subscriber chưa bật trên PayHub. Bật SALESFORCE_REFUND_EVENTS_ENABLED để quan sát INT-05."
        : "Chưa nhận được event cho mã yêu cầu này.";
    nodes.push(empty);
  }
  el("events").replaceChildren(...nodes);
  el("sync").textContent =
    `Cập nhật ${new Date().toLocaleTimeString("vi-VN", { hour12: false })}`;
}
