// 모바일 앱 표면(Iris 에뮬레이터 탭의 iOS 시뮬레이터·Android 기기). 사람이 직접 조작하듯 앱을 조종한다.
//
// 소유 범위
//   idb·adb 호출, 켜져 있는 기기 목록과 세션별 등록 기기, 접근성 트리 읽기와 요소 참조(@a1),
//   화면 찍기, 그리고 app_* 도구 전부.
//
// 제공 API
//   createAppSurface(deps) 하나. 도구 배열과 기기 목록 해석을 함께 돌려준다.
//
// 의존 대상
//   idb(idb-path.mjs 가 찾는다), adb(server/adb-path.js 가 찾는다), state-home.cjs 가 정한 상태 폴더와
//   artifacts-home.cjs 가 정한 그 안의 부산물 위치,
//   그리고 조립부가 넘겨주는 currentSession·call(서버 호출, 탭 목록과 탭 열기에만 쓴다).
//
// 유지 조건
//   대상은 Iris 에뮬레이터 탭에 열린 기기뿐이다. Iris 앱이 꺼져 있으면 앱 도구는 거절한다. 기기를 따로
//   켜라고 안내하지 않는다. 등록 기기가 없으면 이 세션만의 에뮬레이터를 켜서 쓴다. 등록 목록은 프로세스를 다시 띄워도 남는다.
//   요소 참조는 그 스냅샷 순간에만 유효하다. 앱에는 탭이 없고 도구 인자는 기기다.
//   좌표는 플랫폼마다 단위가 다르다(iOS 는 포인트, Android 는 픽셀). 스냅샷·탭·스와이프가 같은 기기의
//   단위를 쓰므로 섞이지 않는다.
// 영향 범위
//   공급자는 bin/iris-mcp.mjs 의 조립부다. 앱 장면의 표시 사이드카는 report.mjs의 그리기 함수를 쓴다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/mcp/app.mjs

import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { stateHome } from "../../server/state-home.cjs";
import { artifactDir } from "../../server/artifacts-home.cjs";
import { adbPath } from "../../server/adb-path.js";
import { androidScreenshotPng } from "../../server/android-screencap.js";
import { idbPath, IDB_MISSING } from "./idb-path.mjs";
import { refreshIdbCompanion } from "./idb-companion.mjs";
import { needsPaste, pasteIosText } from "./idb-paste.mjs";
import { createIosHid } from "./ios-hid.mjs";
import { MAX_APP_TARGETS, appDeviceTargetId, resolveAppDeviceTarget } from "../../server/app-targets.js";
import { writeMarks } from "./report.mjs";

const IRIS_HOME = stateHome();

// 기기 여럿을 동시에 조작하는 일이 흔하다. 서버 저장소와 MCP 응답이 같은 상한을 쓴다.
export const MAX_DEVICES = MAX_APP_TARGETS;

// ── iOS 시뮬레이터 ──
// 브라우저와 같은 방식을 앱에도 쓴다. idb가 접근성 트리를 주므로
// 요소를 이름으로 찾아 값을 읽을 수 있고, 그러면 판정이 인상이 아니라 사실이 된다.
// 조작은 서버(4271)를 거치지 않고 idb 를 직접 부른다. 대상 기기를 정할 때만 Iris 에 묻는다.
async function idb(args, opts = {}) {
  // 이전 부팅에 묶인 companion 교체(idb-companion.mjs)
  const at = args.indexOf("--udid");
  if (at >= 0 && args[at + 1]) await refreshIdbCompanion(args[at + 1]).catch(() => false);
  return new Promise((resolve) => {
    const bin = idbPath();
    if (!bin) { resolve({ ok: false, out: "", err: IDB_MISSING }); return; }
    const cp = childProcess.execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 90000 },
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
const noServerCall = async () => ({ ok: false, error: "Iris 서버 호출이 연결되지 않았습니다." });
let serverCall = noServerCall;
let lastOpenError = null;
let lastDeviceError = null;
async function irisTabs() {
  const r = await serverCall("app-devices", {});
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "Iris 에뮬레이터 탭 목록을 받지 못했습니다.", tabs: [] };
  // QA 회차가 잡은 기기는 빼되, 사용자가 지목해 이 세션에 등록한 기기는 남긴다
  const all = (r.data && r.data.tabs) || [];
  const registered = all.some(t => t.qaRun) ? (await registeredDeviceState(await sessionOf())).devices : [];
  const tabs = all.filter(t => !t.qaRun || registered.includes(t.udid) || (t.persistentId && registered.includes(t.persistentId))).map((t) => ({ name: t.name || "", udid: t.udid,
    persistentId: t.persistentId || null,
    platform: isIosUdid(t.udid) ? "ios" : "android", space: t.space, mine: !!t.mine, own: !!t.owner && !!t.mine }));
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
// 상태 파일은 서버 한 곳만 쓴다. MCP는 브라우저 명령 경로로 조회·교체한다.
async function registeredDeviceState(session) {
  if (!session) return { ok: true, devices: [] };
  const r = await serverCall("app-targets-get", {});
  if (!r?.ok) return { ok: false, devices: [], error: r?.error || "등록 기기 목록을 읽지 못했습니다." };
  return { ok: true, devices: Array.isArray(r.data?.devices) ? r.data.devices.slice(0, MAX_DEVICES) : [] };
}
async function registeredDevices(session) { return (await registeredDeviceState(session)).devices; }
async function replaceRegisteredDevices(session, devices) {
  if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음)." };
  return serverCall("app-targets-set", { devices });
}
// 세션 해석기는 createAppSurface가 주입받는다. 모듈 헬퍼(simTarget·simTargetError)도 같은 것을 쓴다.
let sessionOf = async () => null;
// 왜 대상이 없는지는 상황마다 다르다. "없다"고만 말하면 등록한 기기의 탭이 닫힌 것인지,
// Iris 가 꺼진 것인지 알 수 없어 사람이 엉뚱한 데를 본다. 어느 경우에도 기기를 따로 켜라고 하지 않는다.
async function simTargetError(want) {
  const r = await irisTabs();
  if (!r.ok) return r.error;
  if (lastDeviceError) return lastDeviceError;
  const list = r.tabs;
  const names = list.map((t) => `${t.name || t.udid}(${t.udid})`).join(" · ");
  if (want != null && String(want).trim()) {
    return `Iris 에뮬레이터 탭에 열린 기기가 아닙니다: ${want}.` + (list.length ? ` 열린 기기: ${names}.` : "")
      + " 다른 기기를 쓰려면 app_target에 그 기기를 주면 이 세션의 에뮬레이터 탭을 그 기기로 바꿉니다.";
  }
  const registration = await registeredDeviceState(await sessionOf());
  if (!registration.ok) return registration.error;
  const registered = registration.devices;
  if (registered.length > 1) {
    const labels = registered.map((udid) => {
      const target = resolveAppDeviceTarget(udid, list);
      return `${target?.name || udid}(${target?.udid || udid})`;
    });
    return `이 세션에 기기가 ${registered.length}대 등록돼 있습니다: ${labels.join(" · ")}. app_* 도구에 device를 적으세요.`;
  }
  const pin = registered[0];
  if (/^emulator-\d+$/.test(pin || "")) {
    return `이전에 시리얼(${pin})로 등록한 Android 기기는 확인할 수 없습니다. Iris 기기 화면에서 다시 지목하거나 app_target에 AVD 이름을 적으세요.`;
  }
  if (pin && !resolveAppDeviceTarget(pin, list)) {
    return `등록한 기기(${pin})가 열린 Iris 에뮬레이터 탭이 없습니다. app_target으로 다시 등록하거나 clear로 놓으세요.`
      + (list.length ? ` 열린 기기: ${names}.` : "");
  }
  return lastOpenError || "Iris 에뮬레이터 탭을 열지 못했습니다.";
}
// 적어준 값(udid 전체·앞자리·기기 이름) 하나를 탭에 열린 기기의 udid로. 없으면 null.
async function findDevice(want) {
  lastDeviceError = null;
  const w = String(want || "").trim(); if (!w) return null;
  const list = await bootedTargets();
  if (w.startsWith("avd:")) return resolveVerifiedDevice(w, list);
  const exact = list.find((t) => t.udid === w);
  if (exact) return exact.udid;
  let matches = list.filter((t) => t.name === w);
  if (!matches.length) matches = list.filter((t) => t.udid.toLowerCase().startsWith(w.toLowerCase()));
  if (matches.length > 1) {
    lastDeviceError = `기기가 여러 대 일치합니다: ${w}. app_targets에서 정확한 UDID를 확인해 지정하세요.`;
    return null;
  }
  return matches[0]?.udid || null;
}

async function verifyAvdTarget(target, serial) {
  if (!target.startsWith("avd:")) return true;
  const expected = target.slice(4);
  const result = await adb(["-s", serial, "emu", "avd", "name"], { timeout: 5000 });
  const lines = String(result.out || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (result.ok && lines[0] === expected && lines.slice(1).includes("OK")) return true;
  lastDeviceError = `지목한 Android AVD(${expected})와 실행 중인 기기를 확인하지 못했습니다. Iris 기기 목록을 새로 고침한 뒤 다시 지목하세요.`;
  return false;
}

async function resolveVerifiedDevice(target, list) {
  const device = resolveAppDeviceTarget(target, list);
  return device && await verifyAvdTarget(target, device.udid) ? device.udid : null;
}
// want를 주면 탭에 열린 그 기기. 없으면 이 세션에 등록된 한 대, 그것도 없으면 이 세션 소유 탭의 기기.
// 그 탭도 없으면 다른 화면이 쓰지 않는 기기로 이 세션의 탭을 연다(서버가 한도를 확인하고 등록한다).
async function simTarget(want) {
  lastDeviceError = null;
  if (want != null && String(want).trim()) return findDevice(want);
  const registration = await registeredDeviceState(await sessionOf());
  if (!registration.ok) { lastOpenError = registration.error; return null; }
  const registered = registration.devices;
  const r = await irisTabs();
  if (!r.ok) { lastOpenError = r.error; return null; }
  const list = r.tabs;
  if (registered.length > 1) return null;
  const pin = registered[0];
  if (pin) {
    const target = await resolveVerifiedDevice(pin, list);
    if (target) return target;
    // 등록한 기기의 탭이 닫혔다. 조용히 다른 기기로 갈아타지 않는다. 사용자가 모르는 사이에 대상이 바뀌는 동작을 막는다.
    return null;
  }
  // 등록한 기기가 없으면 이 세션만의 에뮬레이터를 쓴다. 이미 켠 것이 있으면 그것을, 없으면 다른 세션이 쓰지 않는 기기를 켜고
  // 서버가 이 세션에 등록한다. 스페이스 공용 탭(사람이 연 탭)은 다른 세션도 쓰므로 가져오지 않는다.
  const own = list.find((t) => t.own);
  if (own) return own.udid;
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
const IOS_BUTTON = new Set(["HOME", "LOCK", "SIDE_BUTTON"]);
// iOS 입력은 사람 터치와 같은 serve-sim 도우미로(ios-hid.mjs). idb 입력 명령은 사람 터치를 막는다
const iosHid = createIosHid({ readTree: (u) => iosTree(u) });
const hidResult = (p) => p.then(() => ({ ok: true, out: "", err: "" }), (error) => ({ ok: false, out: "", err: error.message }));
// adb 좌표는 정수만 받음
function tapAt(u, x, y) {
  return isIosUdid(u) ? hidResult(iosHid.tap(u, x, y))
    : adb(["-s", u, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
}
function typeText(u, text) {
  // 도우미 키 입력은 ASCII 만 보냄. 한글 등은 붙여넣기
  if (isIosUdid(u) && needsPaste(text)) return refreshIdbCompanion(u).catch(() => false).then(() => pasteIosText(u, text))
    .then(() => ({ ok: true, out: "", err: "" }), (error) => ({ ok: false, out: "", err: error.message }));
  if (isIosUdid(u)) return hidResult(iosHid.type(u, text));
  // input text 는 ASCII 만 받는다. 한글을 보내면 기기에서 NullPointerException 으로 끝나 이유를 알 수 없으므로 먼저 거절한다.
  if (/[^\x20-\x7e]/.test(text)) return Promise.resolve({ ok: false, err: "Android 입력은 영문·숫자·기호만 넣을 수 있습니다(adb input text 제약)." });
  // adb shell 은 인자를 기기의 sh 에 한 줄로 넘긴다. 공백은 input 의 %s, 셸 문자는 역슬래시로 막는다.
  const arg = text.replace(/[\\'"\x60$&|;<>()*?!#~\[\]{}^]/g, "\\$&").replace(/ /g, "%s");
  return adb(["-s", u, "shell", "input", "text", arg]);
}
function pressButton(u, button) {
  if (isIosUdid(u)) {
    if (!IOS_BUTTON.has(button)) return Promise.resolve({ ok: false, err: `iOS에는 ${button} 버튼이 없습니다.` });
    return hidResult(iosHid.button(u, button));
  }
  const code = ANDROID_BUTTON[button];
  if (code == null) return Promise.resolve({ ok: false, err: `Android에는 ${button} 버튼이 없습니다(HOME·BACK·LOCK).` });
  return adb(["-s", u, "shell", "input", "keyevent", String(code)]);
}
function pressKeycode(u, keycode) {
  return isIosUdid(u) ? hidResult(iosHid.key(u, keycode))
    : adb(["-s", u, "shell", "input", "keyevent", String(keycode)]);
}
function swipe(u, { x1, y1, x2, y2, duration }) {
  if (isIosUdid(u)) return hidResult(iosHid.swipe(u, { x1, y1, x2, y2, duration }));
  const ms = Math.round((Number(duration) || 0.3) * 1000);
  return adb(["-s", u, "shell", "input", "swipe", ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(ms)]);
}
async function screenshotTo(u, p) {
  if (isIosUdid(u)) return idb(["screenshot", "--udid", u, p]);
  const r = await adb(["-s", u, "exec-out", "screencap", "-p"], { binary: true });
  if (!r.ok || !r.out || !r.out.length) return { ok: false, err: r.err || "빈 화면" };
  let bytes;
  try { bytes = androidScreenshotPng(r.out); }
  catch (error) { return { ok: false, err: error.message }; }
  fs.writeFileSync(p, bytes);
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
export function createAppSurface({ currentSession, call }) {
  sessionOf = currentSession;
  // 표면마다 자기 호출만. 호출 없이 만든 표면이 앞 표면의 실서버 호출을 이어받아 실제 앱·기기에 닿는 것 방지
  serverCall = typeof call === "function" ? call : noServerCall;
  let targetQueue = Promise.resolve();
  const serializeTarget = (run) => (args) => {
    const result = targetQueue.then(() => run(args));
    targetQueue = result.catch(() => {});
    return result;
  };
  const TOOLS = [
  { name: "app_targets", desc: "Iris 에뮬레이터 탭에 열린 기기와 이 세션에 등록된 기본 대상 목록. 등록 기기가 한 대면 device 없는 app_* 명령이 그 기기로 가고, 여러 대면 device를 반드시 적는다.",
    schema: {}, app: true,
    run: async () => {
      const session = await currentSession();
      const r = await irisTabs();
      if (!r.ok) return { ok: false, error: r.error };
      const list = r.tabs;
      const registration = await registeredDeviceState(session);
      if (!registration.ok) return { ok: false, error: registration.error };
      const registered = registration.devices;
      return { ok: true, data: { count: list.length, registered,
        targets: list.map((t) => ({ ...t, registered: registered.some((pin) => resolveAppDeviceTarget(pin, list) === t) })),
        note: !list.length ? "열린 에뮬레이터 탭이 없습니다 — 다른 app_* 도구를 부르면 이 세션의 에뮬레이터를 켭니다. 특정 기기가 필요하면 app_target에 그 기기를 주세요."
          : registered.length > 1 ? "등록 기기가 여러 대입니다 — app_* 도구에 device를 적으세요."
          : !registered.length && list.length > 1 ? "등록 기기가 없습니다 — 지정 없는 명령은 이 세션만의 에뮬레이터를 켜서 씁니다." : undefined } };
    } },
  { name: "app_target", desc: "이 세션의 등록 기기를 한 대로 교체한다. additional은 기존 대상을 유지하며 같은 모델·런타임의 사용하지 않는 기기를 먼저 열고, 없으면 생성해 등록한다(최대 4대). device 없이 조회하고 clear로 모두 해제한다.",
    schema: { device: { type: "string", description: "app_targets가 준 udid·시리얼(앞자리만 적어도 됨) 또는 기기 이름. additional에서는 원본 기기이며, 생략하면 등록·소유 기기가 한 대일 때 그 기기, 없으면 기본 기기를 쓴다." }, clear: { type: "boolean" }, additional: { type: "boolean", description: "같은 모델·런타임 기기를 한 대 더 열고 기존 등록 기기를 유지한다." } }, app: true,
    run: serializeTarget(async (a) => {
      const session = await currentSession();
      if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 기기 등록은 herdr pane 안에서만 됩니다." };
      if (a.additional && a.clear) return { ok: false, error: "additional과 clear는 함께 쓸 수 없습니다." };
      if (a.additional) {
        lastDeviceError = null;
        const registration = await registeredDeviceState(session);
        if (!registration.ok) return { ok: false, error: registration.error };
        const current = await irisTabs();
        if (!current.ok) return { ok: false, error: current.error };
        const retained = [...registration.devices];
        try {
          for (const tab of current.tabs.filter((tab) => tab.own)) {
            const target = appDeviceTargetId(tab);
            if (!await verifyAvdTarget(target, tab.udid)) return { ok: false, error: lastDeviceError };
            if (!retained.includes(target)) retained.push(target);
          }
        } catch (error) { return { ok: false, error: error.message }; }
        if (retained.length >= MAX_DEVICES) return { ok: false, error: `등록·소유 기기는 최대 ${MAX_DEVICES}대입니다. 추가 전에 기기 등록을 해제하고 소유 탭을 닫으세요.` };
        let source = a.device == null ? "" : String(a.device).trim();
        if (!source && retained.length > 1) return { ok: false, error: "원본 기기가 여러 대입니다. additional에 device를 함께 적으세요." };
        if (!source) source = retained[0] || "";
        if (source) {
          const found = await findDevice(source);
          if (lastDeviceError) return { ok: false, error: lastDeviceError };
          if (found) {
            const tab = current.tabs.find((tab) => tab.udid === found);
            try { source = appDeviceTargetId(tab || { udid: found }); }
            catch (error) { return { ok: false, error: error.message }; }
            if (!await verifyAvdTarget(source, found)) return { ok: false, error: lastDeviceError };
          } else if (/^emulator-\d+$/.test(source)) {
            return { ok: false, error: "Android 원본 기기의 AVD 이름을 확인하지 못했습니다. Iris 기기 화면에서 다시 지목하세요." };
          }
        }
        const opened = await serverCall("app-open", { additional: true,
          ...(source ? { device: source.startsWith("avd:") ? source.slice(4) : source } : {}) });
        if (!opened?.ok) return opened || { ok: false, error: "Iris 에뮬레이터 탭을 열지 못했습니다." };
        const after = await irisTabs();
        if (!after.ok) return { ok: false, error: after.error };
        const tab = after.tabs.find((tab) => tab.udid === opened.data?.udid && tab.own);
        if (!tab) return { ok: false, error: "추가한 기기의 세션 소유 탭을 확인하지 못했습니다." };
        let targetId;
        try { targetId = appDeviceTargetId(tab); }
        catch (error) { return { ok: false, error: error.message }; }
        if (!await verifyAvdTarget(targetId, tab.udid)) return { ok: false, error: lastDeviceError };
        if (retained.includes(targetId)) return { ok: false, error: "기존 기기가 응답되어 추가 기기를 등록하지 못했습니다." };
        const registered = [...retained, targetId];
        const saved = await replaceRegisteredDevices(session, registered);
        if (!saved?.ok) return saved || { ok: false, error: "기기 등록을 저장하지 못했습니다." };
        return { ok: true, data: { session, registered, udid: tab.udid, name: tab.name,
          note: registered.length > 1 ? "등록 기기가 여러 대입니다. app_* 도구에 device를 적으세요." : "지정 없는 app_* 명령은 이제 이 기기로 갑니다." } };
      }
      if (a.clear) {
        const saved = await replaceRegisteredDevices(session, []);
        return saved?.ok ? { ok: true, data: { session, registered: [], note: "등록 기기를 모두 지웠습니다." } } : saved;
      }
      if (a.device == null || !String(a.device).trim()) {
        const registration = await registeredDeviceState(session);
        if (!registration.ok) return { ok: false, error: registration.error };
        const registered = registration.devices;
        const r = await irisTabs();
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, data: { session, registered,
          alive: registered.map((udid) => ({ udid, alive: !!resolveAppDeviceTarget(udid, r.tabs) })), targets: r.tabs } };
      }
      // 탭에 없는 기기면 에이전트가 따로 켜지 않고 Iris 가 이 세션의 탭에서 켠다.
      const requested = String(a.device).trim();
      const found = await findDevice(requested);
      if (lastDeviceError) return { ok: false, error: lastDeviceError };
      const u = found || (await openIrisTab(requested.startsWith("avd:") ? requested.slice(4) : requested));
      if (!u) return { ok: false, error: lastOpenError || `그 기기를 열지 못했습니다: ${a.device}.` };
      const current = await irisTabs();
      if (!current.ok) return { ok: false, error: current.error };
      const list = current.tabs;
      const t = list.find((x) => x.udid === u);
      let targetId;
      try { targetId = appDeviceTargetId(t || { udid: u }); }
      catch (error) { return { ok: false, error: error.message }; }
      if (!await verifyAvdTarget(targetId, u)) return { ok: false, error: lastDeviceError };
      const saved = await replaceRegisteredDevices(session, [targetId]);
      if (!saved?.ok) return saved || { ok: false, error: "기기 등록을 저장하지 못했습니다." };
      return { ok: true, data: { session, registered: [targetId], name: t ? t.name : "", note: "지정 없는 app_* 명령은 이제 이 기기로 갑니다." } };
    }) },
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
  { name: "app_key", desc: "하드웨어 버튼 또는 키코드를 누른다. iOS는 HOME·LOCK·SIDE_BUTTON, Android는 HOME·BACK·LOCK(SIDE_BUTTON은 LOCK과 같다). keycode는 iOS면 HID 키코드, Android면 KeyEvent 코드다.",
    schema: { button: { type: "string", enum: ["HOME", "BACK", "LOCK", "SIDE_BUTTON"] }, keycode: { type: "number" } }, app: true,
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
  { name: "app_screenshot", desc: "기기 화면을 PNG로 남긴다. mark로 볼 곳을 지정하면 표시 사이드카도 저장한다. 이 이미지는 QA 근거에 포함되지 않는다.",
    schema: { mark: { type: "array", description: "볼 곳들. {label?, ref?|label 매칭용 name, type?, nth?}",
        items: { type: "object", properties: { ref: { type: "string" }, name: { type: "string" }, type: { type: "string" }, nth: { type: "number" }, label: { type: "string" } } } },
      caption: { type: "string" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      await stopWatch(u);
      const t = a.mark?.length ? await appTree(u) : [];
      const app = t.find((e) => e.type === "Application");
      const marks = [];
      for (const m of (a.mark || [])) {
        const f = appFind(t, { ref: m.ref, label: m.name || m.label, type: m.type, nth: m.nth }, u);
        if (f.hits[0]) marks.push(appMark(f.hits[0].frame, m.label || appName(f.hits[0])));
      }
      const p = await appShot(u, { marks, frame: app && app.frame, caption: a.caption });
      return { ok: true, data: { path: p, marks: marks.length } };
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
      return { ok: true, data: { app: s.app, screen: s.frame, elements: s.count, alerts,
        shot, snapshot: s.text.slice(0, 2000) } };
    } },
  // 화면 비율은 앱 안 device_preview 가 바꾼다. idb·adb 가 아니라 그 기기가 열린 Iris 에뮬레이터 탭을 거쳐야
  // 사람이 탭에서 보는 드롭다운과 같은 값이 된다.
  { name: "app_viewport", desc: "기기에서 실행 중인 Flutter 앱(device_preview 를 켠 디버그 실행)을 다른 기기의 화면 크기·안전 영역·OS 로 보이게 한다. 시뮬레이터는 그대로라 다른 app_* 도구로 계속 조작한다. preset 없이 부르면 고를 수 있는 기기 목록과 현재 값을 준다.",
    schema: { preset: { type: "string", description: "적용할 기기 id(목록의 id). \"real\" 이면 실제 기기 화면으로 되돌린다." } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError(a.device) };
      const preset = a.preset == null ? null : String(a.preset).trim();
      const r = await serverCall("app-viewport", preset ? { device: u, op: "apply", preset: preset === "real" ? "" : preset } : { device: u, op: "list" });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || "화면 비율을 바꾸지 못했습니다." };
      return { ok: true, data: { current: r.data.current || "real", ...(r.data.presets ? { presets: r.data.presets } : {}) } };
    } },
  // 사람이 시뮬레이터·에뮬레이터 화면에서 직접 가리킨 것. 브라우저의 browser_picks에 대응한다.
  // 이쪽은 서버가 Flutter 검사기에서 받아 두므로 idb·adb를 지나지 않는다. 그래서 app: true가 아니다.
  { name: "app_picks", desc: "사용자가 앱 화면에서 직접 고른 요소들(최근 10개). 터미널에 붙은 글은 사람이 읽는 형식이고, 이 도구는 위젯 이름·소스 파일과 줄·상위 위젯 경로 같은 원본 필드를 준다. 고른 것이 무엇이었는지 다시 확인하거나 여러 개를 한꺼번에 다룰 때 쓴다.",
    schema: {}, run: (a, C) => C("app-picks") },
  ];
  // 토스트처럼 잠깐 나타났다 사라지는 알림을 다음 호출에 함께 돌려준다.
  //
  // 조작이 끝나면 9초 동안 접근성 트리를 반복해서 읽는다. 조작 전에 없던 요소가 나타나면 그때 화면을
  // 찍고, 9초 안에 그 요소가 없어지면 알림으로 판단한다. 없어질 때까지 기다리는 이유는
  // 새 화면처럼 계속 남아 있는 요소를 알림으로 잘못 판단하지 않기 위해서다. 요소 네 개 이상이 같이
  // 나타났다 없어지면 화면이 바뀐 것으로 보고 기록하지 않는다.
  const WATCH_MS = 9000, MOMENT_MAX_PARTS = 3;
  const watches = new Map();   // 기기 → { stop, done }
  const delivered = [];        // 다음 앱 도구 결과에 함께 알려 줄 알림
  const keysOf = (tree) => {
    const m = new Map();
    for (const e of tree) {
      if (!appVisible(e) || e.type === "Application" || e.type === "GenericElement") continue;
      const nm = appName(e); if (nm) m.set(e.type + "\u0000" + nm, e);
    }
    return m;
  };
  // 화면의 같은 위치에 같은 종류의 요소가 조작 전에도 있었으면 글자만 바뀐 것이다. 보유 주사위 수가
  // 늘거나 버튼 이름이 바뀌는 경우가 여기에 해당한다. 이름만 비교하면 이런 변화까지 알림으로 잘못
  // 판단한다("주사위 4", "확인").
  const spotOf = (e) => e.type + "\u0000" + ["x", "y", "width", "height"].map((k) => Math.round(e.frame[k])).join(",");
  async function watch(u, before, w) {
    const seen = new Set(keysOf(before).keys());
    const spots = new Set([...keysOf(before).values()].map(spotOf));
    const groups = [];         // 같은 순간에 나타난 요소 묶음
    const t0 = Date.now();
    while (!w.stop && Date.now() - t0 < WATCH_MS) {
      const tree = await appTree(u).catch(() => null);
      if (!tree) break;
      const now = Date.now(), cur = keysOf(tree);
      const fresh = [...cur.keys()].filter((k) => !seen.has(k) && !spots.has(spotOf(cur.get(k))));
      // 위치는 조작 전 화면의 것만 기록해 둔다. 감시 중에 나타난 위치까지 더하면, 같은 위치에 알림이
      // 연달아 나타날 때 두 번째 알림을 글자 변화로 잘못 판단한다. 출석에서 알림이 두 개 나타났는데
      // 하나만 기록됐다.
      cur.forEach((e, k) => seen.add(k));
      if (fresh.length) {
        const app = tree.find((e) => e.type === "Application");
        const parts = fresh.map((k) => cur.get(k));
        const text = parts.map((e) => appName(e)).join("\n");
        const shot = parts.length <= MOMENT_MAX_PARTS ? await appShot(u, {
          marks: parts.map((e) => appMark(e.frame, "잠깐 뜬 알림", "#FFB020")),
          frame: app && app.frame, caption: "잠깐 뜬 알림: " + text }).catch(() => null) : null;
        groups.push({ keys: fresh, text, first: now, last: now, shot, url: appIdent(u, app) });
      }
      for (const g of groups) {
        if (g.gone) continue;
        if (g.keys.some((k) => cur.has(k))) g.last = now;
        else g.gone = now;
      }
    }
    for (const g of groups) {
      const moment = g.gone && g.keys.length <= MOMENT_MAX_PARTS;
      if (!moment) { if (g.shot) { try { fs.unlinkSync(g.shot); fs.rmSync(g.shot + ".marks.json", { force: true }); fs.rmSync(g.shot + ".caption.txt", { force: true }); } catch {} } continue; }
      const lived = g.last - g.first;
      delivered.push({ text: g.text, lived, shot: g.shot,
        note: g.shot ? undefined : "찍지 못했다" });
    }
  }
  function startWatch(u, before) {
    const w = { stop: false };
    w.done = watch(u, before, w).catch(() => {});
    watches.set(u, w);
  }
  async function stopWatch(u) {
    const w = watches.get(u); if (!w) return;
    w.stop = true; watches.delete(u);
    await w.done;
  }
  const APP_ACT = new Set(["app_tap", "app_text", "app_key", "app_swipe"]);
  for (const t of TOOLS) {
    if (!APP_ACT.has(t.name)) continue;
    const inner = t.run;
    t.run = async (a, C) => {
      const dev = await simTarget(a?.device).catch(() => null);
      if (dev) await stopWatch(dev);
      const before = dev ? await appTree(dev).catch(() => null) : null;
      const result = await inner(a, C);
      if (dev && before && result?.ok) startWatch(dev, before);
      return result;
    };
  }
  // 감시는 조작 결과를 돌려준 뒤에도 계속된다. 그 사이에 찾은 알림은 다음 앱 도구의 결과에 함께 넣어
  // 알린다.
  for (const t of TOOLS) {
    if (!t.app) continue;
    const inner = t.run;
    t.run = async (a, C) => {
      const r = await inner(a, C);
      if (delivered.length && r && r.data && typeof r.data === "object") r.data.moments = delivered.splice(0);
      return r;
    };
  }
  return { tools: TOOLS, bootedTargets, simTarget, registeredDevices, MAX_DEVICES };
}
