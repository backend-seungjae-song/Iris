// 구독 사용량을 제공자에게서 직접 받아 오는 모듈.
//
// 소유 범위
//   제공자 8종의 자격증명 읽기·요청·응답 해석, 그리고 그 결과를 하나의 형식으로 맞추는 처리.
//   claude · codex · gemini · antigravity · opencode-go · kimi · minimax · grok.
//
// 제공 API
//   fetchAllUsage(prefs): 8종을 동시에 조회하고 같은 형식의 배열로 반환한다.
//   PROVIDERS: 표시 순서가 아니라 목록 자체다. 정렬은 화면이 사용률로 한다.
//   consumeCodexReset(requestId): Codex 초기화권 하나를 사용한다. 이 파일에서 유일하게 외부
//   상태를 바꾸는 함수이고, 사용자의 확인을 받은 뒤에만 호출된다.
//
// 의존 대상
//   Node 의 fetch·fs·child_process 만. 서버의 다른 모듈을 호출하지 않는다. 이 파일은
//   상태를 갖지 않는 수집기이고, 저장·주기·중계는 usage-handlers 가 맡는다.
//
// 유지 조건
//   보내는 것은 읽기 요청뿐이다. 예외는 consumeCodexReset 하나이고, 사용자가 직접 누른
//   경우에만 실행된다. 수집 회차에서 외부 상태를 바꾸지 않는다.
//   토큰을 갱신하지 않는다. 갱신 요청은 서버가 refresh token 을 재발급할 수 있고, 그러면
//   사용 중인 Claude Code·Codex 의 로그인이 그 시점에 끊긴다. 읽기만 하고 만료된 토큰은
//   만료로 표시한다. CLI 를 한 번 쓰면 CLI 가 갱신하므로 다음 회차에 정상으로 돌아온다.
//   어떤 fetcher 도 throw 하지 않는다. 하나가 실패하면 그 항목만 오류 상태가 되고 나머지는 표시된다.
//   토큰·쿠키는 반환값에 넣지 않는다. 이 결과는 그대로 창으로 나가고 로그에 찍힌다.
//   usedPercent 는 항상 0~100 으로 잘라서 반환한다. 화면이 그 값을 그대로 바 폭으로 쓴다.
//
// 영향 범위
//   server/usage-handlers.js 의 주기 수집·캐시, web/js/statusbar/usage.js 의 표시.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/usage.js

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHome, codexHome } from "./agent-homes.js";

const TIMEOUT_MS = 10000;
const SESSION_MIN = 300;     // 5시간
const WEEK_MIN = 10080;      // 7일
const MONTH_MIN = 43200;     // 30일

// 제공자 목록. 화면은 이 순서를 쓰지 않고 사용률로 정렬한다.
export const PROVIDERS = [
  "claude", "codex", "gemini", "antigravity", "opencode-go", "kimi", "minimax", "grok",
];

// ── 공용 모양 ────────────────────────────────────────────────────────────────

function clampPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 초 epoch 와 밀리초 epoch 를 가른다. 1e10 은 2286년(초)과 2001년(밀리초) 사이라 둘을 나눈다.
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e10 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber > 1e10 ? asNumber : asNumber * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function win(usedPercent, windowMinutes, resetsAt) {
  const used = clampPercent(usedPercent);
  if (used === null) return null;
  return { usedPercent: used, windowMinutes, resetsAt: toMs(resetsAt) };
}

function ok(provider, fields) {
  return { provider, session: null, weekly: null, ...fields, updatedAt: Date.now(), error: null, status: "ok" };
}

// kind 는 화면이 어떤 문구를 보여줄지 고르는 값이다. 문구 자체는 창이 소유한다.
// retryAt 은 그때까지 다시 요청하지 말라는 제공자의 응답이다. 지키지 않으면 429 가 반복된다.
function fail(provider, kind, detail, retryAt) {
  return {
    provider, session: null, weekly: null,
    updatedAt: Date.now(), error: detail || null, status: "error", failureKind: kind,
    ...(retryAt ? { retryAt } : {}),
  };
}

// 429 는 나중에 다시 요청하라는 뜻이다. Retry-After 가 있으면 그대로 따르고, 없으면 10분 대기한다.
function backoff(provider, res) {
  return fail(provider, "rate-limited", null, Date.now() + (res.retryAfterMs || 10 * 60 * 1000));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function home(...parts) { return path.join(os.homedir(), ...parts); }

// Retry-After 는 초 또는 HTTP 날짜다. 둘 다 받는다.
function retryAfterMs(raw) {
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 3600) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3600 * 1000)) : 0;
}

async function getJson(url, headers, init) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...(init || {}) });
  if (!res.ok) {
    // 본문은 버린다. 오류 본문에 토큰 일부가 포함되는 제공자가 있다.
    try { await res.arrayBuffer(); } catch { /* 이미 닫혔으면 무시 */ }
    return { status: res.status, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
  }
  return { status: res.status, data: await res.json() };
}

// ── claude ───────────────────────────────────────────────────────────────────

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

function execText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// 두 위치를 모두 확인한다. 파일과 키체인의 만료가 서로 다를 수 있다(확인 결과). 그래서
// 존재 여부가 아니라 만료가 더 나중인 것을 고른다.
async function claudeToken() {
  const found = [];
  if (process.platform === "darwin") {
    const raw = await execText("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]);
    if (raw && raw.trim()) { try { found.push(JSON.parse(raw.trim())); } catch { /* 손상된 항목은 없는 것으로 처리 */ } }
  }
  const file = readJson(claudeHome(".credentials.json"));
  if (file) found.push(file);

  let best = null;
  for (const one of found) {
    const oauth = one && one.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) continue;
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    if (!best || expiresAt > best.expiresAt) best = { token: oauth.accessToken, expiresAt };
  }
  return best;
}

// 모델별 주간 한도는 limits 배열의 weekly_scoped 로 온다. is_active 는 현재 적용되는 한도인지를
// 뜻할 뿐 값의 유효성이 아니다. 비활성이어도 percent 는 유효하다.
function claudeScopedWeekly(data, displayName) {
  const list = Array.isArray(data && data.limits) ? data.limits : [];
  const hit = list.find((limit) => limit && limit.kind === "weekly_scoped"
    && Number.isFinite(limit.percent)
    && String(limit.scope?.model?.display_name || "").trim().toLowerCase() === displayName);
  return hit ? win(hit.percent, WEEK_MIN, hit.resets_at) : null;
}

function claudeWindow(raw, windowMinutes) {
  if (!raw || typeof raw !== "object") return null;
  const percent = typeof raw.utilization === "number" ? raw.utilization : raw.used_percentage;
  return win(percent, windowMinutes, raw.resets_at);
}

async function fetchClaude() {
  const cred = await claudeToken();
  if (!cred) return fail("claude", "missing-credentials");
  if (cred.expiresAt && cred.expiresAt <= Date.now()) return fail("claude", "stale-token");
  const res = await getJson(CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${cred.token}`,
    "anthropic-beta": "oauth-2025-04-20",
    // Claude Code CLI 와 같은 식별자로 호출한다. 이 엔드포인트의 계약이다.
    "User-Agent": "claude-code/2.1.0",
  });
  if (res.status === 401 || res.status === 403) return fail("claude", "stale-token");
  if (res.status === 429) return backoff("claude", res);
  if (!res.data) return fail("claude", "server", `HTTP ${res.status}`);
  return ok("claude", {
    session: claudeWindow(res.data.five_hour, SESSION_MIN),
    weekly: claudeWindow(res.data.seven_day, WEEK_MIN),
    scoped: [
      { label: "Fable", window: claudeScopedWeekly(res.data, "fable") },
      { label: "Opus", window: claudeWindow(res.data.seven_day_opus, WEEK_MIN) },
    ].filter((one) => one.window),
  });
}

// ── codex ────────────────────────────────────────────────────────────────────

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

function codexAuthHeaders() {
  const auth = readJson(codexHome("auth.json"));
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (typeof token !== "string" || !token) return null;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (auth.tokens.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  return headers;
}

// Codex 는 창 두 개를 primary·secondary 로만 준다. 어느 쪽이 5시간이고 어느 쪽이 주간인지는
// limit_window_seconds 로 판정한다. 길이가 없으면 이전 배치(primary=세션)로 대체한다.
function codexWindows(rateLimit) {
  const pick = (raw) => {
    if (!raw || typeof raw.used_percent !== "number") return null;
    const seconds = raw.limit_window_seconds;
    const minutes = typeof seconds === "number" && seconds > 0 ? Math.ceil(seconds / 60) : null;
    return { percent: raw.used_percent, minutes, resetsAt: raw.reset_at };
  };
  const primary = pick(rateLimit && rateLimit.primary_window);
  const secondary = pick(rateLimit && rateLimit.secondary_window);
  const near = (minutes, target) => minutes !== null && Math.abs(minutes - target) <= 1;

  let session = null;
  let weekly = null;
  for (const one of [primary, secondary]) {
    if (!one) continue;
    if (near(one.minutes, SESSION_MIN) && !session) session = one;
    else if (near(one.minutes, WEEK_MIN) && !weekly) weekly = one;
  }
  if (!session && primary && primary.minutes === null) session = primary;
  if (!weekly && secondary && secondary.minutes === null) weekly = secondary;
  return {
    session: session ? win(session.percent, session.minutes || SESSION_MIN, session.resetsAt) : null,
    weekly: weekly ? win(weekly.percent, weekly.minutes || WEEK_MIN, weekly.resetsAt) : null,
  };
}

async function fetchCodex() {
  const headers = codexAuthHeaders();
  if (!headers) return fail("codex", "missing-credentials");
  const res = await getJson(CODEX_USAGE_URL, headers);
  if (res.status === 401 || res.status === 403) return fail("codex", "stale-token");
  if (res.status === 429) return backoff("codex", res);
  if (!res.data) return fail("codex", "server", `HTTP ${res.status}`);
  const windows = codexWindows(res.data.rate_limit);
  return ok("codex", {
    session: windows.session,
    weekly: windows.weekly,
    planType: typeof res.data.plan_type === "string" ? res.data.plan_type : null,
    ...codexCredits(res.data.rate_limit_reset_credits),
  });
}

// 초기화권. 이 계정의 실제 응답은 개수만 준다(확인 결과: `{available_count: 3,
// applicable_available_count: 0}`). `credits` 배열만 집계하면 권이 있어도 화면에 표시되지
// 않는다. 배열로 오는 계정도 있으므로 둘 다 처리한다.
//
// 두 값은 뜻이 다르다. available 은 보유 수, applicable 은 현재 적용 가능한 수다. 잠긴 창이
// 없으면 권이 있어도 사용할 대상이 없어 0 이 된다.
//
// applicable 은 저장만 하고 화면에서 쓰지 않는다. 두 값을 함께 보여주면 혼란스럽고, 이 값으로
// 버튼을 잠그면 조회가 잘못된 계정은 기능을 쓸 수 없다. 제공자가 주는 값이라 기록만 해 둔다.
function codexCredits(raw) {
  if (!raw || typeof raw !== "object") return {};
  const list = Array.isArray(raw.credits) ? raw.credits : null;
  const counted = list
    ? list.filter((one) => one && String(one.status || "").toLowerCase() === "available").length
    : null;
  const available = Number.isFinite(raw.available_count) ? Math.max(0, Math.floor(raw.available_count)) : counted;
  if (available === null || available === undefined) return {};
  const applicable = Number.isFinite(raw.applicable_available_count)
    ? Math.max(0, Math.floor(raw.applicable_available_count)) : null;
  const expiries = (list || [])
    .filter((one) => one && String(one.status || "").toLowerCase() === "available")
    .map((one) => toMs(one.expires_at))
    .filter((at) => typeof at === "number" && Number.isFinite(at))
    .sort((a, b) => a - b);
  return {
    resetCredits: available,
    ...(applicable === null ? {} : { applicableResetCredits: applicable }),
    ...(expiries.length ? { resetCreditExpiresAt: expiries[0] } : {}),
  };
}

// 초기화권 하나를 사용한다. 이 파일에서 유일하게 외부 상태를 바꾸는 함수이고 나머지는
// 읽기만 한다. 호출하는 쪽이 사용자의 확인을 받은 뒤에만 호출한다.
//
// 같은 요청 id 를 두 번 보내도 제공자가 한 번만 처리한다(already_redeemed). 클릭이 겹치거나
// 응답을 받지 못해 다시 보낼 때 권이 두 개 소모되지 않게 하는 장치라, id 를 회차마다 새로
// 만들지 않는다. 호출하는 쪽이 그 회차의 id 를 전달한다.
//
// 응답은 네 가지다. reset(초기화됨) · nothing_to_reset(초기화할 창 없음, 권 소모 없음) ·
// no_credit(권 없음) · already_redeemed(이 id 는 이미 사용됨).
export async function consumeCodexReset(requestId) {
  const id = String(requestId || "").trim();
  if (!id) return { ok: false, outcome: "bad-request" };
  const headers = codexAuthHeaders();
  if (!headers) return { ok: false, outcome: "missing-credentials" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_RESET_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: id }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 본문은 버린다. 실패 응답에 계정 정보가 포함될 수 있고 이 값은 화면으로 전달된다.
      try { await res.arrayBuffer(); } catch { /* 이미 닫힘 */ }
      return { ok: false, outcome: res.status === 401 || res.status === 403 ? "stale-token" : `http-${res.status}` };
    }
    const data = await res.json();
    const code = data && typeof data.code === "string" ? data.code : "unknown";
    return { ok: code === "reset", outcome: code };
  } catch (err) {
    return { ok: false, outcome: "network", detail: String((err && err.message) || err).slice(0, 200) };
  } finally { clearTimeout(timer); }
}


// ── gemini · antigravity ─────────────────────────────────────────────────────

const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GEMINI_PROJECT_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

// gemini CLI 와 opencode 가 같은 구글 자격증명을 각자 다른 위치에 저장한다. 둘 다 확인한다.
function geminiToken() {
  const direct = readJson(home(".gemini", "oauth_creds.json"));
  if (direct && typeof direct.access_token === "string" && direct.access_token) {
    return { token: direct.access_token, expiresAt: toMs(direct.expiry_date) };
  }
  const candidates = [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : null,
    home(".local", "share", "opencode", "auth.json"),
    home("Library", "Application Support", "opencode", "auth.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    const auth = readJson(file);
    const google = auth && auth.google;
    if (google && google.type === "oauth" && typeof google.access === "string" && google.access) {
      return { token: google.access, expiresAt: toMs(google.expires) };
    }
  }
  return null;
}

async function fetchGemini() {
  const cred = geminiToken();
  if (!cred) return fail("gemini", "missing-credentials");
  // 갱신하지 않는다(파일 머리말). 만료된 것은 만료로 표시하며, gemini CLI 를 한 번 쓰면 복구된다.
  if (cred.expiresAt && cred.expiresAt <= Date.now()) return fail("gemini", "stale-token");

  const project = await getJson(GEMINI_PROJECT_URL,
    { "Content-Type": "application/json", Authorization: `Bearer ${cred.token}` },
    { method: "POST", body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }) });
  if (project.status === 401 || project.status === 403) return fail("gemini", "stale-token");
  if (project.status === 429) return backoff("gemini", project);
  const projectId = project.data && project.data.cloudaicompanionProject;
  if (typeof projectId !== "string" || !projectId) return fail("gemini", "usage-unavailable");

  const quota = await getJson(GEMINI_QUOTA_URL,
    { "Content-Type": "application/json", Authorization: `Bearer ${cred.token}` },
    { method: "POST", body: JSON.stringify({ project: projectId }) });
  if (!quota.data) return fail("gemini", "server", `HTTP ${quota.status}`);

  const raw = Array.isArray(quota.data) ? quota.data
    : Array.isArray(quota.data.buckets) ? quota.data.buckets : [];
  const buckets = [];
  for (const one of raw) {
    if (!one || typeof one.remainingFraction !== "number" || typeof one.modelId !== "string") continue;
    if (buckets.some((made) => made.name === one.modelId)) continue;
    const bucket = win(100 - one.remainingFraction * 100, WEEK_MIN, one.resetTime);
    if (bucket) buckets.push({ name: one.modelId, ...bucket });
  }
  if (!buckets.length) return fail("gemini", "usage-unavailable");
  // 요약 한 줄은 가장 많이 쓴 모델이다. 상태바 세그먼트가 이 값을 사용한다.
  const tightest = buckets.reduce((now, next) => (next.usedPercent > now.usedPercent ? next : now));
  return ok("gemini", { session: { usedPercent: tightest.usedPercent, windowMinutes: tightest.windowMinutes, resetsAt: tightest.resetsAt }, buckets });
}

// Antigravity 는 현재 Gemini 와 같은 자격증명을 쓴다. 같은 결과에 이름만 바꿔 표시한다.
function mirrorAntigravity(gemini) {
  return { ...gemini, provider: "antigravity" };
}

// ── opencode-go ──────────────────────────────────────────────────────────────

const OPENCODE_BASE = "https://opencode.ai";
const OPENCODE_SERVER = `${OPENCODE_BASE}/_server`;
const OPENCODE_WORKSPACES_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const OPENCODE_AUTH_COOKIES = new Set(["auth", "__Host-auth"]);

// 사용자가 값만 복사해 오는 경우가 많다. 이름이 없으면 붙인다. 그러지 않으면 쿠키는 있는데
// 인증 이름이 없어 오류 없이 실패한다.
export function normalizeOpencodeCookie(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.includes(";") || /^(?:auth|__Host-auth)=/i.test(text)) return text;
  if (text.startsWith("Fe26.2**") || /^[a-zA-Z0-9.\-_]+$/.test(text)) return `auth=${text}`;
  return text;
}

function opencodeAuthHeader(raw) {
  const pairs = normalizeOpencodeCookie(raw).split(";").map((part) => part.trim()).map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // 인증 이름만 보낸다. 나머지를 함께 보내면 관계없는 사이트의 값까지 전송된다.
    return OPENCODE_AUTH_COOKIES.has(name) && value ? `${name}=${value}` : null;
  }).filter(Boolean);
  return pairs.length ? pairs.join("; ") : null;
}

// 이 페이지는 React Flight 로 직렬화돼 있어서 `key:$R[28]={...}` 꼴이다. 같은 이름이 null 로도
// 여러 번 나오므로, usagePercent 와 resetInSec 을 직속으로 가진 첫 덩어리만 집는다.
function opencodeBlock(text, key) {
  const keyRe = new RegExp(`\\b${key}\\b\\s*:`, "g");
  let hit;
  while ((hit = keyRe.exec(text)) !== null) {
    const from = hit.index + hit[0].length;
    const brace = text.slice(from, from + 30).indexOf("{");
    if (brace < 0) continue;
    const open = from + brace;
    let depth = 0;
    let block = null;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { block = text.slice(open, i + 1); break; }
    }
    if (!block) continue;
    if (opencodeNumber(block, "usagePercent") !== null && opencodeNumber(block, "resetInSec") !== null) return block;
  }
  return null;
}

// 깊이 1 의 숫자만 집는다. 깊이를 안 세면 안쪽 객체의 같은 이름이 먼저 잡힌다.
function opencodeNumber(block, field) {
  const fieldRe = new RegExp(`\\b${field}\\b\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`);
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    if (block[i] === "{") { depth++; continue; }
    if (block[i] === "}") { depth--; continue; }
    if (depth !== 1) continue;
    const hit = fieldRe.exec(block.slice(i, i + field.length + 30));
    if (hit && hit.index === 0) {
      const value = Number.parseFloat(hit[1]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function opencodeParse(text) {
  if (!text || text.length > 10_000_000) return null;
  const read = (key) => {
    const block = opencodeBlock(text, key);
    if (!block) return null;
    const percent = opencodeNumber(block, "usagePercent");
    const reset = opencodeNumber(block, "resetInSec");
    return percent === null || reset === null ? null : { percent, reset };
  };
  const rolling = read("rollingUsage");
  const weekly = read("weeklyUsage");
  if (!rolling || !weekly) return null;
  return { rolling, weekly, monthly: read("monthlyUsage") };
}

async function opencodeText(url, cookie, headers) {
  const res = await fetch(url, {
    headers: { Cookie: cookie, Origin: OPENCODE_BASE, Referer: OPENCODE_BASE, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.ok ? res.text() : null;
}

async function fetchOpencodeGo(prefs) {
  const cookie = opencodeAuthHeader(prefs && prefs.opencodeCookie);
  if (!cookie) return fail("opencode-go", "needs-cookie");

  let ids = [];
  const override = String((prefs && prefs.opencodeWorkspace) || "").trim();
  if (override) {
    if (!/^(wrk|wk)_[A-Za-z0-9]+$/.test(override)) return fail("opencode-go", "bad-setting");
    ids = [override];
  } else {
    const text = await opencodeText(`${OPENCODE_SERVER}?id=${OPENCODE_WORKSPACES_ID}`, cookie, {
      "X-Server-Id": OPENCODE_WORKSPACES_ID,
      "X-Server-Instance": `server-fn:${crypto.randomUUID()}`,
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
    });
    if (!text) return fail("opencode-go", "server");
    for (const hit of text.matchAll(/\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g)) {
      if (!ids.includes(hit[1])) ids.push(hit[1]);
    }
  }
  if (!ids.length) return fail("opencode-go", "usage-unavailable");

  for (const id of ids) {
    const text = await opencodeText(`${OPENCODE_BASE}/workspace/${id}/go`, cookie, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    if (!text) continue;
    const parsed = opencodeParse(text);
    if (!parsed) continue;
    const at = (seconds) => Date.now() + seconds * 1000;
    return ok("opencode-go", {
      session: win(parsed.rolling.percent, SESSION_MIN, at(parsed.rolling.reset)),
      weekly: win(parsed.weekly.percent, WEEK_MIN, at(parsed.weekly.reset)),
      monthly: parsed.monthly ? win(parsed.monthly.percent, MONTH_MIN, at(parsed.monthly.reset)) : null,
    });
  }
  return fail("opencode-go", "usage-unavailable");
}

// ── kimi ─────────────────────────────────────────────────────────────────────

function kimiWindowMinutes(window) {
  const duration = Number(window && window.duration);
  if (!Number.isFinite(duration)) return null;
  const unit = String((window && window.timeUnit) || "").toUpperCase();
  if (unit.includes("MINUTE")) return duration;
  if (unit.includes("HOUR")) return duration * 60;
  if (unit.includes("DAY")) return duration * 60 * 24;
  if (unit.includes("WEEK")) return duration * 60 * 24 * 7;
  return null;
}

function kimiUsedPercent(detail) {
  const limit = Number(detail && detail.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const used = Number(detail && detail.used);
  if (Number.isFinite(used)) return (used / limit) * 100;
  const remaining = Number(detail && detail.remaining);
  if (Number.isFinite(remaining)) return ((limit - remaining) / limit) * 100;
  return null;
}

async function fetchKimi() {
  const kimiHome = process.env.KIMI_CODE_HOME || home(".kimi-code");
  const creds = readJson(path.join(kimiHome, "credentials", "kimi-code.json"));
  if (!creds || typeof creds.access_token !== "string" || !creds.access_token) {
    return fail("kimi", "missing-credentials");
  }
  if (typeof creds.expires_at === "number" && creds.expires_at - Math.floor(Date.now() / 1000) <= 5) {
    return fail("kimi", "stale-token");
  }
  const base = (process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/$/, "");
  const res = await getJson(`${base}/usages`, {
    Authorization: `Bearer ${creds.access_token}`, Accept: "application/json",
  });
  if (res.status === 401 || res.status === 403) return fail("kimi", "stale-token");
  if (res.status === 429) return backoff("kimi", res);
  if (!res.data) return fail("kimi", "server", `HTTP ${res.status}`);

  let session = null;
  let weekly = null;
  for (const limit of Array.isArray(res.data.limits) ? res.data.limits : []) {
    const minutes = kimiWindowMinutes(limit && limit.window);
    const percent = kimiUsedPercent(limit && limit.detail);
    if (minutes === null || percent === null) continue;
    const reset = (limit.detail && (limit.detail.resetTime || limit.detail.resetAt)) || null;
    if (minutes <= SESSION_MIN && !session) session = win(percent, minutes, reset);
    else if (minutes > SESSION_MIN && !weekly) weekly = win(percent, minutes, reset);
  }
  if (!session && !weekly) return fail("kimi", "usage-unavailable");
  return ok("kimi", { session, weekly });
}

// ── minimax ──────────────────────────────────────────────────────────────────

const MINIMAX_USAGE_URL = "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains";

// 이 엔드포인트는 브라우저가 아닌 요청을 거절한다. 사람 브라우저 UA 를 쓰는 것이 계약이다.
const MINIMAX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";

async function fetchMinimax(prefs) {
  const cookie = String((prefs && prefs.minimaxCookie) || "").trim();
  if (!cookie) return fail("minimax", "needs-cookie");
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://platform.minimax.io/console/usage",
    "User-Agent": MINIMAX_UA,
    Cookie: cookie,
  };
  const groupId = String((prefs && prefs.minimaxGroupId) || "").trim();
  if (groupId) headers["X-Group-Id"] = groupId;

  const res = await getJson(MINIMAX_USAGE_URL, headers);
  if (res.status === 401 || res.status === 403) return fail("minimax", "stale-token");
  if (res.status === 429) return backoff("minimax", res);
  if (!res.data) return fail("minimax", "server", `HTTP ${res.status}`);

  const items = Array.isArray(res.data.model_remains) ? res.data.model_remains : [];
  const made = [];
  for (const item of items) {
    const remaining = Number(item && item.current_interval_remaining_percent);
    if (!item || typeof item.model_name !== "string" || !Number.isFinite(remaining)) continue;
    // 창 길이는 API 가 4시간으로 흔들려 온다. 계약은 5시간이므로 라벨은 5시간으로 고정한다.
    const bucket = win(100 - remaining, SESSION_MIN, item.end_time);
    if (bucket) made.push({ name: item.model_name, ...bucket });
  }
  if (!made.length) return fail("minimax", "usage-unavailable");
  const tightest = made.reduce((now, next) => (next.usedPercent > now.usedPercent ? next : now));
  return ok("minimax", {
    session: { usedPercent: tightest.usedPercent, windowMinutes: tightest.windowMinutes, resetsAt: tightest.resetsAt },
    buckets: made,
  });
}

// ── grok ─────────────────────────────────────────────────────────────────────

const GROK_BASE = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1").replace(/\/$/, "");
const GROK_ISSUER = "https://auth.x.ai";

// auth.json 은 발급자별 항목 표다. x.ai 발급 항목을 먼저 고르고, 없으면 아무 항목이나 쓴다.
function grokSession() {
  const grokHome = process.env.GROK_HOME || home(".grok");
  const auth = readJson(path.join(grokHome, "auth.json"));
  if (!auth || typeof auth !== "object") return null;
  const entries = Object.entries(auth)
    .filter(([, value]) => value && typeof value === "object" && typeof value.key === "string" && value.key);
  if (!entries.length) return null;
  const preferred = entries.find(([key]) => key === GROK_ISSUER || key.startsWith(`${GROK_ISSUER}::`));
  const [, entry] = preferred || entries[0];
  return { token: entry.key, teamId: typeof entry.team_id === "string" ? entry.team_id : null, expiresAt: toMs(entry.expires_at) };
}

function grokHeaders(session) {
  const headers = { Authorization: `Bearer ${session.token}`, Accept: "application/json" };
  if (session.teamId) headers["x-team-id"] = session.teamId;
  return headers;
}

async function fetchGrok() {
  const session = grokSession();
  if (!session) return fail("grok", "missing-credentials");
  if (session.expiresAt && session.expiresAt <= Date.now()) return fail("grok", "stale-token");

  const credits = await getJson(`${GROK_BASE}/billing?format=credits`, grokHeaders(session));
  if (credits.status === 401 || credits.status === 403) return fail("grok", "stale-token");
  if (credits.status === 429) return backoff("grok", credits);
  const config = credits.data;
  if (config && typeof config.creditUsagePercent === "number") {
    const window = win(config.creditUsagePercent, WEEK_MIN, config.currentPeriod?.end ?? config.billingPeriodEnd);
    if (window) return ok("grok", { weekly: window });
  }
  // 통합 청구 계정은 credits 화면에 비율이 없으므로 기본 화면의 월 예산으로 대체한다.
  const billing = await getJson(`${GROK_BASE}/billing`, grokHeaders(session));
  const monthly = billing.data;
  const used = Number(monthly && monthly.used);
  const limit = Number(monthly && monthly.limit);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    const window = win((used / limit) * 100, MONTH_MIN, monthly.currentPeriod?.end ?? monthly.billingPeriodEnd);
    if (window) return ok("grok", { monthly: window });
  }
  return fail("grok", "usage-unavailable");
}

// ── 모아 부르기 ──────────────────────────────────────────────────────────────

// 하나가 실패해도 그 줄만 오류로 표시한다. Promise.all 을 쓰면 첫 거절이 나머지 일곱을 버린다.
// skipUntil 에 아직 지나지 않은 시각이 적혀 있으면 호출하지 않는다. 429 를 받고도 계속 호출하면
// 대기 시간이 매번 새로 시작한다.
async function guarded(provider, skipUntil, run) {
  const until = skipUntil && skipUntil[provider];
  if (typeof until === "number" && until > Date.now()) return fail(provider, "rate-limited", null, until);
  try { return await run(); } catch (err) { return fail(provider, "network", err && err.message ? String(err.message).slice(0, 200) : null); }
}

export async function fetchAllUsage(prefs, skipUntil) {
  const [claude, codex, gemini, opencodeGo, kimi, minimax, grok] = await Promise.all([
    guarded("claude", skipUntil, fetchClaude),
    guarded("codex", skipUntil, fetchCodex),
    guarded("gemini", skipUntil, fetchGemini),
    guarded("opencode-go", skipUntil, () => fetchOpencodeGo(prefs)),
    guarded("kimi", skipUntil, fetchKimi),
    guarded("minimax", skipUntil, () => fetchMinimax(prefs)),
    guarded("grok", skipUntil, fetchGrok),
  ]);
  return [claude, codex, gemini, mirrorAntigravity(gemini), opencodeGo, kimi, minimax, grok];
}
