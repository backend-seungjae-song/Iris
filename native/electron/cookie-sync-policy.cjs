// 자동 복구는 로그인 한 벌의 출처를 비교한다. 쿠키별 만료 시각은 발급 순서가 아니다.
const { createHash } = require("node:crypto");

const GOOGLE_AUTH = new Set(["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"]);
function cookieKey(c) { return JSON.stringify([c.domain, c.path || "/", c.name]); }
function cookieFingerprint(cookies, attributes = true) {
  const rows = cookies.map((c) => [cookieKey(c), String(c.value || ""), ...(attributes ? [!!c.secure, !!c.httpOnly, c.sameSite || "unspecified", Math.floor(Number(c.expirationDate) || 0)] : [])]).sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function loginCookies(cookies, base) {
  return base === "google.com" ? cookies.filter((c) => GOOGLE_AUTH.has(c.name))
    : cookies.filter(c => c.secure && c.httpOnly);
}
function loginFingerprint(cookies, base) { return cookieFingerprint(loginCookies(cookies, base), false); }
// 같은 계정 세션도 값을 바꾸지 않고 만료를 연장할 수 있다. 재시도 차단은 identity와 분리한다.
function sourceRevision(cookies, base) { return cookieFingerprint(loginCookies(cookies, base), true); }
function hasLogin(cookies, base) {
  const selected = loginCookies(cookies, base);
  return base === "google.com"
    ? selected.some((c) => c.name === "SID") && selected.some((c) => c.name === "HSID")
    : selected.length > 0;
}
function planCookieRefresh({ source, target, base, cid, previous, recovering = false }) {
  if (!hasLogin(source, base)) return { apply: false, reason: "no-source-session" };
  const sourceFingerprint = loginFingerprint(source, base);
  const targetFingerprint = loginFingerprint(target, base);
  const known = previous && previous.cid === cid ? previous : null;
  const revision = sourceRevision(source, base);
  const state = { cid, sourceFingerprint, sourceRevision: revision, targetFingerprint };
  if (recovering) {
    if (known && known.attempted === revision) return { apply: false, reason: "already-attempted" };
    return { apply: true, reason: "login-recovery", state };
  }
  if (!hasLogin(target, base)) return { apply: false, reason: "login-required" };
  if (sourceFingerprint === targetFingerprint) return { apply: false, reason: "same-session" };
  if (!known) return { apply: false, reason: "untracked-session" };
  if (targetFingerprint !== known.targetFingerprint) return { apply: false, reason: "local-session-changed" };
  if (sourceFingerprint === known.sourceFingerprint) return { apply: false, reason: "source-unchanged" };
  return { apply: true, reason: "source-session-changed", state };
}
module.exports = { cookieKey, cookieFingerprint, loginFingerprint, sourceRevision, planCookieRefresh };
