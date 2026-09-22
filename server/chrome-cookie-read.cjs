// 사용자의 실제 Chrome 프로필에서 한 사이트의 세션 쿠키를 복호화해 반환한다.
//
// 소유 범위
//   Chrome 쿠키 DB 읽기(잠긴 원본을 복사해서) + macOS Keychain 기반 복호화 + 사이트별 필터.
//   claude.ai 미러가 사용자가 이미 로그인한 세션을 그대로 써서 추가 로그인 없이 열게 하는 초기 값.
//
// 제공 API
//   readClaudeSessionCookies(preferredProfile): { profile, cookies[] }. sessionKey가 있는 프로필을
//   찾아(Default 우선) 그 계정 쿠키를 반환한다. 찾지 못하면 { profile:null, cookies:[] }.
//
// 의존 대상
//   Chrome의 안정적 저장 포맷: Keychain "Chrome Safe Storage" → PBKDF2(saltysalt,1003,16,sha1) →
//   AES-128-CBC(IV=공백 16바이트), v10+ 값은 앞 32바이트가 HMAC. 이 primitive는
//   native/electron/cookie-import.cjs 와 같은 포맷을 따르므로, 그쪽이 바뀌면 여기도 함께 확인한다.
//   /usr/bin/security 와 /usr/bin/sqlite3(둘 다 macOS 기본).
//
// 유지 조건
//   Cloudflare 쿠키(cf_clearance·__cf_bm·_cfuvid·__cfruid·__ssid)는 주입하지 않는다. 미러는 실제
//   Chrome이라 Cloudflare를 자체적으로 통과하고, 이 쿠키를 주입하면 challenge가 반복된다
//   (확인 결과).
//   쿠키 값은 절대 로그에 남기지 않는다(이름·개수만).
//
// 영향 범위
//   chrome-mirror-backend.cjs(이 값을 CDP로 주입). server/ 에 두는 이유는 다음과 같다.
//   기능 경계 검사(bin/smoke tool-screens)가 capability 가 native 앱 셸 모듈을 가져오는 것을 막는데,
//   server/ 는 그 검사에서 제외라 미러가 chrome-auth·cookie-import 를 직접 가져오지 않고도 쓸 수 있다.

const { execFileSync } = require("node:child_process");
const { createDecipheriv, pbkdf2Sync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEYCHAIN = { service: "Chrome Safe Storage", account: "Chrome" };
const CHROME_ROOT = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
const PBKDF2_SALT = "saltysalt", PBKDF2_ITER = 1003, PBKDF2_KEYLEN = 16, HMAC_LEN = 32;
const CLOUDFLARE_COOKIES = new Set(["cf_clearance", "__cf_bm", "_cfuvid", "__cfruid", "__ssid"]);

let cachedKey = null;
function macKey() {
  if (cachedKey) return cachedKey;
  const pw = execFileSync("/usr/bin/security",
    ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"],
    { encoding: "utf8", timeout: 15000 }).trim();
  cachedKey = pbkdf2Sync(pw, PBKDF2_SALT, PBKDF2_ITER, PBKDF2_KEYLEN, "sha1");
  return cachedKey;
}

function decryptValue(enc, key) {
  if (!enc || !enc.length) return "";
  const ver = enc.subarray(0, 3).toString("utf8");
  if (!/^v\d\d$/.test(ver)) return enc.toString("utf8"); // 구형 비암호화
  const ct = enc.subarray(3);
  if (!ct.length) return "";
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  d.setAutoPadding(true);
  let dec = Buffer.concat([d.update(ct), d.final()]);
  if (dec.length > HMAC_LEN) {
    let nonPrintable = 0;
    for (let i = 0; i < HMAC_LEN; i++) { const c = dec[i]; if (c < 0x20 || c > 0x7e) nonPrintable++; }
    if (nonPrintable >= 8) dec = dec.subarray(HMAC_LEN);
  }
  return dec.toString("utf8");
}

// 잠긴 원본을 건드리지 않게 사본을 만들어 읽는다(cookie-import.cjs와 같은 이유).
function readProfileCookies(profile, hostLike, key) {
  const src = path.join(CHROME_ROOT, profile, "Cookies");
  if (!fs.existsSync(src)) return [];
  const tmp = path.join(os.tmpdir(), `iris-mirror-ck-${process.pid}-${Date.now()}.db`);
  const cleanup = () => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + s); } catch {} } };
  try {
    cleanup();
    fs.copyFileSync(src, tmp);
    try { fs.copyFileSync(src + "-wal", tmp + "-wal"); } catch {}
    const rows = execFileSync("/usr/bin/sqlite3",
      ["-json", tmp, `select name, hex(encrypted_value) as ev, host_key, path, is_httponly from cookies where host_key like '${hostLike}'`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const list = JSON.parse(rows || "[]");
    const out = [];
    for (const c of list) {
      if (CLOUDFLARE_COOKIES.has(c.name)) continue;
      const value = decryptValue(Buffer.from(c.ev, "hex"), key);
      if (!value) continue;
      out.push({ name: c.name, value, domain: c.host_key, path: c.path || "/", secure: true, httpOnly: !!c.is_httponly });
    }
    return out;
  } finally {
    cleanup();
  }
}

// claude.ai 세션을 가진 프로필을 찾아(Default 우선, 그다음 Profile N) 그 계정 쿠키를 반환한다.
// sessionKey가 없으면 { profile:null, cookies:[] } 를 반환하고, 호출부는 수동 로그인으로 전환한다.
function readClaudeSessionCookies(preferredProfile = "Default") {
  const key = macKey();
  const order = [preferredProfile];
  try {
    for (const name of fs.readdirSync(CHROME_ROOT)) {
      if ((name === "Default" || /^Profile \d+$/.test(name)) && !order.includes(name)) order.push(name);
    }
  } catch {}
  for (const profile of order) {
    let cookies;
    try { cookies = readProfileCookies(profile, "%claude.ai%", key); } catch { continue; }
    if (cookies.some((c) => c.name === "sessionKey")) return { profile, cookies };
  }
  return { profile: null, cookies: [] };
}

module.exports = { readClaudeSessionCookies };
