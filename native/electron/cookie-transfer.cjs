// 쿠키 묶음을 바꾸는 동안 페이지 요청과 이전 응답이 쿠키 저장소를 반쯤 섞지 못하게 한다.
// 실제 쿠키 조회·교체·복구는 operation의 소유자 몫이고, 이 모듈은 세션의 네트워크 경계만 잡는다.

const FILTER = { urls: ["http://*/*", "https://*/*"] };
const MAX_HELD_MS = 30_000;
const transfers = new WeakMap();

function createCookieTransfer(sess) {
  if (!sess || !sess.webRequest) throw new TypeError("Electron session.webRequest가 필요합니다.");
  const existing = transfers.get(sess);
  if (existing) return existing;

  let active = null;
  let serial = Promise.resolve();
  const requests = new Map();
  const legacy = new Map();
  const stale = new Map();
  const completedScopes = new Set();

  const matches = (predicate, details) => {
    try { return predicate(details) === true; } catch { return false; }
  };

  const markStale = (id, predicate) => {
    let predicates = stale.get(id);
    if (!predicates) {
      predicates = new Set();
      stale.set(id, predicates);
    }
    predicates.add(predicate);
  };

  const markedStaleInScope = (details) => {
    const predicates = stale.get(details.id);
    if (!predicates) return false;
    for (const predicate of predicates) {
      if (matches(predicate, details)) return true;
    }
    return false;
  };

  // onBeforeRequest를 등록하기 전에 출발한 요청은 id만 보고는 범위를 되살릴 수 없다.
  // 응답에서 처음 보이면 legacy로 기억하고, 완료된 모든 전환 범위와 대조한다. 이렇게 해야
  // 모듈 설치 전 요청이 전환이 끝난 뒤 늦게 Set-Cookie를 보내는 경우도 새 묶음을 덮지 않는다.
  const responseIsStale = (details) => {
    if (markedStaleInScope(details)) return true;
    if (requests.has(details.id)) return false;

    legacy.set(details.id, details);
    if (active && matches(active.predicate, details)) {
      markStale(details.id, active.predicate);
      return true;
    }
    for (const predicate of completedScopes) {
      if (matches(predicate, details)) {
        markStale(details.id, predicate);
        return true;
      }
    }
    return false;
  };

  const finishRequest = (details) => {
    const held = active && active.held.get(details.id);
    if (held) {
      clearTimeout(held.timer);
      active.held.delete(details.id);
    }
    requests.delete(details.id);
    legacy.delete(details.id);
    stale.delete(details.id);
  };

  sess.webRequest.onBeforeRequest(FILTER, (details, callback) => {
    requests.set(details.id, details);
    // 같은 id의 리다이렉트라도 이 훅이 전환 뒤 다시 불렸다면 새 쿠키로 출발하는 새 요청 단계다.
    if (!active) stale.delete(details.id);
    if (!active || !matches(active.predicate, details)) {
      callback({});
      return;
    }

    // operation이 실수로 같은 범위의 네트워크를 기다려도 요청을 끝없이 매달지 않는다.
    // 제한 시간에는 보내는 대신 취소하므로, mutation 중간 쿠키가 밖으로 나갈 수 없다.
    const previous = active.held.get(details.id);
    if (previous) {
      clearTimeout(previous.timer);
      try { previous.callback({ cancel: true }); } catch {}
    }
    const hold = { callback, timer: null };
    hold.timer = setTimeout(() => {
      if (!active || active.held.get(details.id) !== hold) return;
      active.held.delete(details.id);
      requests.delete(details.id);
      try { callback({ cancel: true }); } catch {}
    }, MAX_HELD_MS);
    if (typeof hold.timer.unref === "function") hold.timer.unref();
    active.held.set(details.id, hold);
  });

  sess.webRequest.onHeadersReceived(FILTER, (details, callback) => {
    if (!responseIsStale(details)) {
      callback({});
      return;
    }

    const source = details.responseHeaders || {};
    const responseHeaders = {};
    let removed = false;
    for (const [name, value] of Object.entries(source)) {
      if (name.toLowerCase() === "set-cookie") removed = true;
      else responseHeaders[name] = value;
    }
    if (!removed) {
      callback({});
      return;
    }

    // 새 객체를 돌려 원본 details를 훼손하지 않고, Electron이 준 상태 줄과 헤더 값 형태도
    // 그대로 보존한다. 바꾸는 것은 Set-Cookie 필드 하나뿐이다.
    const result = { responseHeaders };
    if (typeof details.statusLine === "string") result.statusLine = details.statusLine;
    callback(result);
  });

  sess.webRequest.onCompleted(FILTER, finishRequest);
  sess.webRequest.onErrorOccurred(FILTER, finishRequest);

  async function execute(predicate, operation) {
    if (typeof predicate !== "function") throw new TypeError("scopePredicate는 함수여야 합니다.");
    if (typeof operation !== "function") throw new TypeError("operation은 함수여야 합니다.");

    const state = { predicate, held: new Map() };
    active = state;
    for (const [id, details] of requests) {
      if (matches(predicate, details)) markStale(id, predicate);
    }
    for (const [id, details] of legacy) {
      if (matches(predicate, details)) markStale(id, predicate);
    }

    try {
      return await operation();
    } finally {
      completedScopes.add(predicate);
      active = null;
      // callback을 부르기 전에 타이머와 stale 표식을 거둔다. 이 요청들은 전환 이후에 실제로
      // 출발하므로 응답의 Set-Cookie도 현재 묶음에 속한다.
      for (const [id, hold] of state.held) {
        clearTimeout(hold.timer);
        stale.delete(id);
        try { hold.callback({}); } catch {}
      }
      state.held.clear();
    }
  }

  const api = {
    run(scopePredicate, operation) {
      const result = serial.then(() => execute(scopePredicate, operation));
      serial = result.catch(() => {});
      return result;
    },
  };
  transfers.set(sess, api);
  return api;
}

module.exports = { createCookieTransfer };
