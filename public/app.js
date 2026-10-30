import {
  el,
  notice,
  render,
  clearTracking,
  renderRequests,
  renderLiveEvents,
} from "./view.js";

let adminKey = "";
let reference = "";
let testId = "default";
let timer;
let controller;
let generation = 0;
let pendingScenario;
let changingScenario = false;
let livePaused = false;
let liveRequests = [];

async function api(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`/__mock/${path}`, {
    method,
    signal,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: {
      "X-Admin-Key": adminKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404 && result.errorCode === "TRANSACTION_NOT_FOUND")
    return null;
  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? "Admin Key không hợp lệ. Vui lòng kết nối lại."
        : response.status >= 500
          ? "Chưa kết nối được PayHub. Dịch vụ có thể đang khởi động; thử lại sau."
          : `PayHub từ chối yêu cầu: ${result.errorCode ?? response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
function disconnect() {
  generation++;
  controller?.abort();
  clearTimeout(timer);
  adminKey = "";
  reference = "";
  el("admin-key").value = "";
  el("merchant-ref").value = "";
  el("active-scenario").textContent = "—";
  clearTracking();
  liveRequests = [];
  livePaused = false;
  el("live-toggle").textContent = "Tạm dừng";
  el("live-toggle").setAttribute("aria-pressed", "false");
  renderRequests([]);
  renderLiveEvents({ events: [], subscription: { state: "disconnected" } });
  el("workspace").hidden = true;
  el("login").hidden = false;
  el("disconnect").hidden = true;
  el("confirm-dialog").close();
  notice();
  el("admin-key").focus();
}
function schedule() {
  clearTimeout(timer);
  if (adminKey && !document.hidden) timer = setTimeout(refresh, 3000);
}
async function refresh() {
  if (!adminKey || document.hidden) return;
  clearTimeout(timer);
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const signal = AbortSignal.any([current.signal, AbortSignal.timeout(15000)]);
  const query = new URLSearchParams({ testId, merchantRef: reference });
  const version = generation;
  el("sync").textContent = "Đang cập nhật…";
  el("refresh").disabled = true;
  try {
    const [scenario, transaction, trace, events, history] = await Promise.all([
      api("scenario", { signal }),
      reference ? api(`transactions?${query}`, { signal }) : null,
      reference
        ? api(`attempts?${new URLSearchParams({ testId })}`, { signal })
        : null,
      !livePaused || reference
        ? api("refund-events?limit=100", { signal })
        : null,
      !livePaused ? api("requests", { signal }) : null,
    ]);
    if (current.signal.aborted || version !== generation) return;
    el("active-scenario").textContent = scenario.scenario;
    if (!livePaused) {
      liveRequests = history?.requests ?? [];
      renderRequests(liveRequests);
      renderLiveEvents(events);
      el("live-state").textContent = "Đang theo dõi · Tự cập nhật mỗi 3 giây";
    }
    if (reference) render({ reference, testId, transaction, trace, events });
    else el("sync").textContent = "Chưa chọn yêu cầu";
    notice();
  } catch (error) {
    if (current.signal.aborted || version !== generation) return;
    if (error.status === 401) disconnect();
    else {
      el("sync").textContent = "Chưa cập nhật được · dữ liệu có thể cũ";
      el("live-state").textContent = "Mất kết nối · Đang thử lại";
    }
    notice(error.message);
  } finally {
    if (version === generation) {
      el("refresh").disabled = false;
      schedule();
    }
  }
}
el("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = el("admin-key").value.trim();
  if (!candidate) return;
  el("connect").disabled = true;
  adminKey = candidate;
  el("admin-key").value = "";
  try {
    const scenario = await api("scenario", {
      signal: AbortSignal.timeout(15000),
    });
    el("active-scenario").textContent = scenario.scenario;
    el("scenario").value = scenario.scenario;
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("disconnect").hidden = false;
    notice();
    el("merchant-ref").focus();
    refresh();
  } catch (error) {
    adminKey = "";
    notice(error.message);
  } finally {
    el("connect").disabled = false;
  }
});
el("disconnect").addEventListener("click", disconnect);
el("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const nextReference = el("merchant-ref").value.trim();
  const nextTestId = el("test-id").value.trim();
  if (!nextReference || !nextTestId)
    return notice("Nhập mã yêu cầu và namespace hợp lệ.");
  generation++;
  reference = nextReference;
  testId = nextTestId;
  clearTracking();
  el("empty").querySelector("h2").textContent = "Đang tìm giao dịch…";
  refresh();
});
el("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
    controller?.abort();
  } else if (adminKey) refresh();
});
function confirmScenario(value, reset = false) {
  if (changingScenario) return;
  pendingScenario = { value, reset };
  el("confirm-description").textContent =
    `Scenario mới: ${value}. Thay đổi áp dụng cho mọi người dùng chung PayHub mock này.`;
  el("confirm-dialog").returnValue = "cancel";
  el("confirm-dialog").showModal();
}
el("apply").addEventListener("click", () =>
  confirmScenario(el("scenario").value),
);
el("reset").addEventListener("click", () => confirmScenario("SUCCESS", true));
el("confirm-dialog").addEventListener("close", async () => {
  if (
    el("confirm-dialog").returnValue !== "apply" ||
    !adminKey ||
    changingScenario
  )
    return;
  changingScenario = true;
  el("apply").disabled = true;
  el("reset").disabled = true;
  const version = generation;
  const chosen = pendingScenario;
  try {
    const result = await api("scenario", {
      method: chosen.reset ? "DELETE" : "PUT",
      body: chosen.reset ? undefined : { scenario: chosen.value },
      signal: AbortSignal.timeout(15000),
    });
    if (version !== generation) return;
    el("active-scenario").textContent = result.scenario;
    el("scenario").value = result.scenario;
    notice(
      `Đã áp dụng ${result.scenario}. Dùng một Return Request mới để chạy case này.`,
    );
  } catch (error) {
    if (version !== generation) return;
    if (error.status === 401) disconnect();
    notice(error.message);
  } finally {
    changingScenario = false;
    el("apply").disabled = false;
    el("reset").disabled = false;
  }
});

el("live-search").addEventListener("input", () => renderRequests(liveRequests));
el("live-namespace").addEventListener("change", () =>
  renderRequests(liveRequests),
);
el("live-toggle").addEventListener("click", () => {
  livePaused = !livePaused;
  el("live-toggle").textContent = livePaused ? "Tiếp tục" : "Tạm dừng";
  el("live-toggle").setAttribute("aria-pressed", String(livePaused));
  el("live-state").textContent = livePaused ? "Đã tạm dừng" : "Đang cập nhật…";
  if (!livePaused) refresh();
});
el("live-requests").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-reference]");
  if (!button) return;
  el("merchant-ref").value = button.dataset.reference;
  el("test-id").value = button.dataset.namespace;
  el("search-form").requestSubmit();
});
