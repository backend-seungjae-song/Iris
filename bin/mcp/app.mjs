// iOS 시뮬레이터 표면. 사람이 직접 조작하듯 앱을 조종한다.
//
// 소유 범위
//   idb 호출, 켜져 있는 기기 목록과 세션별 기기 고정, 접근성 트리 읽기와 요소 참조(@a1),
//   화면 찍기, 그리고 app_* 도구 전부.
//
// 제공 API
//   createAppSurface(deps) 하나. 도구 배열과 기기 목록 해석을 함께 돌려준다.
//
// 의존 대상
//   idb 실행 파일(IRIS_IDB 로 바꿀 수 있다), state-home.cjs 가 정한 상태 폴더와
//   artifacts-home.cjs 가 정한 그 안의 부산물 위치,
//   그리고 조립부가 넘겨주는 currentSession·journal·addReceipt. MCP 연결 정보는 받지 않는다.
//
// 유지 조건
//   기기를 고정하지 않으면 호출마다 다른 기기가 잡힌다. 고정은 프로세스를 다시 띄워도 남는다.
//   요소 참조는 그 스냅샷 순간에만 유효하다. 앱에는 탭이 없고 도구 인자는 기기다.
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
import { writeMarks } from "./report.mjs";

const IRIS_HOME = stateHome();

// 기기 여럿을 동시에 조작하는 일이 흔하다. 브라우저 쪽은 서버가 나눠 처리하지만
// 앱은 서버를 거치지 않으므로 상한을 여기서 함께 둔다.
export const MAX_DEVICES = 4;

// ── iOS 시뮬레이터 ──
// 브라우저와 같은 방식을 앱에도 쓴다. idb가 접근성 트리를 주므로
// 요소를 이름으로 찾아 값을 읽을 수 있고, 그러면 판정이 인상이 아니라 사실이 된다.
// 앱은 서버(4271)를 거치지 않는다. Iris 앱이 꺼져 있어도 동작한다.
const IDB = process.env.IRIS_IDB || path.join(os.homedir(), ".local", "bin", "idb");
function idb(args, opts = {}) {
  return new Promise((resolve) => {
    const cp = childProcess.execFile(IDB, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 90000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String((stderr || "") + (err ? String(err.message || err) : "")) }));
    if (opts.stdin != null) { cp.stdin.write(opts.stdin); cp.stdin.end(); }
  });
}
let simUdid = process.env.IRIS_SIM_UDID || null;
// 켜져 있는 시뮬레이터 전부. udid가 이미 그 기기만의 값이라 따로 이름을 지어 붙일 것이 없다.
async function bootedTargets() {
  const r = await idb(["list-targets"]);
  return r.out.split("\n").filter((l) => /\|\s*Booted\s*\|/.test(l)).map((l) => {
    const c = l.split("|").map((x) => x.trim());
    return { name: c[0] || "", udid: c[1] || "" };
  }).filter((t) => t.udid);
}
// 이 세션이 고정한 기기. 파일에 남겨 프로세스를 다시 띄워도 같은 기기를 계속 쓴다.
// 고정이 없으면 "지금 켜져 있는 것 중 첫 번째"인데, 그 순서는 idb가 정하는 것이라 기기를 여럿
// 켜 두면 호출마다 다른 기기가 잡힌다.
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
// 왜 대상이 없는지는 상황마다 다르다. "없다"고만 말하면 고정해 둔 기기가 꺼진 것인지,
// 아무것도 안 켜져 있는 것인지 알 수 없어 사람이 엉뚱한 데를 본다.
async function simTargetError() {
  const pin = pinnedDevice(await sessionOf());
  const list = await bootedTargets();
  if (pin && !list.some((t) => t.udid === pin)) {
    return list.length
      ? `고정해 둔 기기(${pin})가 꺼져 있습니다. 그 기기를 켜거나, app_target으로 다른 기기를 고정하세요(지금 켜진 기기 ${list.length}대).`
      : `고정해 둔 기기(${pin})가 꺼져 있고 켜진 기기도 없습니다. Simulator를 실행하세요.`;
  }
  return "켜진 시뮬레이터가 없습니다. Simulator를 실행하세요.";
}
// 적어준 값(udid 전체·앞자리·기기 이름) 하나를 실제 udid로. 켜져 있지 않으면 null.
async function findDevice(want) {
  const w = String(want || "").trim(); if (!w) return null;
  const list = await bootedTargets();
  const hit = list.find((t) => t.udid === w) || list.find((t) => t.name === w)
    || list.find((t) => t.udid.toLowerCase().startsWith(w.toLowerCase()));
  return hit ? hit.udid : null;
}
// want를 주면 그 기기. 없으면 이 세션이 고정한 기기, 그것도 없으면 첫 번째를 골라 고정한다.
async function simTarget(want) {
  if (want != null && String(want).trim()) return findDevice(want);
  const pin = pinnedDevice(await sessionOf());
  if (pin) {
    const list = await bootedTargets();
    if (list.some((t) => t.udid === pin)) return pin;   // 아직 켜져 있으면 그것만 쓴다
    // 고정한 기기가 꺼졌다. 조용히 다른 기기로 갈아타지 않는다. 사용자가 모르는 사이에 대상이 바뀌는 동작을 막는다.
    return null;
  }
  if (simUdid) return simUdid;
  const list = await bootedTargets();
  simUdid = list.length ? list[0].udid : null;
  return simUdid;
}
// 스냅샷이 준 참조(@a1…)는 그 스냅샷 순간에만 유효하다. 화면이 바뀌면 다시 뜬다.
// 참조(@a1…)는 기기마다 따로 둔다. 표 하나를 공유하면 기기를 여럿 켜 두고 동시에
// 스냅샷을 뜰 때 나중 스냅샷이 앞 것을 덮어써 @a3 이 다른 기기의 요소를 가리킨다.
const appRefsByDevice = new Map();   // udid → Map(ref → element)
const refsOf = (udid) => { let m = appRefsByDevice.get(udid); if (!m) { m = new Map(); appRefsByDevice.set(udid, m); } return m; };
const appVisible = (e) => e && e.frame && e.frame.width > 0 && e.frame.height > 0;
const appName = (e) => String(e.AXLabel || e.title || e.AXValue || "").trim();
async function appTree(udid) {
  const r = await idb(["ui", "describe-all", "--udid", udid]);
  if (!r.ok) throw new Error("접근성 트리를 읽지 못했습니다 — 시뮬레이터가 켜져 있는지 확인하세요. " + r.err.slice(0, 200));
  let t; try { t = JSON.parse(r.out); } catch { throw new Error("접근성 트리를 해석하지 못했습니다."); }
  return Array.isArray(t) ? t : [];
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
const appCenter = (e) => ({ x: Math.round(e.frame.x + e.frame.width / 2), y: Math.round(e.frame.y + e.frame.height / 2) });
// 표시는 이미지를 고치지 않고 옆 파일에 남긴다. 앱 스크린샷에는 그릴 도구가 없고, 보고서에서
// 겹쳐 그리면 확대해도 안 깨진다. 좌표는 0~1 비율이라 해상도가 달라도 그대로 맞는다.
async function appShot(udid, { marks, frame, caption } = {}) {
  const dir = artifactDir("shots", IRIS_HOME);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "app-" + Date.now() + ".png");
  const r = await idb(["screenshot", "--udid", udid, p]);
  if (!r.ok || !fs.existsSync(p)) throw new Error("스크린샷 실패: " + r.err.slice(0, 200));
  writeMarks(p, marks, frame);
  if (caption) { try { fs.writeFileSync(String(p) + ".caption.txt", String(caption)); } catch {} }
  return p;
}


// 앱 증거의 "어디서"에 해당하는 값. 브라우저의 url 에 대응하며 기기와 그때 떠 있던 앱을 잇는다.
function appIdent(udid, app) {
  const name = app ? appName(app) : "";
  return "app://" + String(udid || "").slice(0, 8) + (name ? "/" + name : "");
}
export function createAppSurface({ currentSession, journal, addReceipt }) {
  sessionOf = currentSession;
  const TOOLS = [
  { name: "app_targets", desc: "켜져 있는 시뮬레이터 목록 — 기기 이름과 udid. 여러 대를 동시에 조작하려면 여기서 얻은 값을 device에 넣는다(최대 4).",
    schema: {}, app: true,
    run: async () => {
      const session = await currentSession();
      const list = await bootedTargets();
      const pin = pinnedDevice(session);
      return { ok: true, data: { count: list.length, pinned: pin,
        targets: list.map((t) => ({ ...t, pinned: t.udid === pin })),
        note: !pin && list.length > 1 ? "기기가 여럿입니다 — app_target으로 하나를 고정하면 지정 없는 명령이 그 기기로만 갑니다." : undefined } };
    } },
  { name: "app_target", desc: "이 세션이 쓸 시뮬레이터를 고정한다. 고정하면 지정 없는 app_* 명령이 항상 그 기기로 간다 — 기기를 여럿 켜 두었을 때 호출마다 다른 기기가 잡히는 것을 막는다. device 없이 부르면 조회, clear로 해제. 고정은 프로세스가 다시 떠도 유지된다.",
    schema: { device: { type: "string", description: "app_targets가 준 udid(앞자리만 적어도 됨) 또는 기기 이름" }, clear: { type: "boolean" } }, app: true,
    run: async (a) => {
      const session = await currentSession();
      if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 고정은 herdr pane 안에서만 됩니다." };
      if (a.clear) { setPinnedDevice(session, null); return { ok: true, data: { session, pinned: null, note: "고정을 놓았습니다 — 이제 켜져 있는 첫 기기를 씁니다." } }; }
      if (a.device == null || !String(a.device).trim()) {
        const pin = pinnedDevice(session);
        const list = await bootedTargets();
        return { ok: true, data: { session, pinned: pin,
          alive: pin ? list.some((t) => t.udid === pin) : null, targets: list } };
      }
      const u = await findDevice(a.device);
      if (!u) return { ok: false, error: `그런 기기가 켜져 있지 않습니다: ${a.device}. app_targets로 확인하세요.` };
      setPinnedDevice(session, u);
      const list = await bootedTargets();
      const t = list.find((x) => x.udid === u);
      return { ok: true, data: { session, pinned: u, name: t ? t.name : "", note: "지정 없는 app_* 명령은 이제 이 기기로만 갑니다." } };
    } },
  { name: "app_snapshot", desc: "지금 시뮬레이터 화면에 무엇이 있는지 — 요소 참조(@a1…)·유형·이름·값. 무엇을 만질지 모를 때 먼저 쓴다. 참조는 이 스냅샷 순간에만 유효하다.",
    schema: {}, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      const t = await appTree(u); const s = appSnapshotText(t, u);
      return { ok: true, data: { app: s.app, count: s.count, screen: s.frame, snapshot: s.text } };
    } },
  { name: "app_tap", desc: "요소를 누른다. ref(@a3) 또는 label로 지정하고, 같은 이름이 여럿이면 type·nth로 좁힌다. 좌표(x,y)로도 누를 수 있다.",
    schema: { ref: { type: "string" }, label: { type: "string", description: "화면에 보이는 이름" },
      type: { type: "string", description: "Button·StaticText·Image 등" }, nth: { type: "number", description: "같은 것이 여럿일 때 몇 번째(1부터)" },
      x: { type: "number" }, y: { type: "number" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      let x = a.x, y = a.y, name = "";
      if (x == null || y == null) {
        const t = await appTree(u); const f = appFind(t, a, u);
        if (!f.hits.length) return { ok: false, error: f.why };
        if (f.hits.length > 1) return { ok: false, error: `"${a.label}"에 ${f.hits.length}개가 걸립니다 — type이나 nth로 좁히세요.`, data: { hits: f.hits.map((e) => ({ type: e.type, name: appName(e), frame: e.frame })) } };
        const c = appCenter(f.hits[0]); x = c.x; y = c.y; name = appName(f.hits[0]);
      }
      const r = await idb(["ui", "tap", "--udid", u, String(x), String(y)]);
      return r.ok ? { ok: true, data: { tapped: name || `(${x}, ${y})`, x, y } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_text", desc: "지금 포커스된 입력칸에 글자를 넣는다. 먼저 그 칸을 app_tap으로 눌러 포커스를 준다.",
    schema: { text: { type: "string" } }, req: ["text"], app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      const r = await idb(["ui", "text", "--udid", u, String(a.text)]);
      return r.ok ? { ok: true, data: { typed: String(a.text).length + "자" } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_key", desc: "하드웨어 버튼(HOME·LOCK·SIRI·APPLE_PAY) 또는 키코드를 누른다.",
    schema: { button: { type: "string", enum: ["HOME", "LOCK", "SIDE_BUTTON", "SIRI", "APPLE_PAY"] }, keycode: { type: "number" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      const r = a.keycode != null ? await idb(["ui", "key", "--udid", u, String(a.keycode)])
        : await idb(["ui", "button", "--udid", u, String(a.button || "HOME")]);
      return r.ok ? { ok: true, data: { pressed: a.keycode != null ? "키 " + a.keycode : a.button || "HOME" } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_swipe", desc: "한 점에서 다른 점으로 쓸어넘긴다(스크롤·페이지 전환).",
    schema: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
      duration: { type: "number", description: "초. 기본 0.3" } }, req: ["x1", "y1", "x2", "y2"], app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      const args = ["ui", "swipe", "--udid", u, String(a.x1), String(a.y1), String(a.x2), String(a.y2)];
      if (a.duration) args.push("--duration", String(a.duration));
      const r = await idb(args);
      return r.ok ? { ok: true, data: { swiped: `(${a.x1},${a.y1}) → (${a.x2},${a.y2})` } } : { ok: false, error: r.err.slice(0, 200) };
    } },
  { name: "app_screenshot", desc: "시뮬레이터 화면을 PNG로 남긴다. mark로 볼 곳을 지정하면 보고서에서 그 자리에 상자와 설명이 겹쳐 그려진다(원본은 안 상한다). caption은 이 장면이 무엇을 증명하는지 한 줄.",
    schema: { mark: { type: "array", description: "볼 곳들. {label?, ref?|label 매칭용 name, type?, nth?}",
        items: { type: "object", properties: { ref: { type: "string" }, name: { type: "string" }, type: { type: "string" }, nth: { type: "number" }, label: { type: "string" } } } },
      caption: { type: "string" } }, app: true,
    run: async (a) => {
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
      const t = await appTree(u);
      const app = t.find((e) => e.type === "Application");
      const marks = [];
      for (const m of (a.mark || [])) {
        const f = appFind(t, { ref: m.ref, label: m.name || m.label, type: m.type, nth: m.nth }, u);
        if (f.hits[0]) marks.push({ ...f.hits[0].frame, label: m.label || appName(f.hits[0]) });
      }
      const p = await appShot(u, { marks, frame: app && app.frame, caption: a.caption });
      // 앱은 idb를 직접 부르므로 서버를 지나지 않는다. 장면도 회차 장부에 직접 제출해야
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
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
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
        marks: hit ? [{ ...hit.frame, label: desc, color: pass ? "#8BFBC2" : "#FF7A72" }] : [],
        frame: app && app.frame, caption: `${pass ? "됨" : "안 됨"} · ${desc}${hit ? "" : " (요소 없음)"}`,
      }).catch(() => null);
      // 앱은 idb를 직접 부르므로 서버를 지나지 않는다. 그래서 판정을 회차 장부에 직접 제출한다.
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
      const u = await simTarget(a.device); if (!u) return { ok: false, error: await simTargetError() };
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
  // 이쪽은 서버가 Flutter 검사기에서 받아 두므로 idb를 지나지 않는다. 그래서 app: true가 아니다.
  { name: "app_picks", desc: "사용자가 앱 화면에서 직접 고른 요소들(최근 10개). 터미널에 붙은 글은 사람이 읽는 형식이고, 이 도구는 위젯 이름·소스 파일과 줄·상위 위젯 경로 같은 원본 필드를 준다. 고른 것이 무엇이었는지 다시 확인하거나 여러 개를 한꺼번에 다룰 때 쓴다.",
    schema: {}, run: (a, C) => C("app-picks") },
  ];
  // 앱 조작을 장부에 남긴다. 브라우저는 조작마다 accepted·completed 짝과 전후 프레임이 서버에서
  // 자동으로 남지만(server/browser-commands.js), 앱은 idb를 직접 부르므로 그 경로를 지나지 않는다.
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
