// 도메인 범위의 쿠키 한 벌을 교체한다. 중간 상태는 transfer의 통신 차단 안에서만 존재한다.
// Electron cookies API에는 트랜잭션이 없으므로 실패하면 원래 쿠키를 복원한다.
const { cookieKey, cookieFingerprint } = require("./cookie-sync-policy.cjs");
const requestScopes = new WeakMap();
function requestScopeFor(scope) {
  let requestScope = requestScopes.get(scope);
  if (!requestScope) {
    requestScope = details => {
      try { return scope(new URL(details.url).hostname); } catch { return false; }
    };
    requestScopes.set(scope, requestScope);
  }
  return requestScope;
}
function cookieDetails(c) {
  const host = String(c.domain || "").replace(/^\./, "");
  if (!host || /[\s/\\@?#:]/.test(host) || !c.name) throw new Error("invalid-cookie");
  if (c.partitionKey || c.sourceRow && c.sourceRow.top_frame_site_key) throw new Error("partitioned-cookie");
  // HTTPS 출처에서도 Secure=false를 저장할 수 있다. HTTP 출처는 같은 이름의 Secure 쿠키에 막힌다.
  const url = new URL("https://" + host + "/");
  const details = { url: url.href, name: c.name, value: String(c.value ?? ""),
    path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || "unspecified" };
  if (String(c.domain).startsWith(".") && !c.name.startsWith("__Host-")) details.domain = c.domain;
  if (Number(c.expirationDate) > 0) details.expirationDate = Number(c.expirationDate);
  return details;
}
function removeUrl(c) {
  const details = cookieDetails(c);
  // `new URL("//other-host", root)`는 cookie path를 authority로 해석한다. pathname에 대입하면
  // 어느 path 값도 원래 쿠키 domain의 origin을 벗어나지 않는다.
  const url = new URL(details.url);
  url.pathname = String(c.path || "/").startsWith("/") ? String(c.path || "/") : "/";
  url.search = "";
  url.hash = "";
  return url.href;
}
// 교체 중 페이지가 직접 쓰거나 지운 쿠키(document.cookie). 통신 차단으로 막지 못하므로 readback 비교에서 제외
// 쓰기 기준: 넣으려는 목록에 없는 key 이거나 넣으려는 값과 다른 값으로 쓰인 것
// 삭제 기준: explicit(이 교체의 remove)·overwrite(뒤따르는 inserted 로 판정) 외의 삭제. 페이지가 지우면 expired-overwrite
function watchPageWrites(cookies, desired) {
  const keys = new Set();
  if (!cookies || typeof cookies.on !== "function") return { keys, stop() {} };
  const listener = (_event, cookie, cause, removed) => {
    if (!cookie) return;
    if (removed) {
      if (cause !== "explicit" && cause !== "overwrite") keys.add(cookieKey(cookie));
      return;
    }
    const key = cookieKey(cookie);
    const want = desired.get(key);
    if (!want || cookieFingerprint([want]) !== cookieFingerprint([cookie])) keys.add(key);
  };
  cookies.on("changed", listener);
  return { keys, stop: () => { try { cookies.removeListener("changed", listener); } catch {} } };
}
// readback 이 어긋난 key 의 [domain, name] 최대 limit 개. 실패 기록용이라 값은 넣지 않음
// key 하나에 행이 여럿일 수 있음(일반·CHIPS 두 벌). 행 수 차이도 changed 로 잡도록 key 별 행 묶음을 비교
function mismatchedCookies(actual, expected, limit = 5) {
  const prints = list => {
    const groups = new Map();
    for (const c of list) groups.set(cookieKey(c), [...(groups.get(cookieKey(c)) || []), c]);
    return new Map([...groups].map(([key, rows]) => [key, cookieFingerprint(rows)]));
  };
  const a = prints(actual), e = prints(expected), out = [];
  for (const key of new Set([...a.keys(), ...e.keys()])) {
    if (a.get(key) === e.get(key)) continue;
    const [domain, , name] = JSON.parse(key);
    out.push({ domain, name, state: !a.has(key) ? "missing" : !e.has(key) ? "extra" : "changed" });
    if (out.length >= limit) break;
  }
  return out;
}
async function replaceCookieSnapshot({ session, transfer, scope, list, preserveCookie = () => false, decide = () => ({ apply: true }) }) {
  // CHIPS 등 지원하지 않는 행은 대상을 변경하기 전에 전체 검증에서 거부한다.
  const incoming = list.filter(c => !preserveCookie(c));
  const prepared = incoming.map(c => ({ cookie: c, details: cookieDetails(c) }));
  if (prepared.some(({cookie}) => !scope(cookie.domain))) throw new Error("cookie-outside-scope");
  // cookie-transfer는 끝난 predicate를 늦게 도착한 Set-Cookie 판정에 보관한다. 동일 scope에
  // 매번 새 wrapper를 넘기면 그 Set이 끝없이 늘므로 scope별 request predicate도 재사용한다.
  return transfer.run(requestScopeFor(scope), async () => {
    const before = (await session.cookies.get({})).filter(c => scope(c.domain));
    const decision = await decide(before);
    if (!decision.apply) return { changed: 0, refreshed: 0, skipped: decision.reason };
    // 원래 상태를 복원할 수 있어야 교체를 시작한다.
    const rollback = before.map(c => ({ cookie: c, details: cookieDetails(c) }));
    // source 쪽 target-bound 쿠키는 이 브라우저에서 쓸 수 없으므로 적용 대상에도 넣지 않는다.
    // 넣어 놓고 set만 건너뛰면 target에 같은 key가 없을 때 readback이 영원히 불일치한다.
    const desired = new Map(incoming.map(c => [cookieKey(c), c]));
    const kept = before.filter(c => preserveCookie(c));
    for (const c of kept) desired.set(cookieKey(c), c);
    // 같은 key 가 여러 번 오면 마지막 값. 쓰기를 동시에 보내므로 순서에 기대지 않게 미리 하나로
    const writes = [...new Map(prepared.map(p => [cookieKey(p.cookie), p])).values()];
    // 남겨 둔 쿠키는 행 그대로. 일반·파티션(CHIPS) 두 벌이 같은 key 로 읽혀서 Map 으로 합치면 readback 과 늘 어긋남
    const expected = [...writes.map(p => p.cookie), ...kept];
    const page = watchPageWrites(session.cookies, desired);
    try {
      // 기존 행을 먼저 지운다. Chromium 은 Secure 가 아닌 쿠키로 같은 이름의 Secure 쿠키를 덮지 못하게 해서
      // (EXCLUDE_OVERWRITE_SECURE) 덮어쓰기 순서로는 두 브라우저의 Secure 표시가 다른 한 행 때문에 전체가 실패한다.
      // 단계 안에서는 동시에 보냄: 하나씩 기다리면 2천 개에 수 초, 그동안 이 범위 통신이 막힘
      await Promise.all(before.filter(c => !preserveCookie(c)).map(c => session.cookies.remove(removeUrl(c), c.name)));
      await Promise.all(writes.map(({ details }) => session.cookies.set(details)));
      const after = (await session.cookies.get({})).filter(c => scope(c.domain));
      page.stop();
      const ours = list => list.filter(c => !page.keys.has(cookieKey(c)));
      if (cookieFingerprint(ours(after)) !== cookieFingerprint(ours(expected))) {
        throw Object.assign(new Error("cookie-readback-mismatch"), { cookies: mismatchedCookies(ours(after), ours(expected)) });
      }
      await session.cookies.flushStore();
      return { changed: 1, refreshed: incoming.length, live: incoming.length, staged: 0,
        skipped: list.length - incoming.length, decision, after };
    } catch (e) {
      page.stop();
      const reason = { message: String(e && e.message || e).slice(0, 200), ...(e && e.cookies ? { cookies: e.cookies } : {}) };
      let failures = 0;
      try {
        const originals = new Set(before.map(cookieKey));
        for (const c of (await session.cookies.get({})).filter(c => scope(c.domain))) {
          if (!originals.has(cookieKey(c))) {
            try { await session.cookies.remove(removeUrl(c), c.name); } catch { failures++; }
          }
        }
      } catch { failures++; }
      for (const { details } of rollback) { try { await session.cookies.set(details); } catch { failures++; } }
      try {
        const restored = (await session.cookies.get({})).filter(c => scope(c.domain));
        if (cookieFingerprint(restored) !== cookieFingerprint(before)) failures++;
        await session.cookies.flushStore();
      } catch { failures++; }
      return { error: failures ? "cookie-rollback-incomplete" : "cookie-transfer-failed", rolledBack: failures === 0, changed: 0, reason };
    }
  });
}
// 대상에 같은 key(도메인·경로·이름)가 없는 쿠키만 넣음. 이미 있는 쿠키는 값이 달라도 그대로
// 실패하면 이번에 넣은 key 만 지움. 원래 있던 쿠키는 건드리지 않으므로 복원할 것이 없음
async function addMissingCookies({ session, transfer, scope, list }) {
  const prepared = list.map(c => ({ cookie: c, details: cookieDetails(c) }));
  if (prepared.some(({cookie}) => !scope(cookie.domain))) throw new Error("cookie-outside-scope");
  return transfer.run(requestScopeFor(scope), async () => {
    const before = (await session.cookies.get({})).filter(c => scope(c.domain));
    const have = new Set(before.map(cookieKey));
    const adds = [...new Map(prepared.filter(p => !have.has(cookieKey(p.cookie))).map(p => [cookieKey(p.cookie), p])).values()];
    const desired = new Map(adds.map(p => [cookieKey(p.cookie), p.cookie]));
    const page = watchPageWrites(session.cookies, desired);
    const mine = c => desired.has(cookieKey(c)) && !page.keys.has(cookieKey(c));
    try {
      await Promise.all(adds.map(({ details }) => session.cookies.set(details)));
      const after = (await session.cookies.get({})).filter(c => scope(c.domain));
      page.stop();
      const want = [...desired.values()].filter(mine), got = after.filter(mine);
      if (cookieFingerprint(got) !== cookieFingerprint(want)) {
        throw Object.assign(new Error("cookie-readback-mismatch"), { cookies: mismatchedCookies(got, want) });
      }
      await session.cookies.flushStore();
      return { added: adds.length, kept: list.length - adds.length };
    } catch (e) {
      page.stop();
      const reason = { message: String(e && e.message || e).slice(0, 200), ...(e && e.cookies ? { cookies: e.cookies } : {}) };
      let failures = 0;
      try {
        for (const c of (await session.cookies.get({})).filter(c => scope(c.domain) && mine(c))) {
          try { await session.cookies.remove(removeUrl(c), c.name); } catch { failures++; }
        }
        // remove(url, name) 는 그 URL 로 보내질 같은 이름의 기존 쿠키(상위 path)까지 지울 수 있음
        const left = new Set((await session.cookies.get({})).filter(c => scope(c.domain)).map(cookieKey));
        for (const c of before) {
          if (left.has(cookieKey(c))) continue;
          try { await session.cookies.set(cookieDetails(c)); } catch { failures++; }
        }
        await session.cookies.flushStore();
      } catch { failures++; }
      return { error: failures ? "cookie-rollback-incomplete" : "cookie-transfer-failed", rolledBack: failures === 0, added: 0, reason };
    }
  });
}
module.exports = { cookieDetails, replaceCookieSnapshot, addMissingCookies };
