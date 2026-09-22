// 패스키·지문이 필요할 때 Iris 프로필에 연결된 실제 Chromium 프로필을 일반 창으로 연다.
// 실 프로필에는 원격 디버깅과 별도 user-data-dir를 붙이지 않는다. 그래야 기존 계정·패스키를
// 그대로 쓰고 macOS Dock에서도 사용자가 고정한 브라우저 앱과 같은 인스턴스로 합쳐진다.
const { spawn, execFile, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getDomain } = require("tldts");
const { stateHome } = require("../../server/state-home.cjs");
const { cookieFingerprint } = require("./cookie-sync-policy.cjs");

const BROWSER_APPS = {
  chrome: { bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", osa: "Google Chrome" },
  brave: { bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", osa: "Brave Browser" },
  edge: { bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", osa: "Microsoft Edge" },
};
const STATE_HOME = stateHome();
const LOG_PATH = path.join(STATE_HOME, "chrome-auth.log");
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FIELDS = 40;
const MAX_FIELD_LEN = 4096;

function logLine(name, extra) {
  try {
    const body = extra ? " " + JSON.stringify(extra).slice(0, 400) : "";
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${name}${body}\n`);
  } catch {}
}

// 원격 디버깅이 붙은 실 Chrome은 로그인 공급자가 거부할 수 있다. 이 인증 경로는 그런 Chrome을
// 만들지 않지만, 남아 있는 오염 상태를 시작 시점에 진단하기 위해 탐지기는 유지한다.
function findPoisonedChrome() {
  try {
    const output = execFileSync("/bin/ps", ["-eo", "pid=,command="], { encoding: "utf8", timeout: 4000 });
    return output.split("\n").map((line) => line.trim()).filter((line) =>
      /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/.test(line)
      && /--remote-debugging-(pipe|port)/.test(line))
      .map((line) => ({ pid: Number(line.split(/\s+/)[0]), cmd: line }));
  } catch { return []; }
}

function canonicalHost(host) {
  const value = String(host || "").trim().replace(/^\.+/, "");
  if (!value || /[\s/\\@?#%]/.test(value)) return "";
  try {
    const parsed = new URL("http://" + value + "/");
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/"
      || parsed.search || parsed.hash) return "";
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch { return ""; }
}
function baseDomain(host) {
  const value = canonicalHost(host);
  if (!value) return "";
  return getDomain(value, { allowPrivateDomains: true, extractHostname: false }) || value;
}
function inScope(domain, base) {
  const value = canonicalHost(domain), root = canonicalHost(base);
  return !!value && !!root && (value === root || value.endsWith("." + root));
}

function sanitizeFields(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const field of raw) {
    if (!field || typeof field !== "object") continue;
    const value = typeof field.value === "string" ? field.value.slice(0, MAX_FIELD_LEN) : "";
    if (!value) continue;
    result.push({
      id: typeof field.id === "string" ? field.id.slice(0, 128) : "",
      name: typeof field.name === "string" ? field.name.slice(0, 128) : "",
      type: typeof field.type === "string" ? field.type.slice(0, 32) : "",
      tidx: Number.isInteger(field.tidx) && field.tidx >= 0 ? field.tidx : -1,
      value,
    });
    if (result.length >= MAX_FIELDS) break;
  }
  return result;
}

function fillJs(fields, wantOrigin) {
  return `(function(){try{
  if(location.origin!==${JSON.stringify(String(wantOrigin || ""))}) return -2;
  var F=${JSON.stringify(fields)};
  var els=[].slice.call(document.querySelectorAll("input,textarea,select"));
  var ty=function(e){return String(e.type||"").toLowerCase();};
  var used=[],n=0;
  var take=function(e){if(!e||used.indexOf(e)>=0)return null;used.push(e);return e;};
  F.forEach(function(f){
    var el=null;
    if(f.id)el=take(document.getElementById(f.id));
    if(!el&&f.name){for(var i=0;i<els.length;i++){if(els[i].name===f.name&&(!f.type||ty(els[i])===f.type)){el=take(els[i]);if(el)break;}}}
    if(!el&&f.type&&f.tidx>=0){var same=els.filter(function(e){return ty(e)===f.type;});el=take(same[f.tidx]);}
    if(!el)return;
    var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value");
    if(d&&d.set)d.set.call(el,f.value);else el.value=f.value;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    n++;
  });
  return n;
}catch(e){return -1}})()`;
}

// smoke가 AppleScript 실행 가능 여부를 브라우저 부작용 없이 확인하는 probe다.
function osaRun(script) {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 6000 },
      (error, output) => resolve(error ? null : String(output || "").trim()));
  });
}

// 필드 값에는 비밀번호가 섞일 수 있으므로 프로세스 argv가 아니라 stdin으로 전달한다.
function osaRunStdin(script) {
  return new Promise((resolve) => {
    let output = "", done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    let child;
    try { child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "ignore"] }); }
    catch { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 15000);
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? output.trim() : null); });
    try { child.stdin.end(script); } catch { clearTimeout(timer); finish(null); }
  });
}

async function windowIds(browser) {
  const running = await osaRunStdin(`tell application "System Events" to (name of processes) contains "${browser.osa}"`);
  if (running === null) return null;
  if (String(running).trim() !== "true") return [];
  const output = await osaRunStdin(`tell application "${browser.osa}" to get id of every window`);
  if (output === null) return null;
  return String(output).split(",").map((value) => value.trim()).filter((value) => /^\d+$/.test(value));
}

async function fillOverAppleScript(browser, windowId, fields, wantOrigin) {
  if (!windowId || !fields.length) return { filled: 0, requested: fields.length, why: "no-window" };
  const encoded = Buffer.from(fillJs(fields, wantOrigin), "utf8").toString("base64");
  const output = await osaRunStdin(
    `tell application "${browser.osa}" to execute active tab of window id ${windowId} javascript "eval(atob('${encoded}'))"`);
  if (output === null) return { filled: 0, requested: fields.length, why: "apple-events-blocked" };
  const count = Number.parseInt(String(output).trim(), 10);
  if (count === -2) return { filled: 0, requested: fields.length, why: "wrong-page" };
  return Number.isFinite(count) && count >= 0
    ? { filled: count, requested: fields.length }
    : { filled: 0, requested: fields.length, why: "script-error" };
}

function cookieSignature(cookies) {
  const encode = (value) => Buffer.isBuffer(value) ? ["buffer", value.toString("hex")]
    : typeof value === "bigint" ? ["bigint", value.toString()] : [typeof value, value];
  const rows = cookies.map((cookie) => {
    const raw = cookie.sourceRow && typeof cookie.sourceRow === "object"
      ? Object.keys(cookie.sourceRow).filter((key) => key !== "last_access_utc").sort()
        .map((key) => [key, encode(cookie.sourceRow[key])])
      : [];
    return [cookie.domain, cookie.name, cookie.path || "/", !!cookie.secure, !!cookie.httpOnly,
      cookie.sameSite || "unspecified", Math.floor(Number(cookie.expirationDate) || 0),
      encode(cookie.rawValue), crypto.createHash("sha256").update(String(cookie.value)).digest("hex"), raw];
  }).sort((a, b) => JSON.stringify(a.slice(0, 3)).localeCompare(JSON.stringify(b.slice(0, 3))));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function appleScriptString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function runProfileHandoff({ target, session, partition, entry, cookieImport, stage, bounds, fields,
  isCurrent = () => true }) {
  const browser = BROWSER_APPS[entry && entry.browser && entry.browser.id];
  if (!browser || !fs.existsSync(browser.bin)) {
    return { ok: false, error: "연결된 Chrome 계정 프로필의 브라우저를 찾을 수 없습니다." };
  }
  const base = baseDomain(target.hostname);
  const inTargetScope = (domain) => inScope(domain, base);
  let before;
  try { before = cookieSignature(cookieImport.readDecryptedCookies(entry, inTargetScope)); }
  catch (error) { return { ok: false, error: "Chrome 프로필 쿠키를 읽지 못했습니다: " + String(error.message || error) }; }
  let expectedTargetFingerprint;
  try {
    expectedTargetFingerprint = cookieFingerprint((await session.cookies.get({})).filter(c => inTargetScope(c.domain)));
  } catch (error) {
    return { ok: false, error: "Iris의 기존 로그인 상태를 읽지 못했습니다: " + String(error.message || error) };
  }

  stage("launching", { profile: entry.label });
  const wasOpen = await windowIds(browser);
  try {
    const child = spawn(browser.bin, ["--profile-directory=" + entry.profile, "--new-window", "about:blank"], {
      detached: true, stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    return { ok: false, error: `${browser.osa}을(를) 띄우지 못했습니다: ` + String(error.message || error) };
  }

  let windowId = null;
  if (wasOpen) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      await waitFor(400);
      const current = await windowIds(browser);
      if (!current) break;
      const fresh = current.filter((id) => !wasOpen.includes(id));
      if (fresh.length === 1) { windowId = fresh[0]; break; }
    }
  }
  if (!windowId) {
    return { ok: false, error: "연결된 Chrome 프로필 창을 식별하지 못했습니다. macOS 자동화 권한을 확인해 주세요." };
  }
  const navigated = await osaRunStdin(
    `tell application "${browser.osa}" to set URL of active tab of window id ${windowId} to ${appleScriptString(target.href)}`);
  if (navigated === null) {
    return { ok: false, error: "인증 주소를 연결된 Chrome 프로필 창에 열지 못했습니다. macOS 자동화 권한을 확인해 주세요." };
  }

  if (bounds) {
    const { x, y, width, height } = bounds;
    await osaRunStdin(`tell application "${browser.osa}" to set bounds of window id ${windowId} to {${x}, ${y}, ${x + width}, ${y + height}}`);
  }
  let fill = { filled: 0, requested: fields.length, why: "none" };
  if (fields.length) {
    await waitFor(1500);
    fill = await fillOverAppleScript(browser, windowId, fields, target.origin);
    stage("filling", { filled: fill.filled, requested: fill.requested, why: fill.why });
  }

  stage("waiting", { hint: "연결된 Chrome 프로필에서 로그인을 마친 뒤 그 창을 닫으세요.", profile: entry.label });
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  let cookies = [], closed = false, after = before;
  while (Date.now() < deadline) {
    await waitFor(1500);
    try { cookies = cookieImport.readDecryptedCookies(entry, inTargetScope); after = cookieSignature(cookies); } catch {}
    const current = await windowIds(browser);
    if (current && !current.includes(windowId)) {
      closed = true;
      stage("collecting");
      const settleUntil = Date.now() + 8000;
      let stableReads = 0;
      let lastSignature = null;
      let collectError = null;
      while (Date.now() < settleUntil) {
        await waitFor(1000);
        try {
          const latest = cookieImport.readDecryptedCookies(entry, inTargetScope);
          const signature = cookieSignature(latest);
          stableReads = signature === lastSignature ? stableReads + 1 : 1;
          lastSignature = signature;
          cookies = latest;
          after = signature;
          collectError = null;
          // 시작 전과 같은 A,A는 Chrome의 마지막 flush 전일 수 있다. 변경된 cohort만 연속 두 번
          // 확인하면 일찍 끝내고, 그대로인 경우에는 settle 창 끝까지 관찰해 기존 handoff도 허용한다.
          if (stableReads >= 2 && signature !== before) break;
        } catch (error) { collectError = error; }
        if (collectError) stableReads = 0;
      }
      if (stableReads < 2) {
        return { ok: false, error: "Chrome 창을 닫은 뒤 안정된 쿠키를 다시 읽지 못했습니다: "
          + String(collectError && (collectError.message || collectError) || "읽기 실패") };
      }
      break;
    }
  }
  if (!closed) {
    return { ok: false, error: "창이 열려 있는 동안에는 가져오지 않습니다. 로그인을 마치고 그 창을 닫아 주세요." };
  }
  if (!cookies.length) {
    return { ok: false, error: `${base}에서 가져올 쿠키가 없습니다. 연결된 프로필에서 로그인을 완료했는지 확인해 주세요.` };
  }

  stage("harvesting");
  if (!isCurrent()) return { ok: false, error: "기다리는 동안 이 Iris 프로필의 Chrome 연결이 바뀌었습니다. 다시 시도해 주세요." };
  const expectedSourceFingerprint = cookieSignature(cookies);
  const sourceIsCurrent = () => {
    try { return cookieSignature(cookieImport.readDecryptedCookies(entry, inTargetScope)) === expectedSourceFingerprint; }
    catch { return false; }
  };
  let result;
  try { result = await cookieImport.putCookies(partition, cookies, {
    isCurrent, sourceIsCurrent, expectedTargetFingerprint,
  }); }
  catch (error) { return { ok: false, error: "로그인 쿠키를 Iris로 옮기지 못했습니다: " + String(error.message || error) }; }
  if (result && result.error) {
    if (result.error === "source-link-changed") {
      return { ok: false, error: "쿠키를 적용하기 전에 이 Iris 프로필의 Chrome 연결이 바뀌었습니다. 다시 시도해 주세요." };
    }
    if (result.error === "target-changed") {
      return { ok: false, error: "기다리는 동안 Iris의 로그인 상태가 바뀌어 Chrome 쿠키로 덮지 않았습니다." };
    }
    if (result.error === "source-changed") {
      return { ok: false, error: "Chrome 쿠키가 다시 바뀌어 안정된 한 벌을 적용하지 않았습니다. 다시 시도해 주세요." };
    }
    return { ok: false, error: result.rolledBack
      ? "로그인 쿠키를 옮기지 못해 기존 로그인을 유지했습니다."
      : "로그인 쿠키 적용과 기존 로그인 복구가 모두 실패했습니다." };
  }
  try { await session.flushStorageData(); } catch {}
  try { await session.cookies.flushStore(); } catch {}
  // 세는 값은 읽은 개수가 아니라 실제로 들어간 개수여야 한다. 이전에는 result.ok 를 읽었는데
  // putCookies 는 그 필드를 주지 않아 항상 cookies.length(읽은 수)로 떨어졌다. 그래서
  // 하나도 들어가지 않은 회차도 로그와 화면에는 성공으로 남았다(확인 결과: 로그 49개, 디스크 0개).
  const live = (result && result.live) || 0;
  const staged = (result && result.staged) || 0;
  const harvested = live + staged;
  const skipped = (result && result.skipped) || 0;
  stage("done", { harvested, live, staged, skipped, read: cookies.length, filled: fill.filled, profile: entry.label });
  if (!harvested) {
    return { ok: false, error: `${base} 쿠키를 ${cookies.length}개 읽었지만 하나도 옮기지 못했습니다. `
      + "계정 목록에서 이 프로필을 직접 불러오면 같은 쿠키를 통째로 가져올 수 있습니다." };
  }
  return { ok: true, harvested, live, staged, skipped, read: cookies.length,
    filled: fill.filled, requested: fill.requested, fillWhy: fill.why,
    profile: entry.label, via: "real-profile" };
}

async function runChromeAuth({ url, session, partition, onStage, bounds, fields: rawFields,
  chromeSource, cookieImport, chromeCid, isCurrent = () => true }) {
  const fields = sanitizeFields(rawFields);
  const stage = (name, extra) => {
    try { console.log("[chrome-auth]", name, extra ? JSON.stringify(extra).slice(0, 200) : ""); } catch {}
    logLine(name, extra);
    try { onStage && onStage({ stage: name, ...(extra || {}) }); } catch {}
  };
  let target;
  try { target = new URL(String(url)); } catch { return { ok: false, error: "주소를 해석할 수 없습니다." }; }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, error: "http(s) 주소에서만 인증을 넘길 수 있습니다." };
  if (!chromeSource || !cookieImport || typeof chromeCid !== "function") {
    return { ok: false, error: "이 Iris 프로필에 연결된 Chrome 계정이 없습니다. 계정 메뉴에서 Chrome 프로필을 먼저 가져와 주세요." };
  }
  let entry;
  try { entry = cookieImport.listChromeProfiles().find((profile) => chromeCid(profile) === chromeSource); } catch {}
  if (!entry) {
    return { ok: false, error: "연결된 Chrome 계정 프로필을 찾을 수 없습니다. 계정 메뉴에서 다시 연결해 주세요." };
  }
  return runProfileHandoff({ target, session, partition, entry, cookieImport, stage, bounds, fields, isCurrent });
}

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { runChromeAuth, runProfileHandoff, osaRun, baseDomain, inScope,
  findPoisonedChrome, sanitizeFields, fillJs };
