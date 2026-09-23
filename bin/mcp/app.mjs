// 모바일 앱 표면(Iris 에뮬레이터 탭의 iOS 시뮬레이터·Android 기기). 사람이 직접 조작하듯 앱을 조종한다.
//
// 소유 범위
//   idb·adb 호출, 켜져 있는 기기 목록과 세션별 기기 고정, 접근성 트리 읽기와 요소 참조(@a1),
//   화면 찍기, 그리고 app_* 도구 전부.
//
// 제공 API
//   createAppSurface(deps) 하나. 도구 배열과 기기 목록 해석을 함께 돌려준다.
//
// 의존 대상
//   idb 실행 파일(IRIS_IDB 로 바꿀 수 있다), adb(server/adb-path.js 가 찾는다), state-home.cjs 가 정한 상태 폴더와
//   artifacts-home.cjs 가 정한 그 안의 부산물 위치,
//   그리고 조립부가 넘겨주는 currentSession·journal·addReceipt·call(서버 호출, 탭 목록과 탭 열기에만 쓴다).
//
// 유지 조건
//   대상은 Iris 에뮬레이터 탭에 열린 기기뿐이다. Iris 앱이 꺼져 있으면 앱 도구는 거절한다. 기기를 따로
//   켜라고 안내하지 않는다. 고정하지 않으면 이 세션 스페이스의 탭 기기를 쓴다. 고정은 프로세스를 다시 띄워도 남는다.
//   요소 참조는 그 스냅샷 순간에만 유효하다. 앱에는 탭이 없고 도구 인자는 기기다.
//   좌표는 플랫폼마다 단위가 다르다(iOS 는 포인트, Android 는 픽셀). 스냅샷·탭·스와이프가 같은 기기의
//   단위를 쓰므로 섞이지 않는다.
//   통과는 영수증에서만 나온다. app_expect 도 브라우저와 같은 장부를 쓴다.
//
// 영향 범위
//   공급자는 bin/iris-mcp.mjs 의 조립부이고, 양방향 소비자는 bin/mcp/report.mjs 다.
//   앱 장면도 같은 회차 폴더·같은 표시 사이드카로 간다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/mcp/app.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { stateHome } from "../../server/state-home.cjs";
import { artifactDir } from "../../server/artifacts-home.cjs";
import { adbPath } from "../../server/adb-path.js";
import { writeMarks } from "./report.mjs";

const IRIS_HOME = stateHome();

// 기기 여럿을 동시에 조작하는 일이 흔하다. 브라우저 쪽은 서버가 나눠 처리하지만
// 앱은 서버를 거치지 않으므로 상한을 여기서 함께 둔다.
export const MAX_DEVICES = 4;

// ── iOS 시뮬레이터 ──
// 브라우저와 같은 방식을 앱에도 쓴다. idb가 접근성 트리를 주므로
// 요소를 이름으로 찾아 값을 읽을 수 있고, 그러면 판정이 인상이 아니라 사실이 된다.
// 조작은 서버(4271)를 거치지 않고 idb 를 직접 부른다. 대상 기기를 정할 때만 Iris 에 묻는다.
const IDB = process.env.IRIS_IDB || path.join(os.homedir(), ".local", "bin", "idb");
function idb(args, opts = {}) {
  return new Promise((resolve) => {
    const cp = childProcess.execFile(IDB, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 90000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String((stderr || "") + (err ? String(err.message || err) : "")) }));
    if (opts.stdin != null) { cp.stdin.write(opts.stdin); cp.stdin.end(); }
  });
}
// ── Android ──
// adb 로 같은 일을 한다. 접근성 트리는 uiautomator 가 주고, 요소를 idb 트리와 같은 모양으로 바꿔
// 아래 도구가 플랫폼을 가리지 않게 한다. 기기 값은 adb 시리얼이다(emulator-5554 등).
function adb(args, opts = {}) {
  return new Promise((resolve) => {
    const bin = adbPath();
    if (!bin) { resolve({ ok: false, out: "", err: "adb를 찾지 못했습니다(IRIS_ADB로 지정할 수 있습니다)." }); return; }
    childProcess.execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 90000, encoding: opts.binary ? "buffer" : "utf8" },
      (err, stdout, stderr) => resolve({ ok: !err, out: opts.binary ? stdout : String(stdout || ""),
        err: String((stderr || "") + (err ? String(err.message || err) : "")) }));
  });
}
// iOS udid 는 UUID 모양이고 adb 시리얼은 그렇지 않다. 기기 값만으로 어느 도구를 부를지 정한다.
const isIosUdid = (u) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(u || ""));

// ── 대상 기기: Iris 에뮬레이터 탭 ──
// 앱 도구는 Iris 에뮬레이터 탭에 열린 기기만 조작한다. 켜져 있기만 한 기기를 잡으면 에이전트가
// 사용자가 보지 않는 기기에서 확인하고, 없으면 기기를 따로 켜서 진행한다(사용자 확인 결과).
// 탭 목록은 서버가 창에 물어 준다(server/emulator-bridge.js). 조작은 그 기기에 idb·adb 로 직접 한다.
let serverCall = async () => ({ ok: false, error: "Iris 서버 호출이 연결되지 않았습니다." });
let lastOpenError = null;
async function irisTabs() {
  const r = await serverCall("app-devices", {});
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "Iris 에뮬레이터 탭 목록을 받지 못했습니다.", tabs: [] };
  const tabs = ((r.data && r.data.tabs) || []).map((t) => ({ name: t.name || "", udid: t.udid,
    platform: isIosUdid(t.udid) ? "ios" : "android", space: t.space, mine: !!t.mine }));
  return { ok: true, tabs };
}
async function bootedTargets() { return (await irisTabs()).tabs; }
// 이 세션의 스페이스에 에뮬레이터 탭을 연다(device 를 주면 그 기기로). 사용자가 보는 화면은 옮기지 않는다.
async function openIrisTab(device) {
  const r = await serverCall("app-open", device ? { device: String(device) } : {});
  if (r && r.ok && r.data && r.data.udid) { lastOpenError = null; return r.data.udid; }
  lastOpenError = (r && r.error) || "Iris 에뮬레이터 탭을 열지 못했습니다.";
  return null;
}
// 이 세션이 고정한 기기. 파일에 남겨 프로세스를 다시 띄워도 같은 기기를 계속 쓴다.
// 고정이 없으면 이 세션 스페이스의 탭 기기를 쓴다. 다른 스페이스의 탭 기기는 고정하거나 device 로 지정해야 쓴다.
const APP_TARGET_PATH = path.join(IRIS_HOME, "app-targets.json");
function readAppTargets() {
  try { return JSON.parse(fs.readFileSync(APP_TARGET_PATH, "utf8")) || {}; } catch { return {}; }
}
function pinnedDevice(session) {
  if (!session) return null;
  const v = readAppTargets()[session];
  return v && typeof v === "string" ? v : null;
}
function setPinnedDevice(session, udid) {
  if (!session) return null;
  const all = readAppTargets();
  if (udid) all[session] = udid; else delete all[session];
  try {
    fs.mkdirSync(IRIS_HOME, { recursive: true });
    fs.writeFileSync(APP_TARGET_PATH + ".tmp", JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(APP_TARGET_PATH + ".tmp", APP_TARGET_PATH);
  } catch {}
  return udid || null;
}
// 세션 해석기는 createAppSurface가 주입받는다. 모듈 헬퍼(simTarget·simTargetError)도 같은 것을 쓴다.
let sessionOf = async () => null;
// 왜 대상이 없는지는 상황마다 다르다. "없다"고만 말하면 고정해 둔 기기의 탭이 닫힌 것인지,
// Iris 가 꺼진 것인지 알 수 없어 사람이 엉뚱한 데를 본다. 어느 경우에도 기기를 따로 켜라고 하지 않는다.
async function simTargetError(want) {
  const r = await irisTabs();
  if (!r.ok) return r.error;
  const list = r.tabs;
  const names = list.map((t) => `${t.name || t.udid}(${t.udid})`).join(" · ");
  if (want != null && String(want).trim()) {
    return `Iris 에뮬레이터 탭에 열린 기기가 아닙니다: ${want}.` + (list.length ? ` 열린 기기: ${names}.` : "")
      + " 다른 기기를 쓰려면 app_target에 그 기기를 주면 이 세션 스페이스의 탭을 그 기기로 바꿉니다.";
  }
  const pin = pinnedDevice(await sessionOf());
  if (pin && !list.some((t) => t.udid === pin)) {
    return `고정해 둔 기기(${pin})가 열린 Iris 에뮬레이터 탭이 없습니다. app_target으로 다시 고정하거나 clear로 놓으세요.`
      + (list.length ? ` 열린 기기: ${names}.` : "");
  }
  return lastOpenError || "Iris 에뮬레이터 탭을 열지 못했습니다.";
}
// 적어준 값(udid 전체·앞자리·기기 이름) 하나를 탭에 열린 기기의 udid로. 없으면 null.
async function findDevice(want) {
  const w = String(want || "").trim(); if (!w) return null;
  const list = await bootedTargets();
  const hit = list.find((t) => t.udid === w) || list.find((t) => t.name === w)
    || list.find((t) => t.udid.toLowerCase().startsWith(w.toLowerCase()));
  return hit ? hit.udid : null;
}
// want를 주면 탭에 열린 그 기기. 없으면 이 세션이 고정한 기기, 그것도 없으면 이 세션 스페이스의 탭 기기.
// 그 탭도 없으면 이 세션 스페이스에 탭을 열어 기본 기기를 켠다.
async function simTarget(want) {
  if (want != null && String(want).trim()) return findDevice(want);
  const pin = pinnedDevice(await sessionOf());
  const r = await irisTabs();
  if (!r.ok) { lastOpenError = r.error; return null; }
  const list = r.tabs;
  if (pin) {
    if (list.some((t) => t.udid === pin)) return pin;   // 아직 탭에 열려 있으면 그것만 쓴다
    // 고정한 기기의 탭이 닫혔다. 조용히 다른 기기로 갈아타지 않는다. 사용자가 모르는 사이에 대상이 바뀌는 동작을 막는다.
    return null;
  }
  const mine = list.find((t) => t.mine);
  if (mine) return mine.udid;
  return openIrisTab(null);
}
// 스냅샷이 준 참조(@a1…)는 그 스냅샷 순간에만 유효하다. 화면이 바뀌면 다시 뜬다.
// 참조(@a1…)는 기기마다 따로 둔다. 표 하나를 공유하면 기기를 여럿 켜 두고 동시에
// 스냅샷을 뜰 때 나중 스냅샷이 앞 것을 덮어써 @a3 이 다른 기기의 요소를 가리킨다.
const appRefsByDevice = new Map();   // udid → Map(ref → element)
const refsOf = (udid) => { let m = appRefsByDevice.get(udid); if (!m) { m = new Map(); appRefsByDevice.set(udid, m); } return m; };
const appVisible = (e) => e && e.frame && e.frame.width > 0 && e.frame.height > 0;
const appName = (e) => String(e.AXLabel || e.title || e.AXValue || "").trim();
async function iosTree(udid) {
  const r = await idb(["ui", "describe-all", "--udid", udid]);
  if (!r.ok) throw new Error("접근성 트리를 읽지 못했습니다 — 시뮬레이터가 켜져 있는지 확인하세요. " + r.err.slice(0, 200));
  let t; try { t = JSON.parse(r.out); } catch { throw new Error("접근성 트리를 해석하지 못했습니다."); }
  return Array.isArray(t) ? t : [];
}
const xmlText = (v) => String(v || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
// uiautomator 노드를 idb 요소 모양으로 바꾼다. 이름은 글자, 없으면 content-desc. 입력칸은 글자를 값으로,
// 켜고 끄는 요소는 iOS 스위치처럼 "1"/"0" 을 값으로 둔다. 맨 앞에 앱(패키지)과 화면 크기를 담은
// Application 요소를 하나 둔다. 아래 도구가 앱 이름과 표시 기준 크기를 거기서 읽는다.
async function androidTree(serial) {
  const r = await adb(["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]);
  if (!r.ok || !r.out.includes("<hierarchy")) throw new Error("접근성 트리를 읽지 못했습니다 — 기기가 켜져 있고 화면이 잠겨 있지 않은지 확인하세요. " + (r.err || r.out).slice(0, 200));
  return parseUiautomator(r.out);
}
export function parseUiautomator(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const at = {};
    // 값에 " 가 들어 있으면 uiautomator 가 그 속성만 작은따옴표로 감싼다.
    for (const a of m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) at[a[1]] = xmlText(a[2] ?? a[3]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(at.bounds || "");
    const frame = b ? { x: +b[1], y: +b[2], width: +b[3] - +b[1], height: +b[4] - +b[2] } : null;
    const cls = String(at.class || "").split(".").pop();
    const text = at.text || "", desc = at["content-desc"] || "";
    const e = { type: cls || "View", AXLabel: text || desc, frame, enabled: at.enabled !== "false", resourceId: at["resource-id"] || undefined };
    if (/EditText/.test(cls)) e.AXValue = text;
    else if (at.checkable === "true") e.AXValue = at.checked === "true" ? "1" : "0";
    if (!out.length) out.push({ type: "Application", AXLabel: at.package || "", frame });
    out.push(e);
  }
  return out;
}
const appTree = (udid) => (isIosUdid(udid) ? iosTree(udid) : androidTree(udid));

// 조작. 같은 이름의 동작을 플랫폼마다 한 번씩 적는다. 결과는 idb 와 같은 {ok, err} 모양이다.
const ANDROID_BUTTON = { HOME: 3, BACK: 4, LOCK: 26, SIDE_BUTTON: 26 };
const IOS_BUTTON = new Set(["HOME", "LOCK", "SIDE_BUTTON", "SIRI", "APPLE_PAY"]);
function tapAt(u, x, y) {
  return isIosUdid(u) ? idb(["ui", "tap", "--udid", u, String(x), String(y)])
    : adb(["-s", u, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
}
function typeText(u, text) {
  if (isIosUdid(u)) return idb(["ui", "text", "--udid", u, text]);
  // input text 는 ASCII 만 받는다. 한글을 보내면 기기에서 NullPointerException 으로 끝나 이유를 알 수 없으므로 먼저 거절한다.
  if (/[^\x20-\x7e]/.test(text)) return Promise.resolve({ ok: false, err: "Android 입력은 영문·숫자·기호만 넣을 수 있습니다(adb input text 제약)." });
  // adb shell 은 인자를 기기의 sh 에 한 줄로 넘긴다. 공백은 input 의 %s, 셸 문자는 역슬래시로 막는다.
  const arg = text.replace(/[\\'"\x60$&|;<>()*?!#~\[\]{}^]/g, "\\$&").replace(/ /g, "%s");
  return adb(["-s", u, "shell", "input", "text", arg]);
}
function pressButton(u, button) {
  if (isIosUdid(u)) {
    if (!IOS_BUTTON.has(button)) return Promise.resolve({ ok: false, err: `iOS에는 ${button} 버튼이 없습니다.` });
    return idb(["ui", "button", "--udid", u, button]);
  }
  const code = ANDROID_BUTTON[button];
  if (code == null) return Promise.resolve({ ok: false, err: `Android에는 ${button} 버튼이 없습니다(HOME·BACK·LOCK).` });
  return adb(["-s", u, "shell", "input", "keyevent", String(code)]);
}
function pressKeycode(u, keycode) {
  return isIosUdid(u) ? idb(["ui", "key", "--udid", u, String(keycode)])
    : adb(["-s", u, "shell", "input", "keyevent", String(keycode)]);
}
function swipe(u, { x1, y1, x2, y2, duration }) {
  if (isIosUdid(u)) {
    const args = ["ui", "swipe", "--udid", u, String(x1), String(y1), String(x2), String(y2)];
    if (duration) args.push("--duration", String(duration));
    return idb(args);
  }
  const ms = Math.round((Number(duration) || 0.3) * 1000);
  return adb(["-s", u, "shell", "input", "swipe", ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(ms)]);
}
async function screenshotTo(u, p) {
  if (isIosUdid(u)) return idb(["screenshot", "--udid", u, p]);
  const r = await adb(["-s", u, "exec-out", "screencap", "-p"], { binary: true });
  if (!r.ok || !r.out || !r.out.length) return { ok: false, err: r.err || "빈 화면" };
  fs.writeFileSync(p, r.out);
  return { ok: true, err: "" };
}
function appSnapshotText(tree, udid) {
  const appRefs = refsOf(udid); appRefs.clear();
  const app = tree.find((e) => e.type === "Application");
  const lines = [];
  let n = 0;
  for (const e of tree) {
    if (!appVisible(e) || e.type === "Application" || e.type === "GenericElement") continue;
    const nm = appName(e);
    if (!nm) continue;
    const ref = "@a" + ++n;
    appRefs.set(ref, e);
    lines.push(`${ref} [${e.type}] "${nm}"${e.AXValue && e.AXValue !== nm ? ` = "${e.AXValue}"` : ""}${e.enabled === false ? " (비활성)" : ""}`);
  }
  return { text: lines.join("\n"), count: n, app: app ? appName(app) : "", frame: app ? app.frame : null };
}
// 이름만으로는 겹친다(같은 화면에 "설정"이 둘). 유형과 순번으로 좁히고, 여럿이 걸리면 그 사실을 말한다.
function appFind(tree, { ref, label, type, nth }, udid) {
  if (ref) { const e = refsOf(udid).get(String(ref)); return { hits: e ? [e] : [], why: e ? "" : `그런 참조가 없습니다: ${ref}. app_snapshot을 다시 뜨세요.` }; }
  const want = String(label || "").trim();
  let hits = tree.filter((e) => appVisible(e) && appName(e) && (want ? appName(e) === want : true));
  if (!hits.length && want) hits = tree.filter((e) => appVisible(e) && appName(e).includes(want));
  if (type) hits = hits.filter((e) => String(e.type).toLowerCase() === String(type).toLowerCase());
  if (nth != null) { const i = Number(nth) - 1; hits = hits[i] ? [hits[i]] : []; }
  return { hits, why: hits.length ? "" : `"${want}"에 맞는 요소가 없습니다.` };
}
// 표시 상자. 요소 frame 은 width·height 인데 writeMarks 는 w·h 를 읽는다. 그대로 넘기면 상자 크기가 null 로 남는다.
export const appMark = (frame, label, color) => ({ x: frame.x, y: frame.y, w: frame.width, h: frame.height, label, ...(color ? { color } : {}) });
const appCenter = (e) => ({ x: Math.round(e.frame.x + e.frame.width / 2), y: Math.round(e.frame.y + e.frame.height / 2) });
// 표시는 이미지를 고치지 않고 옆 파일에 남긴다. 앱 스크린샷에는 그릴 도구가 없고, 보고서에서
// 겹쳐 그리면 확대해도 안 깨진다. 좌표는 0~1 비율이라 해상도가 달라도 그대로 맞는다.
async function appShot(udid, { marks, frame, caption } = {}) {
  const dir = artifactDir("shots", IRIS_HOME);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "app-" + Date.now() + ".png");
  const r = await screenshotTo(udid, p);
  if (!r.ok || !fs.existsSync(p)) throw new Error("스크린샷 실패: " + r.err.slice(0, 200));
  writeMarks(p, marks, frame);
  if (caption) { try { fs.writeFileSync(String(p) + ".caption.txt", String(caption)); } catch {} }
  return p;
}


// 앱 증거의 "어디서"에 해당하는 값. 브라우저의 url 에 대응하며 기기와 그때 떠 있던 앱을 잇는다.
// Android 시리얼은 앞 8자가 겹친다(emulator-5554·emulator-5556). 그래서 시리얼은 그대로 적는다.
function appIdent(udid, app) {
  const name = app ? appName(app) : "";
  const id = isIosUdid(udid) ? String(udid).slice(0, 8) : String(udid || "");
  return "app://" + id + (name ? "/" + name : "");
}
export function createAppSurface({ currentSession, journal, addReceipt, call }) {
  sessionOf = currentSession;
  if (typeof call === "function") serverCall = call;
  const TOOLS = [
  { name: "app_targets", desc: "Iris 에뮬레이터 탭에 열린 기기 목록(iOS 시뮬레이터·Android) — 기기 이름, udid(Android는 adb 시리얼), platform, 이 세션 스페이스의 탭인지(mine). 앱 도구는 이 기기들만 조작한다. 여러 대를 동시에 조작하려면 여기서 얻은 값을 device에 넣는다(최대 4, 스페이스마다 탭 하나).",
    schema: {}, app: true,
    run: async () => {
      const session = await currentSession();
      const r = await irisTabs();
      if (!r.ok) return { ok: false, error: r.error };
      const list = r.tabs;
      const pin = pinnedDevice(session);
      return { ok: true, data: { count: list.length, pinned: pin,
        targets: list.map((t) => ({ ...t, pinned: t.udid === pin })),
        note: !list.length ? "열린 에뮬레이터 탭이 없습니다 — 다른 app_* 도구를 부르면 이 세션 스페이스에 탭을 열어 기본 기기를 켭니다. 특정 기기가 필요하면 app_target에 그 기기를 주세요."
          : !pin && list.length > 1 ? "기기가 여럿입니다 — 지정 없는 명령은 이 세션 스페이스의 탭(mine)으로 갑니다. 다른 기기를 쓰려면 app_target으로 고정하세요." : undefined } };
    } },
  { name: "app_target", desc: "이 세션이 쓸 기기를 고정한다. 고정하면 지정 없는 app_* 명령이 항상 그 기기로 간다. Iris 탭에 열려 있지 않은 기기를 주면 이 세션 스페이스의 에뮬레이터 탭을 그 기기로 바꿔 켠 뒤 고정한다(기기 이름은 Iris 모바일 화면의 목록 이름). device 없이 부르면 조회, clear로 해제. 고정은 프로세스가 다시 떠도 유지된다.",
    schema: { device: { type: "string", description: "app_targets가 준 udid·시리얼(앞자리만 적어도 됨) 또는 기기 이름(예: iPhone 16, Pixel_API_35)" }, clear: { type: "boolean" } }, app: true,
    run: async (a) => {
      const session = await currentSession();
      if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 고정은 herdr pane 안에서만 됩니다." };
      if (a.clear) { setPinnedDevice(session, null); return { ok: true, data: { session, pinned: null, note: "고정을 놓았습니다 — 이제 이 세션 스페이스의 탭 기기를 씁니다." } }; }
      if (a.device == null || !String(a.device).trim()) {
        const pin = pinnedDevice(session);
        const r = await irisTabs();
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, data: { session, pinned: pin,
          alive: pin ? r.tabs.some((t) => t.udid === pin) : null, targets: r.tabs } };
      }
      // 탭에 없는 기기면 에이전트가 따로 켜지 않고 Iris 가 이 세션 스페이스의 탭에서 켠다.
      const u = (await findDevice(a.device)) || (await openIrisTab(a.device));
      if (!u) return { ok: false, error: lastOpenError || `그 기기를 열지 못했습니다: ${a.device}.` };
      setPinnedDevice(session, u);
      const list = await bootedTargets();
      const t = list.find((x) => x.udid === u);
      return { ok: true, data: { session, pinned: u, name: t ? t.name : "", note: "지정 없는 app_* 명령은 이제 이 기기로만 갑니다." } };
    } },
  { name: "app_snapshot", desc: "지금 기기 화면에 무엇이 있는지 — 요소 참조(@a1…)·유형·이름·값. 무엇을 만질지 모를 때 먼저 쓴다. 참조는 이 스냅샷 순간에만 유효하다. 좌표는 iOS는 포인트, Android는 픽셀이다.",
    schema: {}, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const t = await appTree(u); const s = appSnapshotText(t, u);
      return { ok: true, data: { app: s.app, count: s.count, screen: s.frame, snapshot: s.text } };
    } },
  { name: "app_tap", desc: "요소를 누른다. ref(@a3) 또는 label로 지정하고, 같은 이름이 여럿이면 type·nth로 좁힌다. 좌표(x,y)로도 누를 수 있다.",
    schema: { ref: { type: "string" }, label: { type: "string", description: "화면에 보이는 이름" },
      type: { type: "string", description: "Button·StaticText·Image 등(Android는 Button·TextView·EditText 등 클래스 이름)" }, nth: { type: "number", description: "같은 것이 여럿일 때 몇 번째(1부터)" },
      x: { type: "number" }, y: { type: "number" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      let x = a.x, y = a.y, name = "";
      if (x == null || y == null) {
        const t = await appTree(u); const f = appFind(t, a, u);
        if (!f.hits.length) return { ok: false, error: f.why };
        if (f.hits.length > 1) return { ok: false, error: `"${a.label}"에 ${f.hits.length}개가 걸립니다 — type이나 nth로 좁히세요.`, data: { hits: f.hits.map((e) => ({ type: e.type, name: appName(e), frame: e.frame })) } };
        const c = appCenter(f.hits[0]); x = c.x; y = c.y; name = appName(f.hits[0]);
      }
      const r = await tapAt(u, x, y);
      return r.ok ? { ok: true, data: { tapped: name || `(${x}, ${y})`, x, y } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_text", desc: "지금 포커스된 입력칸에 글자를 넣는다. 먼저 그 칸을 app_tap으로 눌러 포커스를 준다.",
    schema: { text: { type: "string" } }, req: ["text"], app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const r = await typeText(u, String(a.text));
      return r.ok ? { ok: true, data: { typed: String(a.text).length + "자" } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_key", desc: "하드웨어 버튼 또는 키코드를 누른다. iOS는 HOME·LOCK·SIDE_BUTTON·SIRI·APPLE_PAY, Android는 HOME·BACK·LOCK(SIDE_BUTTON은 LOCK과 같다). keycode는 iOS면 HID 키코드, Android면 KeyEvent 코드다.",
    schema: { button: { type: "string", enum: ["HOME", "BACK", "LOCK", "SIDE_BUTTON", "SIRI", "APPLE_PAY"] }, keycode: { type: "number" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const r = a.keycode != null ? await pressKeycode(u, a.keycode) : await pressButton(u, String(a.button || "HOME"));
      return r.ok ? { ok: true, data: { pressed: a.keycode != null ? "키 " + a.keycode : a.button || "HOME" } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_swipe", desc: "한 점에서 다른 점으로 쓸어넘긴다(스크롤·페이지 전환).",
    schema: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
      duration: { type: "number", description: "초. 기본 0.3" } }, req: ["x1", "y1", "x2", "y2"], app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const r = await swipe(u, a);
      return r.ok ? { ok: true, data: { swiped: `(${a.x1},${a.y1}) → (${a.x2},${a.y2})` } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_screenshot", desc: "기기 화면을 PNG로 남긴다. mark로 볼 곳을 지정하면 보고서에서 그 자리에 상자와 설명이 겹쳐 그려진다(원본은 안 상한다). caption은 이 장면이 무엇을 증명하는지 한 줄.",
    schema: { mark: { type: "array", description: "볼 곳들. {label?, ref?|label 매칭용 name, type?, nth?}",
        items: { type: "object", properties: { ref: { type: "string" }, name: { type: "string" }, type: { type: "string" }, nth: { type: "number" }, label: { type: "string" } } } },
      caption: { type: "string" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const t = await appTree(u);
      const app = t.find((e) => e.type === "Application");
      const marks = [];
      for (const m of (a.mark || [])) {
        const f = appFind(t, { ref: m.ref, label: m.name || m.label, type: m.type, nth: m.nth }, u);
        if (f.hits[0]) marks.push(appMark(f.hits[0].frame, m.label || appName(f.hits[0])));
      }
      const p = await appShot(u, { marks, frame: app && app.frame, caption: a.caption });
      // 앱은 idb·adb를 직접 부르므로 서버를 지나지 않는다. 장면도 회차 장부에 직접 제출해야
      // 회차 폴더에 보존된다. 보존되지 않으면 상태 폴더의 60장 정리에 밀려 보고할 때 이미 없다.
      // 어느 기기·어느 앱 화면에서 찍혔는지 함께 적는다. 브라우저 장면은 url을 적지만 앱 장면은
      // 이 값이 없었다(확인 결과: artifact 301건 전부 없음). 그 줄이 무엇을 확인하는
      // 화면인가를 정하는 값이라, 없으면 보고서가 장면을 줄 주제 밖으로 분류한다.
      const j = await journal({ kind: "artifact", source: "app", shot: p, caption: a.caption,
        url: appIdent(u, app) });
      return { ok: true, data: { path: (j && j.shot) || p, marks: marks.length,
        장부: j ? undefined : "안 실림 — 회차가 없거나 서버가 거절했다" } };
    } },
  { name: "app_expect", desc: "화면에 그 요소가 있고 값이 기대와 같은지 확인하고, 그 판정의 근거를 표시한 스크린샷까지 같은 순간에 남긴다. 보고서의 통과는 이 도구가 돌려주는 receipt에서만 나온다.",
    schema: { label: { type: "string", description: "찾을 이름" }, ref: { type: "string" },
      type: { type: "string" }, nth: { type: "number" },
      text: { type: "string", description: "기대하는 값·문구(생략하면 존재만 확인)" },
      mode: { type: "string", enum: ["contains", "equals", "exists", "absent"] } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const t = await appTree(u);
      const app = t.find((e) => e.type === "Application");
      const mode = String(a.mode || (a.text == null ? "exists" : "contains"));
      const f = appFind(t, a, u);
      const hit = f.hits[0];
      const got = hit ? (appName(hit) + (hit.AXValue && hit.AXValue !== appName(hit) ? " / " + hit.AXValue : "")) : null;
      const pass = mode === "absent" ? !hit
        : !hit ? false
        : a.text == null ? true
        : mode === "equals" ? got === String(a.text) : String(got).includes(String(a.text));
      const desc = mode === "absent" ? `"${a.label}" 없음` : mode === "exists" ? `"${a.label}" 있음`
        : `"${a.label}" ${mode === "equals" ? "=" : "⊃"} "${a.text}"`;
      const shot = await appShot(u, {
        marks: hit ? [appMark(hit.frame, desc, pass ? "#8BFBC2" : "#FF7A72")] : [],
        frame: app && app.frame, caption: `${pass ? "됨" : "안 됨"} · ${desc}${hit ? "" : " (요소 없음)"}`,
      }).catch(() => null);
      // 앱은 idb·adb를 직접 부르므로 서버를 지나지 않는다. 그래서 판정을 회차 장부에 직접 제출한다.
      // 이 자리가 없으면 앱 단계는 파생에서 빠지고 다시 모델 서술로 되돌아간다.
      const j = await journal({ kind: "assertion", source: "app",
        selector: String(a.ref || a.label || ""), mode, want: a.text ?? null,
        url: appIdent(u, app),
        matched: f.hits.length,
        expected: desc, got, pass, found: !!hit, shot });
      const rc = addReceipt({ surface: "app", selector: a.ref || a.label, mode, want: a.text ?? null,
        expected: desc, got, pass, found: !!hit, shot: (j && j.shot) || shot }, j && j.id);
      return { ok: true, data: { pass, expected: desc, got, found: !!hit, hits: f.hits.length,
        shot: (j && j.shot) || shot, receipt: rc.id } };
    } },
  { name: "app_observe", desc: "지금 앱이 어떤 상태인지 한 번에 — 화면 한 장, 무엇이 떠 있는지, 경고·시트가 있는지. 뭔가 안 될 때 먼저 부른다.",
    schema: {}, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const t = await appTree(u);
      const app = t.find((e) => e.type === "Application");
      const s = appSnapshotText(t, u);
      const alerts = t.filter((e) => /Alert|Sheet|Dialog/i.test(String(e.type))).map((e) => appName(e)).filter(Boolean);
      const shot = await appShot(u, { frame: app && app.frame, caption: "지금 상태" }).catch(() => null);
      // app_screenshot과 같은 이유로 회차 장부에 제출한다. 실패했을 때 찍은 이 한 장이
      // 보고서에서 가장 먼저 필요한데, 보존하지 않으면 그 장이 먼저 사라진다.
      // 실패 원인을 보려고 만든 도구이므로 원인도 함께 남긴다. 떠 있던 경고·시트와
      // 화면에 있던 요소 수를 빼면 장면 하나만 남는다(확인 결과: 상세 0).
      const j = shot ? await journal({ kind: "artifact", source: "app", shot, caption: "지금 상태",
        url: appIdent(u, app),
        detail: { app: s.app, screen: s.frame, elements: s.count, alerts } }) : null;
      return { ok: true, data: { app: s.app, screen: s.frame, elements: s.count, alerts,
        shot: (j && j.shot) || shot, snapshot: s.text.slice(0, 2000) } };
    } },
  // 사람이 시뮬레이터·에뮬레이터 화면에서 직접 가리킨 것. 브라우저의 browser_picks에 대응한다.
  // 이쪽은 서버가 Flutter 검사기에서 받아 두므로 idb·adb를 지나지 않는다. 그래서 app: true가 아니다.
  { name: "app_picks", desc: "사용자가 앱 화면에서 직접 고른 요소들(최근 10개). 터미널에 붙은 글은 사람이 읽는 형식이고, 이 도구는 위젯 이름·소스 파일과 줄·상위 위젯 경로 같은 원본 필드를 준다. 고른 것이 무엇이었는지 다시 확인하거나 여러 개를 한꺼번에 다룰 때 쓴다.",
    schema: {}, run: (a, C) => C("app-picks") },
  ];
  // 앱 조작을 장부에 남긴다. 브라우저는 조작마다 accepted·completed 짝과 전후 프레임이 서버에서
  // 자동으로 남지만(server/browser-commands.js), 앱은 idb·adb를 직접 부르므로 그 경로를 지나지 않는다.
  // 그대로 두면 tap·text·key·swipe 넷이 장부에 한 건도 남지 않는다(확인 결과: 기록 0건). 앱으로만
  // 조작한 줄은 "무엇을 눌렀는가"가 어디에도 남지 않는다.
  //
  // 도구마다 journal 호출을 넣지 않는다. 도구가 늘 때마다 같은 곳이 다시 빈다. 조작이라는 것을
  // 한 번 선언하고 감싼다.
  const APP_ACT = new Set(["app_tap", "app_text", "app_key", "app_swipe"]);
  for (const t of TOOLS) {
    if (!APP_ACT.has(t.name)) continue;
    const inner = t.run;
    t.run = async (a, C) => {
      const dev = await simTarget(a && a.device).catch(() => null);
      const target = a && (a.ref || a.label || a.button
        || (a.keycode != null ? "키 " + a.keycode : "")
        || (a.x != null ? `(${a.x}, ${a.y})` : "")
        || (a.x1 != null ? `(${a.x1},${a.y1}) → (${a.x2},${a.y2})` : "")
        || (a.text != null ? String(a.text).length + "자 입력" : "")) || "";
      // 값은 담지 않는다. 비밀이 섞일 수 있으므로 길이만 남긴다(브라우저 트레이스와 같은 규칙).
      const j = await journal({ kind: "accepted", source: "app", cmd: t.name.slice(4),
        target: String(target).slice(0, 120), url: dev ? "app://" + dev : undefined });
      const r = await inner(a, C);
      await journal({ kind: "completed", source: "app", cmd: t.name.slice(4),
        call_id: j && j.call_id, target: String(target).slice(0, 120),
        url: dev ? "app://" + dev : undefined,
        ok: !!(r && r.ok),
        error: r && !r.ok ? String(r.error || "").slice(0, 200) : undefined,
        detail: r && r.ok ? r.data : undefined });
      return r;
    };
  }
  return { tools: TOOLS, bootedTargets, simTarget, pinnedDevice, MAX_DEVICES };
}
