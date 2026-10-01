// 검색어 추천 IPC. 신뢰한 앱 창만 고정 Google 주소에 요청하고 쿠키·방문 기록은 보내지 않는다.
// 같은 창의 다음 요청과 앱 종료는 진행 중인 요청을 취소한다.
const MAX_RESPONSE_BYTES = 32768;

function searchQuery(value) {
  if (typeof value !== "string") return "";
  const query = value.trim();
  if (!query || query.length > 200 || /[\u0000-\u001f\u007f/@\\?#:]/.test(query)) return "";
  // 주소·이메일·로컬 경로를 추천 서버로 보내지 않는다.
  if (/^(?:localhost|\[[\da-f:]+\])(?:\s|$)/i.test(query) || (!/\s/.test(query) && query.includes("."))) return "";
  return query;
}

function createSearchSuggest({ fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  return async (value, signal) => {
    const query = searchQuery(value);
    if (!query) return [];
    const url = new URL("https://suggestqueries.google.com/complete/search");
    url.searchParams.set("client", "chrome");
    url.searchParams.set("hl", "ko");
    url.searchParams.set("ie", "UTF-8");
    url.searchParams.set("oe", "UTF-8");
    url.searchParams.set("q", query);
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        credentials: "omit", redirect: "error", headers: { Accept: "application/json" },
      });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) return [];
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return []; }
          chunks.push(Buffer.from(chunk));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(data) || data[0] !== query || !Array.isArray(data[1])) return [];
      return [...new Set(data[1].filter((item) => typeof item === "string" && item.trim() && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item)))].slice(0, 8);
    } catch { return []; }
  };
}

function initCapability(ctx) {
  const suggest = createSearchSuggest();
  const pending = new Map();
  ctx.ipcMain.handle("ac-search-suggestions", async (event, value) => {
    if (!ctx.isTrustedSender(event)) return [];
    const owner = event.sender;
    pending.get(owner)?.abort();
    const controller = new AbortController();
    pending.set(owner, controller);
    try { return await suggest(value, controller.signal); }
    finally { if (pending.get(owner) === controller) pending.delete(owner); }
  });
  ctx.app.once("will-quit", () => { for (const controller of pending.values()) controller.abort(); pending.clear(); });
  return {};
}

module.exports = { createSearchSuggest, initCapability };
