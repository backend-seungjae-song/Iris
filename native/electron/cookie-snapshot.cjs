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
  const url = new URL((c.secure ? "https://" : "http://") + host + "/");
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
    for (const c of before) if (preserveCookie(c)) desired.set(cookieKey(c), c);
    const expected = new Set(desired.keys());
    try {
      // 기존 행을 먼저 지운다. Chromium 은 Secure 가 아닌 쿠키로 같은 이름의 Secure 쿠키를 덮지 못하게 해서
      // (EXCLUDE_OVERWRITE_SECURE) 덮어쓰기 순서로는 두 브라우저의 Secure 표시가 다른 한 행 때문에 전체가 실패한다.
      for (const c of before) if (!preserveCookie(c)) await session.cookies.remove(removeUrl(c), c.name);
      for (const { cookie, details } of prepared) if (!preserveCookie(cookie)) await session.cookies.set(details);
      const after = (await session.cookies.get({})).filter(c => scope(c.domain));
      if (cookieFingerprint(after) !== cookieFingerprint([...desired.values()])) throw new Error("cookie-readback-mismatch");
      await session.cookies.flushStore();
      return { changed: 1, refreshed: incoming.length, live: incoming.length, staged: 0,
        skipped: list.length - incoming.length, decision, after };
    } catch {
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
      return { error: failures ? "cookie-rollback-incomplete" : "cookie-transfer-failed", rolledBack: failures === 0, changed: 0 };
    }
  });
}
module.exports = { cookieDetails, replaceCookieSnapshot };
