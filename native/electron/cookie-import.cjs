// 쿠키 임포트: 실제 로그인 세션을 persist:acbrowser 파티션에 넣는다.
// Orca(src/main/browser/browser-cookie-import.ts)의 안정 스냅샷·원본 행 스테이징·콜드스타트
// 재생 구조를 macOS + sqlite3 CLI 환경에 맞춰 이식한다.
const { app, dialog, session } = require("electron");
const { applyHardening } = require("./browser-hardening.cjs");
// 허용 partition 형식의 소유자는 profile-session-policy.cjs 하나다. 같은 정규식을 여기 한 벌 더
// 두면 두 벌이 달라져, webview 는 허용되는데 UA 저장·cookie import 는 거절되는 프로필이 생긴다.
// 그래서 판정을 그 모듈에서 가져다 쓴다.
const { isProfilePartition } = require("./profile-session-policy.cjs");
const { createDecipheriv, pbkdf2Sync } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PBKDF2_SALT = "saltysalt", PBKDF2_ITER = 1003, PBKDF2_KEYLEN = 16;
const CHROMIUM_EPOCH_OFFSET = 11644473600n;
const HMAC_LEN = 32;
const SNAPSHOT_ATTEMPTS = 5;
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
const COOKIE_DB_PATH = Symbol("cookieDbPath");
const COOKIE_CAS_TABLE = "iris_cookie_import_baseline";
const COOKIE_CAS_GUARD = "iris_cookie_import_guard";
const { baseDomain } = require("./chrome-auth.cjs");
const { cookieFingerprint, loginFingerprint, sourceRevision, planCookieRefresh } = require("./cookie-sync-policy.cjs");
const { replaceCookieSnapshot } = require("./cookie-snapshot.cjs");
const { createCookieTransfer } = require("./cookie-transfer.cjs");
const cookieTransfers = new WeakMap();
const cookieScopes = new WeakMap();
const transferRequestScopes = new WeakMap();
function transferFor(sess) {
  if (!cookieTransfers.has(sess)) cookieTransfers.set(sess, createCookieTransfer(sess));
  return cookieTransfers.get(sess);
}
// cookie-transfer는 완료된 범위 predicate를 늦은 Set-Cookie 차단에 보관한다. 같은 사이트를 점검할
// 때마다 새 closure를 만들지 않고 정규화한 base 집합별로 재사용해 반복 점검의 Set 증가를 막는다.
function scopeFor(sess, bases) {
  let scopes = cookieScopes.get(sess);
  if (!scopes) { scopes = new Map(); cookieScopes.set(sess, scopes); }
  const normalized = bases == null ? null : [...new Set([...bases].map(baseDomain).filter(Boolean))].sort();
  const key = normalized == null ? "*" : normalized.join("\n");
  if (!scopes.has(key)) {
    const accepted = normalized == null ? null : new Set(normalized);
    scopes.set(key, (domain) => accepted == null || accepted.has(baseDomain(domain)));
  }
  return scopes.get(key);
}
function transferRequestScopeFor(scope) {
  let requestScope = transferRequestScopes.get(scope);
  if (!requestScope) {
    requestScope = details => {
      try { return scope(new URL(details.url).hostname); } catch { return false; }
    };
    transferRequestScopes.set(scope, requestScope);
  }
  return requestScope;
}
function syncRecordsPath() { return path.join(app.getPath("userData"), "browser-cookie-sync.json"); }
let syncRecordsCache;
function syncRecords() {
  if (!syncRecordsCache) {
    try { syncRecordsCache = JSON.parse(fs.readFileSync(syncRecordsPath(), "utf8")); } catch {}
    if (!syncRecordsCache || typeof syncRecordsCache !== "object" || Array.isArray(syncRecordsCache)) syncRecordsCache = {};
  }
  return syncRecordsCache;
}
function rememberSync(partition, base, record) {
  const records = syncRecords();
  records[partition + "\n" + base] = record;
  try {
    const file = syncRecordsPath(), tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 현재 실행의 재시도 차단은 메모리 기록으로 유지한다. */ }
}
async function rememberImportedSnapshot(partition, entry, cookies, { pending = false } = {}) {
  const target = await session.fromPartition(partition).cookies.get({});
  for (const base of new Set(cookies.map(c => baseDomain(c.domain)))) {
    const select = (list) => list.filter(c => baseDomain(c.domain) === base);
    const sourceFingerprint = loginFingerprint(select(cookies), base);
    const revision = sourceRevision(select(cookies), base);
    // pending raw replay는 아직 target에 들어가지 않았다. source cohort와 이 브라우저에 남길
    // 결속 쿠키를 합친 기대 상태를 기록해야 재생 성공 뒤 정상 refresh provenance가 이어진다.
    // CAS가 replay를 버리면 실제 target과 이 기대 hash가 달라져 local-session-changed로 보존된다.
    const expected = pending
      ? [...select(cookies), ...select(target).filter(c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name))]
      : select(target);
    rememberSync(partition, base, { cid: entry.browser.id + ":" + entry.profile,
      sourceFingerprint, sourceRevision: revision,
      targetFingerprint: loginFingerprint(expected, base), attempted: revision });
  }
}


// ── 공통: cookies.set 주입 ────────────────────────────────────────────────
function stripNonPrintable(s) { return typeof s === "string" ? s.replace(/[^\x09\x0a\x0d\x20-￿]/g, "") : s; }

function sameSiteFromInt(n) {
  switch (Number(n)) { case 2: return "strict"; case 1: return "lax"; case 0: return "no_restriction"; default: return "unspecified"; }
}
function sameSiteFromString(s) {
  const v = String(s || "").toLowerCase();
  if (v === "strict") return "strict";
  if (v === "lax") return "lax";
  if (v === "no_restriction" || v === "none") return "no_restriction";
  return "unspecified";
}
function cookieUrl(domain, _cpath, secure) {
  const host = String(domain || "").replace(/^\./, "");
  if (!host || /[\s/\\@?#:]/.test(host)) return null;
  // path를 URL 문자열에 이어 붙이면 외부 JSON의 `@host` 같은 값이 origin을 바꿀 수 있다.
  // URL은 검증한 host의 루트로만 만들고 실제 쿠키 path는 cookies.set의 별도 필드로 넘긴다.
  try {
    const url = new URL((secure ? "https://" : "http://") + host + "/");
    return url.hostname === host.toLowerCase() ? url.toString() : null;
  }
  catch { return null; }
}

// list: [{domain,name,value,path,secure,httpOnly,sameSite,expirationDate}] → persist 파티션에 주입.
async function setCookies(sess, list) {
  const domains = new Set(); let imported = 0, skipped = 0;
  for (const c of list) {
    try {
      const url = cookieUrl(c.domain, c.path, c.secure);
      if (!url || !c.name) { skipped++; continue; }
      const isHostPrefixed = String(c.name).startsWith("__Host-");
      const set = {
        url, name: String(c.name), value: stripNonPrintable(String(c.value == null ? "" : c.value)),
        path: isHostPrefixed ? "/" : (c.path || "/"), secure: !!c.secure,
        httpOnly: !!c.httpOnly, sameSite: c.sameSite || "unspecified",
      };
      // __Host- 쿠키는 Domain을 가지면 Chromium이 거절한다. 그 밖의 도메인 쿠키만 명시한다.
      if (!isHostPrefixed && String(c.domain || "").startsWith(".")) set.domain = c.domain;
      if (c.expirationDate && Number(c.expirationDate) > 0) set.expirationDate = Number(c.expirationDate);
      await sess.cookies.set(set);
      imported++; domains.add(String(c.domain || "").replace(/^\./, ""));
    } catch { skipped++; }
  }
  return { imported, skipped, domains: [...domains].sort() };
}

// ── ④ JSON 파일 임포트 (Cookie-Editor export 등) ──────────────────────────
async function importCookiesFromFile(win) {
  const sess = session.fromPartition("persist:acbrowser");
  const r = await dialog.showOpenDialog(win, {
    title: "쿠키 JSON 가져오기", properties: ["openFile"],
    filters: [{ name: "쿠키 JSON", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")); }
  catch (e) { return { error: "JSON 파싱 실패: " + e.message }; }
  if (!Array.isArray(arr)) arr = arr && Array.isArray(arr.cookies) ? arr.cookies : null;
  if (!Array.isArray(arr)) return { error: "쿠키 배열을 찾을 수 없습니다(Cookie-Editor export 형식 필요)." };
  const list = arr.map((c) => ({
    domain: c.domain || c.host, name: c.name, value: c.value, path: c.path || "/",
    secure: !!c.secure, httpOnly: !!(c.httpOnly || c.httponly),
    sameSite: sameSiteFromString(c.sameSite || c.samesite),
    expirationDate: c.expirationDate || c.expires || 0,
  }));
  return await setCookies(sess, list);
}

// ── ⑤ 설치된 Chrome에서 직접 임포트 (macOS) ───────────────────────────────
// 브라우저별 Keychain service + 프로필 루트.
const CHROMIUM_BROWSERS = [
  { id: "chrome", label: "Google Chrome", root: "Google/Chrome", app: "Google Chrome", service: "Chrome Safe Storage", account: "Chrome" },
  { id: "brave", label: "Brave", root: "BraveSoftware/Brave-Browser", app: "Brave Browser", service: "Brave Safe Storage", account: "Brave" },
  { id: "edge", label: "Microsoft Edge", root: "Microsoft Edge", app: "Microsoft Edge", service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
];

// 실제 렌더링 엔진(Electron 이 품은 Chromium)의 버전을 UA·힌트의 Chrome/Edg 버전으로 고정한다.
// 설계 이유: 소스 브라우저 버전(예: 152)을 그대로 쓰면 UA 는 152 인데 엔진은 150 이라 일치하지 않고,
// Cloudflare Turnstile 은 이 불일치를 automation 으로 판정해 챌린지를 실패시킨다. 사용자가 눌러도
// 위젯이 뜨지 않고 결과가 0 이 된다(확인 결과: 격리 하네스에서 UA 152 강제 시 ahrefs 결과 0행,
// 엔진과 같은 150 이면 20행. CDP 로드부착·detach·setAutoAttach·재부착은 20행에
// 영향이 없었고 이 값만 결과를 갈랐다). 그래서 UA 는 엔진 버전을 그대로 사용한다.
function pinEngineVersion(ua) {
  const v = process.versions.chrome;
  if (typeof ua !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(v || "")) return ua;
  return ua
    .replace(/Chrome\/\d+(?:\.\d+){1,3}/, `Chrome/${v}`)
    .replace(/Edg\/\d+(?:\.\d+){1,3}/, `Edg/${v}`);
}
function sourceBrowserUserAgent(browser) {
  if (process.platform !== "darwin" || !browser || !browser.app) return null;
  // 소스 브라우저의 버전이 아니라 실제 엔진 버전을 고정한다(위 pinEngineVersion 주석 참조). 브랜드
  // (Edge 여부)만 소스에서 취한다.
  const version = process.versions.chrome;
  if (!/^\d+(?:\.\d+){1,3}$/.test(version || "")) return null;
  const platform = "Macintosh; Intel Mac OS X 10_15_7";
  const base = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return browser.id === "edge" ? `${base} Edg/${version}` : base;
}

function partitionUserAgentsPath() {
  return path.join(app.getPath("userData"), "browser-import-user-agents.json");
}
function readPartitionUserAgents() {
  try {
    const value = JSON.parse(fs.readFileSync(partitionUserAgentsPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = {};
    for (const [partition, userAgent] of Object.entries(value)) {
      if (isProfilePartition(partition) && typeof userAgent === "string" && /^Mozilla\/5\.0 /.test(userAgent)) {
        // 소스 버전으로 저장된 UA 도 읽는 순간 엔진 버전으로 정규화한다. 재-import 없이도
        // 이미 152 로 고정된 파티션(예: 기본)이 Turnstile 에서 automation 으로 판정되지 않게 한다(pinEngineVersion 주석).
        result[partition] = pinEngineVersion(userAgent.slice(0, 512));
      }
    }
    return result;
  } catch { return {}; }
}
function persistPartitionUserAgent(partition, userAgent) {
  if (!isProfilePartition(partition) || typeof userAgent !== "string") return false;
  try {
    const file = partitionUserAgentsPath();
    const tmp = `${file}.tmp-${process.pid}`;
    const value = { ...readPartitionUserAgents(), [partition]: userAgent.slice(0, 512) };
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
function userAgentForPartition(partition) {
  return isProfilePartition(String(partition || ""))
    ? readPartitionUserAgents()[partition] || null
    : null;
}
function applyImportedUserAgent(sess, partition, browser) {
  const userAgent = sourceBrowserUserAgent(browser);
  if (!userAgent) return null;
  // 가져온 브라우저의 표시는 출처 기록이며, 실행 중인 Electron의 정체성을 바꾸지 않는다.
  applyHardening(sess);
  persistPartitionUserAgent(partition, userAgent);
  return userAgent;
}
function rememberBrowserUserAgent(partition, browserId) {
  const part = String(partition || "");
  if (!isProfilePartition(part)) return false;
  const browser = CHROMIUM_BROWSERS.find((item) => item.id === browserId);
  const userAgent = sourceBrowserUserAgent(browser);
  return !!userAgent && persistPartitionUserAgent(part, userAgent);
}
function applyBrowserUserAgentToPartition(partition, browserId) {
  const part = String(partition || "");
  if (!isProfilePartition(part)) return false;
  const browser = CHROMIUM_BROWSERS.find((item) => item.id === browserId);
  if (!browser) return false;
  return !!applyImportedUserAgent(session.fromPartition(part), part, browser);
}

// Chromium 96+는 Network/Cookies로 옮겼지만 오래된 프로필은 루트 Cookies를 계속 쓴다.
// 쓰기·읽기 양쪽이 같은 우선순위를 써야 최신 DB를 읽고 옛 DB에 쓰는 분기가 생기지 않는다.
function resolveChromiumCookiesPath(profileDir) {
  const network = path.join(profileDir, "Network", "Cookies");
  if (fs.existsSync(network)) return network;
  const legacy = path.join(profileDir, "Cookies");
  return fs.existsSync(legacy) ? legacy : null;
}

// 브라우저 루트의 Local State에서 프로필 디렉터리→정보 맵을 읽는다.
// 이름(`name`)은 표시용이다. 사용자가 언제든 바꿀 수 있고 서로 같은 이름을 쓸 수도 있다.
// 그 프로필의 정체성을 정하는 것은 로그인한 계정(`user_name` = 이메일, `gaia_id`)이다.
function readProfileInfo(broot) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(broot, "Local State"), "utf8"));
    const cache = (j && j.profile && j.profile.info_cache) || {};
    const map = {};
    for (const k of Object.keys(cache)) {
      const v = cache[k] || {};
      map[k] = { name: v.name ? String(v.name) : "", account: v.user_name ? String(v.user_name) : "", gaia: v.gaia_id ? String(v.gaia_id) : "" };
    }
    return map;
  } catch { return {}; }
}

// 설치된 브라우저×프로필 중 Cookies DB 있는 것 목록. label은 실제 프로필 이름(있으면).
function listChromeProfiles() {
  if (process.platform !== "darwin") return [];
  const base = path.join(os.homedir(), "Library", "Application Support");
  const out = [];
  for (const b of CHROMIUM_BROWSERS) {
    const broot = path.join(base, b.root);
    if (!fs.existsSync(broot)) continue;
    let profiles;
    try { profiles = fs.readdirSync(broot); } catch { continue; }
    const info = readProfileInfo(broot);
    for (const p of profiles) {
      if (!(p === "Default" || /^Profile \d+$/.test(p))) continue;
      const profileDir = path.join(broot, p);
      const db = resolveChromiumCookiesPath(profileDir);
      if (db) {
        const i = info[p] || {};
        const nm = i.name; // 사용자 지정 이름 우선, 없으면 디렉터리명
        // password-import.cjs는 dbPath의 부모에서 Login Data를 찾는다. 최신 쿠키가 Network 아래에
        // 있어도 그 계약은 프로필 루트를 가리키게 두고, 실제 Cookies 경로는 직렬화되지 않는 내부값이다.
        const entry = { browser: b, profile: p, dbPath: path.join(profileDir, "Cookies"),
          account: i.account || "", gaia: i.gaia || "", label: nm ? `${b.label} — ${nm}` : `${b.label} — ${p}` };
        Object.defineProperty(entry, COOKIE_DB_PATH, { value: db });
        out.push(entry);
      }
    }
  }
  return out;
}

function chromiumTsToUnix(ts) {
  try { const b = BigInt(ts || 0); if (b === 0n) return 0; return Math.max(Number(b / 1000000n - CHROMIUM_EPOCH_OFFSET), 0); }
  catch { return 0; }
}
function hasHmacPrefix(buf) {
  if (buf.length <= HMAC_LEN) return false;
  let np = 0; for (let i = 0; i < HMAC_LEN; i++) { const c = buf[i]; if (c < 0x20 || c > 0x7e) np++; }
  return np >= 8;
}
function stripHmac(buf) { return hasHmacPrefix(buf) ? buf.subarray(HMAC_LEN) : buf; }

// Keychain에서 Safe Storage 비밀번호 → PBKDF2 → 16바이트 AES 키.
// 프로세스가 실행되는 동안 한 번만 읽어 로그인 계승 중 키체인 승인을 반복해서 띄우지 않는다.
const macKeyCache = new Map();
function getMacKey(service, account) {
  const cacheKey = service + "\0" + account;
  const cached = macKeyCache.get(cacheKey);
  if (cached) return cached;
  const pw = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8", timeout: 30000 }).trim();
  const key = pbkdf2Sync(pw, PBKDF2_SALT, PBKDF2_ITER, PBKDF2_KEYLEN, "sha1");
  macKeyCache.set(cacheKey, key);
  return key;
}

// encrypted_value(Buffer) → 평문 바이트. Chromium 쿠키는 문자열이 아니라 바이트열이므로 스테이징
// DB에는 UTF-8 재인코딩 없이 그대로 넣는다.
function decryptValueRaw(enc, key, stripHmacPrefix = true) {
  if (!enc || enc.length === 0) return Buffer.alloc(0);
  const ver = enc.subarray(0, 3).toString("utf8");
  if (!/^v\d\d$/.test(ver)) return Buffer.from(enc); // 비암호화(구형): 기존 동작 유지
  const ct = enc.subarray(3);
  if (!ct.length) return Buffer.alloc(0);
  const iv = Buffer.alloc(16, " ");
  const d = createDecipheriv("aes-128-cbc", key, iv);
  d.setAutoPadding(true);
  const dec = Buffer.concat([d.update(ct), d.final()]);
  return stripHmacPrefix ? stripHmac(dec) : dec;
}

// password-import.cjs가 쓰는 기존 문자열 계약은 유지한다. Login Data는 HMAC prefix가 없으므로
// 세 번째 인자를 false로 호출하는 기존 경로도 그대로 보존된다.
function decryptValue(enc, key, stripHmacPrefix = true) {
  return decryptValueRaw(enc, key, stripHmacPrefix).toString("utf8");
}

function isMissingFileError(e) { return e && e.code === "ENOENT"; }
function readFileState(file) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return { dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs };
  } catch (e) { if (isMissingFileError(e)) return null; throw e; }
}
function sameFileState(a, b) {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}
function removeSnapshotFiles(db) {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + suffix); } catch {} }
}

// DB와 WAL의 복사 전후 상태가 같을 때만 채택한다. SHM은 잠길 수 있는 mmap 인덱스라 복사하지
// 않고, sqlite가 사본 옆에서 다시 만들게 한다(Orca #9355 경로와 같은 이유).
function copyStableAttempt(source, target) {
  const wal = source + "-wal";
  const dbBefore = readFileState(source), walBefore = readFileState(wal);
  if (!dbBefore) throw new Error("Chromium Cookies DB가 없습니다.");
  removeSnapshotFiles(target);
  fs.copyFileSync(source, target);
  if (walBefore) {
    try { fs.copyFileSync(wal, target + "-wal"); }
    catch (e) { if (isMissingFileError(e)) return false; throw e; }
  }
  const dbAfter = readFileState(source), walAfter = readFileState(wal);
  if (!sameFileState(dbBefore, dbAfter) || !sameFileState(walBefore, walAfter)) return false;
  const copiedDb = readFileState(target), copiedWal = readFileState(target + "-wal");
  return !!copiedDb && copiedDb.size === dbBefore.size && (walBefore ? !!copiedWal && copiedWal.size === walBefore.size : copiedWal === null);
}

function createChromiumCookieSnapshot(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cookie-import-"));
  const databasePath = path.join(dir, "Cookies");
  let keep = false;
  try {
    for (let n = 0; n < SNAPSHOT_ATTEMPTS; n++) {
      if (copyStableAttempt(source, databasePath)) {
        keep = true;
        return { databasePath, stable: true, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
      }
    }
    throw new Error("복사 중 Chromium Cookies DB가 계속 바뀌었습니다.");
  } finally { if (!keep) fs.rmSync(dir, { recursive: true, force: true }); }
}

// 안정 스냅샷이 열려 있는 브라우저의 격한 쓰기 때문에 실패해도 이전 이식본처럼 DB·WAL·SHM을
// 한 번 복사해 시도한다. 새 경로의 실패가 곧바로 기존 기능 삭제가 되지 않게 하는 롤백 경로다.
function createLegacyCookieSnapshot(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cdb-"));
  const databasePath = path.join(dir, "Cookies");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, databasePath + suffix); }
      catch { if (!suffix) throw new Error("Chromium Cookies DB 복사 실패"); }
    }
    return { databasePath, stable: false, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

function snapshotWithLegacyFallback(source) {
  try { return createChromiumCookieSnapshot(source); }
  catch { return createLegacyCookieSnapshot(source); }
}

function querySqlite(dbPath, sql) {
  return execFileSync("/usr/bin/sqlite3", ["-noheader", "-separator", "\x1f", dbPath, sql], {
    encoding: "utf8", maxBuffer: SQLITE_MAX_BUFFER,
  });
}

// 기존 export 계약. 일반 Chromium DB(Login Data 포함)는 안정 스냅샷 대상이 아니므로 종전처럼
// DB·WAL·SHM을 한 번 복사하고 질의한다.
function queryChromiumDb(dbPath, sql) {
  const snap = createLegacyCookieSnapshot(dbPath);
  try {
    const raw = querySqlite(snap.databasePath, sql);
    const rows = [];
    for (const line of raw.split("\n")) { if (line) rows.push(line.split("\x1f")); }
    return rows;
  } finally { snap.cleanup(); }
}

function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

// sqlite3 CLI에는 바인딩 API가 없다. 각 셀을 타입 표식 + hex로 읽으면 구분자·개행·NUL이 든
// 쿠키도 행 경계를 깨지 않고, INTEGER의 64비트 Chromium timestamp도 Number로 손실되지 않는다.
function encodedCellSql(name) {
  const q = quoteIdent(name);
  return `CASE typeof(${q}) WHEN 'null' THEN 'n' WHEN 'blob' THEN 'b'||hex(${q}) WHEN 'text' THEN 't'||hex(CAST(${q} AS BLOB)) WHEN 'integer' THEN 'i'||hex(CAST(${q} AS TEXT)) WHEN 'real' THEN 'r'||hex(CAST(${q} AS TEXT)) ELSE 'n' END`;
}
function decodeCell(raw) {
  const kind = raw.slice(0, 1), hex = raw.slice(1);
  if (kind === "n") return null;
  if (kind === "b") return Buffer.from(hex, "hex");
  const text = Buffer.from(hex, "hex").toString("utf8");
  if (kind === "i") return BigInt(text || "0");
  if (kind === "r") return Number(text || "0");
  return text;
}

function readTableInfo(dbPath, table = "cookies") {
  const name = String(table).replace(/'/g, "''");
  const raw = querySqlite(dbPath, `SELECT hex(name),hex(type),"notnull",hex(ifnull(dflt_value,'')),pk FROM pragma_table_info('${name}') ORDER BY cid;`);
  return raw.split("\n").filter(Boolean).map((line) => {
    const f = line.split("\x1f");
    return { name: Buffer.from(f[0], "hex").toString("utf8"), type: Buffer.from(f[1], "hex").toString("utf8"),
      notnull: Number(f[2] || 0), defaultValue: Buffer.from(f[3], "hex").toString("utf8"), pk: Number(f[4] || 0) };
  });
}

function readAllCookieRows(dbPath) {
  const columns = readTableInfo(dbPath);
  if (!columns.length) throw new Error("cookies 테이블 스키마를 찾지 못했습니다.");
  const select = columns.map((c) => encodedCellSql(c.name)).join(",");
  const raw = querySqlite(dbPath, `SELECT ${select} FROM cookies ORDER BY rowid;`);
  const rows = raw.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("\x1f");
    const row = {};
    for (let n = 0; n < columns.length; n++) row[columns[n].name] = decodeCell(fields[n] || "n");
    return row;
  });
  return { columns, rows };
}

function sqliteLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}
function parsedDefaultValue(raw) {
  let value = String(raw || "").trim();
  while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  if (!value || value.toUpperCase() === "NULL") return null;
  if (/^X'[0-9a-f]*'$/i.test(value)) return Buffer.from(value.slice(2, -1), "hex");
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(value)) return BigInt(value);
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  // Chromium cookies 스키마의 기본값은 정수·문자열·빈 BLOB이다. 알 수 없는 식은 실행하지 않는다.
  return value;
}
function fallbackColumnLiteral(column, sourceRow) {
  if (column.defaultValue) return sqliteLiteral(parsedDefaultValue(column.defaultValue));
  if (!column.notnull) return "NULL";
  const type = String(column.type || "").toUpperCase();
  if (column.name === "value" || column.name === "encrypted_value") return "X''";
  if (column.name === "top_frame_site_key") return "''";
  if (column.name === "source_port") return "-1";
  if (column.name === "last_update_utc") return sqliteLiteral(sourceRow.creation_utc == null ? 0 : sourceRow.creation_utc);
  if (type.includes("BLOB")) return "X''";
  if (type.includes("INT")) return "0";
  return "''";
}
function insertLiteral(column, sourceRow, decryptedValue) {
  if (column.name === "encrypted_value") return "X''";
  if (column.name === "value") return sqliteLiteral(decryptedValue);
  if (Object.prototype.hasOwnProperty.call(sourceRow, column.name)) {
    const value = sourceRow[column.name];
    if (value !== null || !column.notnull) return sqliteLiteral(value);
  }
  return fallbackColumnLiteral(column, sourceRow);
}

const INTEGRITY_COOKIE_NAMES = new Set(["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-STRP", "AEC"]);
function isIntegrityCookie(name, domain) {
  if (!INTEGRITY_COOKIE_NAMES.has(name)) return false;
  const d = String(domain || "").replace(/^\./, "");
  return d === "google.com" || d.endsWith(".google.com");
}

// 그 브라우저에만 유효한 쿠키. 가져오면 세션이 살아나는 것이 아니라 오히려 깨진다.
//
// cf_clearance 는 챌린지를 푼 클라이언트임을 증명하는 값이다. 푼 주체에 묶여 있어서 크롬이 푼
// 것을 다른 브라우저가 제시하면 Cloudflare 가 거부하고 다시 검사를 건다. __cf_bm 도 같은 성격의
// 봇 판정 쿠키다. 도메인을 가리지 않는 이유는 이 이름들이 Cloudflare 뒤에 있는 모든 사이트에서
// 같은 뜻이기 때문이다. 구글 무결성 쿠키와 달리 한 도메인의 사정이 아니다.
//
// 실제로 가져왔을 때 claude.com 이 사람 확인 페이지로 넘어가 체크박스가 계속 다시 떴고,
// 주소를 새로 입력해 들어가면 정상이었다. 새로 입력할 때는 TTL 때문에
// 새로고침이 건너뛰어져 크롬 사본이 덮이지 않은 것으로 읽힌다.
const CLIENT_BOUND_COOKIE_NAMES = new Set(["cf_clearance", "__cf_bm", "__cfruid", "_cfuvid"]);
function isClientBoundCookie(name) {
  return CLIENT_BOUND_COOKIE_NAMES.has(String(name || ""));
}
function storedValueBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "latin1");
  return Buffer.alloc(0);
}

function decryptCookieRows(sourceRows, key, hostFilter) {
  const list = []; let decryptSkipped = 0, integritySkipped = 0, partitionSkipped = 0;
  for (const sourceRow of sourceRows) {
    const domain = typeof sourceRow.host_key === "string" ? sourceRow.host_key : "";
    const name = typeof sourceRow.name === "string" ? sourceRow.name : "";
    if (!domain || !name || (hostFilter && !hostFilter(domain))) continue;
    if (isIntegrityCookie(name, domain)) { integritySkipped++; continue; }
    // 도전 풀이 증표는 가져오지 않는다. 가져오면 이 브라우저가 스스로 푼 것을 덮어써서
    // 다음 요청부터 다시 검사를 받는다.
    if (isClientBoundCookie(name)) { integritySkipped++; continue; }
    // 파티션 쿠키(CHIPS)는 Electron cookies API 로 넣을 수 없다. 섞여 있으면 교체 전체가 거부되어
    // 가져오기가 아무것도 넣지 못하므로 여기서 뺀다. 다른 사이트에 임베드된 상태라 로그인과는 무관하다.
    if (sourceRow.top_frame_site_key) { partitionSkipped++; continue; }
    let rawValue;
    try {
      const enc = Buffer.isBuffer(sourceRow.encrypted_value) ? sourceRow.encrypted_value : Buffer.alloc(0);
      rawValue = enc.length ? decryptValueRaw(enc, key) : storedValueBuffer(sourceRow.value);
    } catch { decryptSkipped++; continue; }
    list.push({
      domain, name, value: rawValue.toString("latin1"), rawValue, sourceRow,
      path: typeof sourceRow.path === "string" ? sourceRow.path : "/",
      secure: Number(sourceRow.is_secure || 0) === 1,
      httpOnly: Number(sourceRow.is_httponly || 0) === 1,
      sameSite: sameSiteFromInt(sourceRow.samesite),
      expirationDate: chromiumTsToUnix(sourceRow.expires_utc),
    });
  }
  return { list, decryptSkipped, integritySkipped, partitionSkipped };
}

function readSourceCookieRows(dbPath) {
  let snap;
  try {
    snap = createChromiumCookieSnapshot(dbPath);
    return { ...readAllCookieRows(snap.databasePath), stable: true };
  } catch {
    // 안정 복사는 됐어도 사본을 여는 단계에서 실패할 수 있다. 그 경우까지 종전 1회 복사로 재시도한다.
    try { snap?.cleanup(); } catch {}
    snap = createLegacyCookieSnapshot(dbPath);
    return { ...readAllCookieRows(snap.databasePath), stable: false };
  } finally { try { snap?.cleanup(); } catch {} }
}
function sourceCookieDbPath(profileEntry) { return profileEntry[COOKIE_DB_PATH] || profileEntry.dbPath; }

function stagingRoot() { return path.join(app.getPath("userData"), "cookie-import-staging"); }
function pendingManifestPath() { return path.join(stagingRoot(), "pending.json"); }
function normalizedScopeBases(bases) {
  if (!Array.isArray(bases)) return [];
  return [...new Set(bases.map(baseDomain).filter(Boolean))].sort();
}
function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function validPendingEntry(entry) {
  if (!entry || !["replace", "replace-scoped"].includes(entry.mode)
    || typeof entry.target !== "string" || typeof entry.staging !== "string") return false;
  // baseline이 없는 과거 merge/replace manifest는 새 Iris 로그인을 되감을 수 있다. 안전하게
  // migration할 원래 target snapshot이 없으므로 대상은 보존하고 평문 staging만 폐기한다.
  if (entry.cas !== true) return false;
  if (entry.mode === "replace-scoped") {
    const scopes = normalizedScopeBases(entry.scopes);
    if (!scopes.length || scopes.length !== entry.scopes.length
      || scopes.some((scope, index) => scope !== entry.scopes[index]
        || !cookieUrl(scope, "/", true))) return false;
  }
  const partitions = path.join(app.getPath("userData"), "Partitions");
  if (path.basename(entry.target) !== "Cookies" || !isWithin(partitions, entry.target) ||
      path.basename(entry.staging) !== "Cookies" || !isWithin(stagingRoot(), entry.staging)) return false;
  try {
    // manifest는 로컬 파일이지만 쿠키 DB 교체 권한을 갖는다. 심볼릭 링크로 허용 루트 밖 파일을
    // 읽거나 덮어쓰지 못하도록 실제 부모와 스테이징 파일도 다시 경계 안인지 확인한다.
    const realPartitions = fs.realpathSync(partitions);
    const realTargetParent = fs.realpathSync(path.dirname(entry.target));
    const targetInfo = fs.lstatSync(entry.target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) return false;
    const realTarget = fs.realpathSync(entry.target);
    const realStagingRoot = fs.realpathSync(stagingRoot());
    if (fs.lstatSync(entry.staging).isSymbolicLink()) return false;
    const realStaging = fs.realpathSync(entry.staging);
    return isWithin(realPartitions, realTargetParent) && isWithin(realPartitions, realTarget)
      && isWithin(realStagingRoot, realStaging) &&
      fs.statSync(realStaging).isFile();
  } catch { return false; }
}
function readPendingEntries() {
  try {
    const value = JSON.parse(fs.readFileSync(pendingManifestPath(), "utf8"));
    if (!Array.isArray(value)) return [];
    const valid = [], invalid = [];
    for (const entry of value) (validPendingEntry(entry) ? valid : invalid).push(entry);
    if (invalid.length) {
      for (const entry of invalid) if (entry && typeof entry.staging === "string") discardStagingDatabase(entry.staging);
      writePendingEntries(valid);
    }
    return valid;
  } catch { return []; }
}
function writePendingEntries(entries) {
  const manifest = pendingManifestPath();
  if (!entries.length) { try { fs.unlinkSync(manifest); } catch {} return; }
  fs.mkdirSync(stagingRoot(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stagingRoot(), 0o700); } catch {}
  const tmp = manifest + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
  fs.renameSync(tmp, manifest);
}
function discardStagingDatabase(databasePath) {
  if (!databasePath || !isWithin(stagingRoot(), databasePath)) return;
  try { fs.rmSync(path.dirname(databasePath), { recursive: true, force: true }); } catch {}
}
function clearPendingCookieImport(target) {
  const kept = [];
  for (const entry of readPendingEntries()) {
    if (path.resolve(entry.target) === path.resolve(target)) discardStagingDatabase(entry.staging);
    else kept.push(entry);
  }
  writePendingEntries(kept);
}
// 스테이징 DB는 복호화된 쿠키 값을 평문으로 들고 있다(sqlite3가 ATTACH로 읽어야 해서 암호화할 수
// 없다). 그래서 오래 두지 않는 것이 유일한 방어다. 재생이 실패한 항목을 그대로 남기면 실행할
// 때마다 계속 재시도하고, 평문 DB도 그만큼 오래 디스크에 남는다.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;   // 하루가 지나면 버린다
const PENDING_MAX_ATTEMPTS = 3;               // 세 번 실패하면 버린다
function registerPendingCookieImport(target, staging, mode, scopes = []) {
  const next = { mode, target: path.resolve(target), staging: path.resolve(staging), createdAt: Date.now(), attempts: 0,
    ...(mode === "replace-scoped" ? { scopes: normalizedScopeBases(scopes) } : {}),
    ...(mode === "replace" || mode === "replace-scoped" ? { cas: true } : {}) };
  if (!validPendingEntry(next)) return false;
  try {
    const entries = readPendingEntries();
    const kept = [];
    for (const old of entries) {
      if (path.resolve(old.target) === path.resolve(target)) discardStagingDatabase(old.staging);
      else kept.push(old);
    }
    kept.push(next);
    writePendingEntries(kept);
    return true;
  } catch { return false; }
}

function scopedCookieSql(scopes) {
  const host = "lower(ltrim(host_key,'.'))";
  return normalizedScopeBases(scopes).map((base) =>
    `(${host}=${sqliteLiteral(base)} OR substr(${host},-${base.length + 1})=${sqliteLiteral("." + base)})`).join(" OR ");
}

function cookieCasColumns(columns) {
  // 접근만 해도 변하는 시각은 빼되, 알려지지 않은 새 스키마 필드는 보수적으로 포함한다. 따라서
  // key/value/암호문/만료·보안 flag 중 하나라도 바뀌면 오래된 스테이징을 적용하지 않는다.
  const selected = columns.filter((column) => column.name !== "last_access_utc").map((column) => column.name);
  for (const required of ["host_key", "name", "path", "value", "encrypted_value"]) {
    if (!selected.includes(required)) throw new Error("쿠키 CAS 스키마가 불완전합니다.");
  }
  return selected;
}

function cookieCasGuardStatements(entry) {
  const columns = cookieCasColumns(readTableInfo(entry.staging, COOKIE_CAS_TABLE)).map(quoteIdent).join(",");
  const target = `SELECT ${columns} FROM main.cookies${entry.mode === "replace-scoped"
    ? ` WHERE ${scopedCookieSql(entry.scopes)}` : ""}`;
  const baseline = `SELECT ${columns} FROM imported.${quoteIdent(COOKIE_CAS_TABLE)}`;
  const same = `NOT EXISTS (${target} EXCEPT ${baseline}) AND NOT EXISTS (${baseline} EXCEPT ${target})`;
  return [
    `CREATE TEMP TABLE ${quoteIdent(COOKIE_CAS_GUARD)}(ok INTEGER NOT NULL);`,
    `INSERT INTO temp.${quoteIdent(COOKIE_CAS_GUARD)} VALUES(CASE WHEN ${same} THEN 1 ELSE 0 END);`,
  ];
}

// replace-scoped는 handoff 사이트 범위만 한 벌로 바꾸고, replace는 사람이 선택한 명시적 전체
// import를 재생한다. 둘 다 원래 target snapshot과 CAS가 맞을 때만 적용한다.
function replayStagedCookieDatabase(entry) {
  const target = entry.target, staging = entry.staging;
  if (!fs.existsSync(target)) throw new Error("대상 Cookies DB가 없습니다.");
  if (!fs.existsSync(staging)) throw new Error("스테이징 Cookies DB가 없습니다.");
  const statements = [
    "PRAGMA busy_timeout=5000;",
    `ATTACH DATABASE ${sqliteLiteral(staging)} AS imported;`,
    "BEGIN IMMEDIATE;",
    ...(entry.cas === true ? cookieCasGuardStatements(entry) : []),
    entry.mode === "replace"
      ? `DELETE FROM cookies WHERE (SELECT ok FROM temp.${quoteIdent(COOKIE_CAS_GUARD)});`
      : `DELETE FROM cookies WHERE (${scopedCookieSql(entry.scopes)}) AND (SELECT ok FROM temp.${quoteIdent(COOKIE_CAS_GUARD)});`,
    `INSERT OR REPLACE INTO cookies SELECT * FROM imported.cookies${entry.cas === true
      ? ` WHERE (SELECT ok FROM temp.${quoteIdent(COOKIE_CAS_GUARD)})` : ""};`,
    "COMMIT;",
    "DETACH DATABASE imported;",
    "PRAGMA wal_checkpoint(TRUNCATE);",
    "PRAGMA quick_check;",
    ...(entry.cas === true ? [`SELECT 'iris-cookie-cas='||ok FROM temp.${quoteIdent(COOKIE_CAS_GUARD)};`] : []),
  ];
  // sqlite3 CLI는 기본적으로 한 문장이 실패해도 뒤의 COMMIT을 실행한다. schema drift로
  // INSERT SELECT *가 실패한 뒤 앞선 DELETE만 커밋되지 않도록 첫 오류에서 중단시킨다.
  const output = execFileSync("/usr/bin/sqlite3", ["-bail", target], {
    input: statements.join("\n"), encoding: "utf8", maxBuffer: SQLITE_MAX_BUFFER,
  }).trim().split(/\s+/);
  if (!output.includes("ok")) throw new Error("Cookies DB 병합 무결성 검사 실패");
  return { applied: !entry.cas || output.includes("iris-cookie-cas=1"), stale: output.includes("iris-cookie-cas=0") };
}

function applyPendingCookieImports() {
  let entries;
  try { entries = readPendingEntries(); } catch { return; }
  if (!entries.length) return;
  const pending = [];
  const now = Date.now();
  for (const entry of entries) {
    // 옛 manifest에는 두 필드가 없으므로 현재 기준으로 채워 넣고 같은 규칙을 적용한다.
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : now;
    const attempts = Number.isFinite(entry.attempts) ? entry.attempts : 0;
    if (now - createdAt > PENDING_TTL_MS) { discardStagingDatabase(entry.staging); continue; }
    try { replayStagedCookieDatabase(entry); discardStagingDatabase(entry.staging); }
    catch {
      const tried = attempts + 1;
      if (tried >= PENDING_MAX_ATTEMPTS || !fs.existsSync(entry.staging)) { discardStagingDatabase(entry.staging); continue; }
      pending.push({ ...entry, createdAt, attempts: tried });
    }
  }
  try { writePendingEntries(pending); } catch {}
}

function copySnapshotToStaging(liveCookiesPath) {
  const safeTarget = validatedTargetCookiesPath(liveCookiesPath);
  if (!safeTarget) throw new Error("대상 Cookies DB 경로가 안전하지 않습니다.");
  const before = fs.lstatSync(safeTarget);
  fs.mkdirSync(stagingRoot(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stagingRoot(), 0o700); } catch {}
  const dir = fs.mkdtempSync(path.join(stagingRoot(), "import-"));
  const databasePath = path.join(dir, "Cookies");
  let snap;
  try {
    snap = snapshotWithLegacyFallback(safeTarget);
    const after = fs.lstatSync(safeTarget);
    if (!validatedTargetCookiesPath(safeTarget) || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("대상 Cookies DB가 복사 중 바뀌었습니다.");
    }
    fs.copyFileSync(snap.databasePath, databasePath);
    if (fs.existsSync(snap.databasePath + "-wal")) fs.copyFileSync(snap.databasePath + "-wal", databasePath + "-wal");
    try { fs.chmodSync(databasePath, 0o600); } catch {}
    return databasePath;
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  finally { if (snap) snap.cleanup(); }
}

function stageCookieRows(liveCookiesPath, cookies, { preserveTargetBound = false, scopeBases = null } = {}) {
  const staging = copySnapshotToStaging(liveCookiesPath);
  try {
    const targetColumns = readTableInfo(staging);
    if (!targetColumns.length) throw new Error("대상 cookies 스키마를 찾지 못했습니다.");
    const colList = targetColumns.map((c) => quoteIdent(c.name)).join(",");
    // merge는 API가 거절한 행 묶음이고, replace는 명시적 전체 import의 한 벌이다. 후자는 현재
    // 브라우저에서 발급된 클라이언트 결속/Google 무결성 쿠키만 원시 행 그대로 남긴다.
    const clientNames = [...CLIENT_BOUND_COOKIE_NAMES].map(sqliteLiteral).join(",");
    const integrityNames = [...INTEGRITY_COOKIE_NAMES].map(sqliteLiteral).join(",");
    const keepBound = `(name IN (${clientNames}) OR (name IN (${integrityNames}) AND (host_key='google.com' OR host_key='.google.com' OR host_key LIKE '%.google.com')))`;
    const keepScope = scopeBases == null ? "1" : `(${scopedCookieSql(scopeBases)})`;
    const casColumns = cookieCasColumns(targetColumns).map(quoteIdent).join(",");
    const casScope = scopeBases == null ? "" : ` WHERE ${scopedCookieSql(scopeBases)}`;
    const statements = ["PRAGMA busy_timeout=5000;", "BEGIN IMMEDIATE;",
      `DROP TABLE IF EXISTS ${quoteIdent(COOKIE_CAS_TABLE)};`,
      `CREATE TABLE ${quoteIdent(COOKIE_CAS_TABLE)} AS SELECT ${casColumns} FROM cookies${casScope};`,
      preserveTargetBound ? `DELETE FROM cookies WHERE NOT (${keepBound} AND ${keepScope});` : "DELETE FROM cookies;"];
    for (const cookie of cookies) {
      if (preserveTargetBound && (isIntegrityCookie(cookie.name, cookie.domain) || isClientBoundCookie(cookie.name))) continue;
      const r = cookie.sourceRow;
      const values = targetColumns.map((c) => insertLiteral(c, r, cookie.rawValue)).join(",");
      statements.push(`INSERT OR REPLACE INTO cookies (${colList}) VALUES (${values});`);
    }
    statements.push("COMMIT;", "PRAGMA wal_checkpoint(TRUNCATE);", "PRAGMA quick_check;");
    const checked = execFileSync("/usr/bin/sqlite3", [staging], {
      input: statements.join("\n"), encoding: "utf8", maxBuffer: SQLITE_MAX_BUFFER,
    }).trim().split(/\s+/).pop();
    if (checked !== "ok") throw new Error("스테이징 Cookies DB 무결성 검사 실패");
    for (const suffix of ["-wal", "-shm"]) { try { fs.unlinkSync(staging + suffix); } catch {} }
    return staging;
  } catch (e) { discardStagingDatabase(staging); throw e; }
}

function validatedTargetCookiesPath(candidate) {
  if (!candidate) return null;
  const partitions = path.join(app.getPath("userData"), "Partitions");
  if (path.basename(candidate) !== "Cookies" || !isWithin(partitions, candidate)) return null;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(candidate).isFile()) return null;
    const realPartitions = fs.realpathSync(partitions);
    const realParent = fs.realpathSync(path.dirname(candidate));
    const realCandidate = fs.realpathSync(candidate);
    return isWithin(realPartitions, realParent) && isWithin(realPartitions, realCandidate) ? candidate : null;
  } catch { return null; }
}
function targetCookiesPath(sess) {
  const storage = sess.storagePath;
  return validatedTargetCookiesPath(storage ? resolveChromiumCookiesPath(storage) : null);
}
async function ensureTargetCookiesPath(sess) {
  await sess.cookies.flushStore();
  let cookiesPath = targetCookiesPath(sess);
  if (cookiesPath) return cookiesPath;
  // 새 파티션은 첫 쿠키가 생기기 전까지 DB 자체가 없다. throwaway를 만들고 지운 뒤 다시 찾는다.
  try {
    await sess.cookies.set({ url: "https://localhost/", name: "__ac_cookie_init", value: "1" });
    await sess.cookies.remove("https://localhost/", "__ac_cookie_init");
    await sess.cookies.flushStore();
  } catch {}
  cookiesPath = targetCookiesPath(sess);
  return cookiesPath;
}

async function stageScopedCookieCohort(sess, list, bases, {
  isCurrent = () => true, sourceIsCurrent = () => true, expectedTargetFingerprint = null,
} = {}) {
  if (!list.every(c => c.sourceRow && Buffer.isBuffer(c.rawValue))) return { staged: 0, reason: "raw-unavailable" };
  const scope = scopeFor(sess, bases);
  try {
    return await transferFor(sess).run(transferRequestScopeFor(scope), async () => {
      const stillCurrent = async () => {
        if (!isCurrent() || !sourceIsCurrent()) return false;
        if (expectedTargetFingerprint == null) return true;
        try {
          const current = (await sess.cookies.get({})).filter(c => scope(c.domain));
          return cookieFingerprint(current) === expectedTargetFingerprint;
        } catch { return false; }
      };
      if (!(await stillCurrent())) return { staged: 0, reason: "state-changed" };
      let targetPath = targetCookiesPath(sess);
      try { if (!targetPath) targetPath = await ensureTargetCookiesPath(sess); } catch {}
      if (!targetPath) return { staged: 0, reason: "target-unavailable" };
      let staging = null;
      try {
        staging = stageCookieRows(targetPath, list, { preserveTargetBound: true, scopeBases: [...bases] });
        // transfer 안의 전후 gate가 stage copy와 같은 target 세대를 확인한다. 등록 뒤 변화는 staging
        // 내부 baseline의 cold-start CAS가 막는다.
        if (!(await stillCurrent())) {
          discardStagingDatabase(staging);
          return { staged: 0, reason: "state-changed" };
        }
        if (!registerPendingCookieImport(targetPath, staging, "replace-scoped", [...bases])) {
          discardStagingDatabase(staging);
          return { staged: 0, reason: "register-failed" };
        }
        return { staged: list.length, targetPath };
      } catch {
        if (staging) discardStagingDatabase(staging);
        return { staged: 0, reason: "stage-failed" };
      }
    });
  } catch {
    return { staged: 0, reason: "stage-failed" };
  }
}

// 지정 프로필의 쿠키를 복호화해 목록으로 돌려준다(주입은 하지 않는다). hostFilter를 주면 그 호스트만.
// 인증 넘겨주기가 해당 사이트 쿠키만 가져오는 데 쓴다. 나머지 로그인까지 함께 옮기지 않기 위해서다.
function readDecryptedCookies(profileEntry, hostFilter) {
  const source = readSourceCookieRows(sourceCookieDbPath(profileEntry));
  if (!source.stable) throw new Error("Chrome 쿠키가 변경 중입니다. 잠시 후 다시 시도해 주세요.");
  const scoped = source.rows.filter(r => !hostFilter || hostFilter(r.host_key));
  const needsKey = scoped.some(r => Buffer.isBuffer(r.encrypted_value) && r.encrypted_value.length > 0);
  const key = needsKey ? getMacKey(profileEntry.browser.service, profileEntry.browser.account) : null;
  const decoded = decryptCookieRows(scoped, key);
  if (decoded.decryptSkipped) throw new Error("Chrome 쿠키 일부를 읽지 못해 기존 로그인을 유지했습니다.");
  const now = Date.now() / 1000;
  return decoded.list.filter(c => !c.expirationDate || c.expirationDate > now);

}

// 위에서 읽은 쿠키를 대상 파티션에 넣는다.
//
// 이 경로는 source가 속한 사이트 범위만 한 snapshot으로 교체한다. Electron jar가 거절하면
// 같은 범위의 raw cohort를 CAS staging하고, 다른 사이트와 로컬 결속 쿠키는 유지한다.
async function putCookies(targetPartition, list, {
  isCurrent = () => true, sourceIsCurrent = () => true, expectedTargetFingerprint = null,
} = {}) {
  const part = (typeof targetPartition === "string" && isProfilePartition(targetPartition)) ? targetPartition : "persist:acbrowser";
  const sess = session.fromPartition(part);
  if (!Array.isArray(list) || !list.length) return { imported: 0, live: 0, staged: 0, skipped: 0, domains: [] };
  // 일부만 유효한 목록을 적용하면 서로 다른 로그인 조각이 섞인다. 전체를 쓰기 전에 모든 행과
  // scope를 검증하고, 같은 base-domain 묶음을 하나의 snapshot으로 교체한다.
  const domains = new Set();
  const bases = new Set();
  for (const c of list) {
    if (!cookieUrl(c && c.domain, c && c.path, c && c.secure) || !c.name) throw new Error("cookie-preflight-failed");
    domains.add(String(c.domain).replace(/^\./, ""));
    bases.add(baseDomain(c.domain));
  }
  const scope = scopeFor(sess, bases);
  let applied;
  try {
    applied = await replaceCookieSnapshot({ session: sess, transfer: transferFor(sess), scope, list,
      preserveCookie: c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name),
      decide: current => {
        if (!isCurrent()) return { apply: false, reason: "source-link-changed" };
        if (!sourceIsCurrent()) return { apply: false, reason: "source-changed" };
        if (expectedTargetFingerprint != null && cookieFingerprint(current) !== expectedTargetFingerprint) {
          return { apply: false, reason: "target-changed" };
        }
        return { apply: true };
      },
    });
  } catch { applied = { error: "cookie-transfer-failed", rolledBack: true, changed: 0 }; }
  if (["source-link-changed", "source-changed", "target-changed"].includes(applied.skipped)) {
    return { error: applied.skipped, rolledBack: true, imported: 0, live: 0, staged: 0,
      skipped: list.length, domains: [...domains].sort() };
  }
  const currentCookiesPath = targetCookiesPath(sess);
  if (applied.changed) {
    if (currentCookiesPath) clearPendingCookieImport(currentCookiesPath);
    return { imported: applied.live, live: applied.live, staged: 0, skipped: applied.skipped || 0,
      domains: [...domains].sort() };
  }

  // live 적용이 실패하면 성공했던 일부도 rollback됐다. 따라서 실패 행만 스테이징하지 않고 원본
  // cohort 전체를 다음 콜드스타트에 같은 사이트 범위의 완결된 snapshot으로 교체한다.
  let staged = 0;
  if (applied.rolledBack === true) {
    const pending = await stageScopedCookieCohort(sess, list, bases, {
      isCurrent, sourceIsCurrent, expectedTargetFingerprint,
    });
    staged = pending.staged;
  }
  return {
    imported: staged,
    live: 0,                     // rollback 뒤에는 일부 성공을 live로 세지 않는다
    staged,                      // 앱을 다시 켜야 먹는 것
    skipped: list.length - staged,
    domains: [...domains].sort(),
    ...(staged ? {} : { error: applied.error || "cookie-transfer-failed", rolledBack: applied.rolledBack === true }),
  };
}

// 탭 전환·이동의 자동 점검. 쿠키 만료 시각 대신 이전에 가져온 로그인 한 벌의 출처를 비교한다.
async function refreshFromChrome(profileEntry, targetPartition, hostFilter, { base, recovering = false, isCurrent = () => true } = {}) {
  const part = String(targetPartition || "");
  if (!isProfilePartition(part) || typeof hostFilter !== "function" || !base) return { error: "invalid-refresh-scope" };
  const cookies = readDecryptedCookies(profileEntry, hostFilter);
  const sess = session.fromPartition(part);
  const cid = profileEntry.browser.id + ":" + profileEntry.profile;
  const target = (await sess.cookies.get({})).filter(c => hostFilter(c.domain));
  const first = planCookieRefresh({ source: cookies, target, base, cid, recovering,
    previous: syncRecords()[part + "\n" + base] });
  // 평범한 점검은 네트워크 장벽조차 열지 않는다. 정상 응답의 Set-Cookie는 그대로 통과해야 한다.
  if (!first.apply) return { changed: 0, refreshed: 0, skipped: first.reason, read: cookies.length };
  const scope = scopeFor(sess, [base]);
  const res = await replaceCookieSnapshot({ session: sess, transfer: transferFor(sess), scope, list: cookies,
    preserveCookie: c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name),
    decide: current => {
      if (!isCurrent()) return { apply: false, reason: "source-link-changed" };
      if (cookieFingerprint(current) !== cookieFingerprint(target)) return { apply: false, reason: "target-changed" };
      // 다른 cookie transfer를 기다리는 동안 원본 Chrome 세션이 회전했을 수 있다. 큐 진입 전에
      // 읽은 A를 적용하지 않도록 mutation 직전 같은 stable-snapshot 경로로 다시 읽는다.
      let latest;
      try { latest = readDecryptedCookies(profileEntry, hostFilter); }
      catch { return { apply: false, reason: "source-changed" }; }
      if (cookieFingerprint(latest) !== cookieFingerprint(cookies)) {
        return { apply: false, reason: "source-changed" };
      }
      return planCookieRefresh({ source: latest, target: current, base, cid, recovering,
        previous: syncRecords()[part + "\n" + base] });
    },
  });
  let staged = 0;
  if (res.error && res.rolledBack === true) {
    const sourceFingerprint = cookieFingerprint(cookies);
    const pending = await stageScopedCookieCohort(sess, cookies, [base], {
      isCurrent,
      expectedTargetFingerprint: cookieFingerprint(target),
      sourceIsCurrent: () => {
        try { return cookieFingerprint(readDecryptedCookies(profileEntry, hostFilter)) === sourceFingerprint; }
        catch { return false; }
      },
    });
    staged = pending.staged;
  }
  if (staged) {
    try {
      const current = (await sess.cookies.get({})).filter(c => scope(c.domain));
      const expected = [...cookies, ...current.filter(c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name))];
      const sourceFingerprint = loginFingerprint(cookies, base);
      const revision = sourceRevision(cookies, base);
      rememberSync(part, base, { cid, sourceFingerprint, sourceRevision: revision,
        targetFingerprint: loginFingerprint(expected, base), attempted: revision });
    } catch {}
    return { changed: 0, refreshed: 0, live: 0, staged, skipped: 0,
      read: cookies.length, reason: "staged" };
  }
  if (res.changed) {
    const sourceFingerprint = loginFingerprint(cookies, base);
    const revision = sourceRevision(cookies, base);
    rememberSync(part, base, { cid, sourceFingerprint, sourceRevision: revision,
      targetFingerprint: loginFingerprint(res.after, base), attempted: revision });
  }
  const { after, decision, ...result } = res;
  return { ...result, read: cookies.length, reason: decision && decision.reason };
}

async function legacyImport(sess, list, profileEntry, total) {
  let result;
  try {
    result = await replaceCookieSnapshot({ session: sess, transfer: transferFor(sess), scope: scopeFor(sess, null), list,
      preserveCookie: c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name) });
  } catch { result = { error: "cookie-transfer-failed", rolledBack: true }; }
  if (result.error) return { error: result.rolledBack
    ? "쿠키 적용에 실패해 기존 로그인을 유지했습니다."
    : "쿠키 적용과 기존 로그인 복구가 모두 실패했습니다.", rolledBack: result.rolledBack === true };
  return { imported: result.live, live: result.live, staged: 0,
    skipped: total - result.live,
    domains: [...new Set(list.map(c => String(c.domain || "").replace(/^\./, "")))].sort(),
    source: profileEntry.label, total };
}

// 지정 프로필의 쿠키를 대상 파티션에 주입. 메모리에서 거절된 원시 바이트 쿠키는 대상 DB 스키마로
// 옮긴 스테이징 사본을 다음 콜드스타트에 재생한다.
async function importCookiesFromChrome(profileEntry, targetPartition) {
  if (process.platform !== "darwin") return { error: "Chrome 직접 임포트는 macOS만 지원합니다." };
  const part = (typeof targetPartition === "string" && isProfilePartition(targetPartition)) ? targetPartition : "persist:acbrowser";
  const sess = session.fromPartition(part);

  let source;
  try { source = readSourceCookieRows(sourceCookieDbPath(profileEntry)); }
  catch (e) { return { error: "쿠키 DB 읽기 실패: " + e.message }; }
  if (!source.stable) return { error: "Chrome 쿠키가 변경 중입니다. 잠시 후 다시 시도해 주세요." };
  const needsKey = source.rows.some((r) => Buffer.isBuffer(r.encrypted_value) && r.encrypted_value.length > 0);
  let key = null;
  if (needsKey) {
    try { key = getMacKey(profileEntry.browser.service, profileEntry.browser.account); }
    catch (e) { return { error: "Keychain 접근 실패(취소했거나 권한 없음): " + e.message }; }
  }
  const decoded = decryptCookieRows(source.rows, key);
  if (decoded.decryptSkipped) return { error: "Chrome 쿠키 일부를 읽지 못해 기존 로그인을 유지했습니다." };
  const now = Date.now() / 1000;
  const importList = decoded.list.filter(c => !c.expirationDate || c.expirationDate > now);
  if (!importList.length) return { error: "가져올 수 있는 쿠키가 없습니다." };

  let liveCookiesPath;
  try {
    liveCookiesPath = await ensureTargetCookiesPath(sess);
    if (!liveCookiesPath) throw new Error("대상 Cookies DB가 없습니다.");
  } catch {
    // 대상 DB 경로를 못 얻어도 Electron API 경로로 기능 자체는 보존한다.
    const res = await legacyImport(sess, importList, profileEntry, source.rows.length);
    if (res.error) return res;
    if (liveCookiesPath) clearPendingCookieImport(liveCookiesPath);
    applyImportedUserAgent(sess, part, profileEntry.browser);
    try { await rememberImportedSnapshot(part, profileEntry, importList); } catch {}
    return res;
  }

  // API가 어느 한 행을 거절해도 원래 로그인으로 돌아갈 수 있어야 한다. raw fallback을 먼저
  // 만들어 스키마·원본 행 전체를 preflight한다. rollback 뒤에는 cookies.set이 DB 표현을 다시
  // 쓸 수 있으므로, 실제 등록할 사본과 CAS baseline은 복구된 target의 같은 snapshot에서 재생성한다.
  let staging = null;
  try { staging = stageCookieRows(liveCookiesPath, importList, { preserveTargetBound: true }); } catch {}
  let applied;
  try {
    applied = await replaceCookieSnapshot({ session: sess, transfer: transferFor(sess), scope: scopeFor(sess, null), list: importList,
      preserveCookie: c => isIntegrityCookie(c.name, c.domain) || isClientBoundCookie(c.name) });
  } catch { applied = { error: "cookie-transfer-failed", rolledBack: true, changed: 0 }; }

  let live = 0, staged = 0;
  if (applied.changed) {
    live = applied.live;
    clearPendingCookieImport(liveCookiesPath);
    if (staging) discardStagingDatabase(staging);
  } else if (applied.rolledBack === true && staging) {
    discardStagingDatabase(staging);
    staging = null;
    try { staging = stageCookieRows(liveCookiesPath, importList, { preserveTargetBound: true }); } catch {}
    if (staging && registerPendingCookieImport(liveCookiesPath, staging, "replace")) staged = importList.length;
    else {
      clearPendingCookieImport(liveCookiesPath);
      if (staging) discardStagingDatabase(staging);
      return { error: "쿠키 적용에 실패해 기존 로그인을 유지했습니다.", rolledBack: true };
    }
  } else {
    clearPendingCookieImport(liveCookiesPath);
    if (staging) discardStagingDatabase(staging);
    return { error: applied.rolledBack
      ? "쿠키 적용에 실패해 기존 로그인을 유지했습니다."
      : "쿠키 적용과 기존 로그인 복구가 모두 실패했습니다.", rolledBack: applied.rolledBack === true };
  }

  applyImportedUserAgent(sess, part, profileEntry.browser);

  try { await rememberImportedSnapshot(part, profileEntry, importList, { pending: staged > 0 }); } catch {}
  const imported = live + staged;
  return {
    imported,
    live,
    staged,
    skipped: source.rows.length - imported,
    domains: [...new Set(importList.map(c => c.domain.replace(/^\./, "")))].sort(),
    source: profileEntry.label,
    total: source.rows.length,
  };
}

// require 시점은 main.cjs가 어떤 persist session도 만들기 전이다. 여기서만 이전 실행의 스테이징
// DB를 CookieMonster가 열기 전에 안전하게 교체할 수 있다.
try { applyPendingCookieImports(); } catch {}

module.exports = {
  importCookiesFromFile, importCookiesFromChrome, listChromeProfiles,
  readDecryptedCookies, putCookies, refreshFromChrome, userAgentForPartition, rememberBrowserUserAgent, applyBrowserUserAgentToPartition,
  // 비밀번호/자동완성 임포트(password-import.cjs)가 재사용하는 복호화 헬퍼.
  getMacKey, decryptValue, queryChromiumDb,
  // 무엇을 걸러 내는지는 소스 형태가 아니라 동작으로 확인해야 한다. 걸러 내는 줄이 있어도
  // 순서가 틀리거나 조건이 뒤집히면 소스 검사는 통과한다. test/cookie-client-bound.mjs 가
  // 이 함수를 대역 행으로 직접 실행한다.
  decryptCookieRows, isClientBoundCookie,
};
