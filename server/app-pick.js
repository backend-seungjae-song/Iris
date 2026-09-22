// 앱 요소 선택. 시뮬레이터·에뮬레이터에서 사용자가 가리킨 요소를 이 세션으로 가져온다.
//
// 브라우저에서는 페이지에 스크립트를 주입해 클릭을 가로챈다. 앱 화면에는 주입할 수 없다.
// 대신 Flutter가 같은 기능을 제공한다. 위젯 선택 모드(ext.flutter.inspector.show)를 켜면
// 화면을 탭해도 앱이 반응하지 않고 그 위치의 위젯이 선택되므로, 그 선택 결과를 읽기만 하면
// 된다. 이 방식은 실제 시뮬레이터 창을 그대로 쓰고 화면을 가리지 않는다.
//
// 확인 결과(iOS 시뮬레이터):
//  - 선택 모드를 켜고 (153,496)을 탭 → RichText 위젯이 선택됐고 앱은 그 탭에 반응하지 않았다.
//    소스 위치와 상위 위젯 체인까지 함께 반환됐다.
//  - 선택은 프로젝트가 만든 위젯까지 거슬러 올라온다(Flutter가 그렇게 돌려준다). 프레임워크 내부를
//    지정해도 사용자 코드가 나온다. 사용자 코드를 지정하는 것이 목적이므로 이 동작이 맞다.
//  - 소스 위치는 디버그 실행(--track-widget-creation)에서만 나온다. flutter run이 기본으로 켠다.
//
// 다만 그 선택은 z축을 고려하지 않는다. 인스펙터의 히트테스트는 자식을 기하로만 탐색해 그 점을 포함하는
// 렌더 객체를 전부 모은 뒤 넓이 오름차순으로 정렬한다(SDK widget_inspector.dart의 _hitTestHelper와
// hitTest). 그래서 모달이 떠 있어도 그 뒤의 더 작은 위젯이 모달 안의 큰 위젯보다 먼저 선택된다
// (확인 결과: 바텀시트를 띄운 채 시트 안을 눌렀을 때 뒤의 목록 카드가 선택됐다).
// 사용자가 보는 것은 최상위 레이어이므로 그 밖의 요소는 후보가 아니어야 한다.
//
// 그래서 선택한 뒤 한 번 더 거른다. 수집된 후보는 앱 안 InspectorSelection.candidates에 그대로
// 남아 있으므로, VM 서비스의 식 평가로 앱 안에서 다시 추린다(TOP_LAYER_EXPR): 가장 나중에 그려진
// ModalBarrier의 subtree가 끝나는 지점을 경계로 삼고, 그보다 나중에 그려진 후보만 남긴다. 남은 것
// 중에서는 Flutter가 매긴 순서를 그대로 쓴다. 모달이 없을 때의 결과를 바꾸지 않기 위해서다.
// ModalRoute는 배리어를 먼저 얹고 화면을 나중에 얹으므로(createOverlayEntries), 이 경계는 모달만이
// 아니라 현재 라우트 기준으로도 맞다. 선택 자체를 앱 안에서 옮기므로 화면 하이라이트도 함께 이동한다.
// 한 번 탭이 미리보기이므로, 서버에서만 걸러내면 사용자는 뒤의 요소가 선택된 화면을 보게 된다.
//
// 앱을 찾는 경로는 둘이고, 한쪽이 실패해도 나머지로 연결한다:
//  1) mDNS: Dart VM 서비스가 _dartVmService._tcp로 자신을 광고한다. 이름·포트·인증코드가 모두 나온다
//     (확인 결과: com.example.shop → 62393 · authCode=AAAAAAAAAA0=).
//  2) 터미널 화면: flutter run이 접속 주소를 출력한다. herdr pane 내용에서 그 주소를 읽는다.
//     안드로이드 에뮬레이터는 adb 포워딩을 거쳐서 mDNS에 잡히지 않을 수 있고, 그때 이 경로를 쓴다.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

// dns-sd는 종료되지 않는 명령이라 잠시 실행해 결과를 모으고 종료한다. 이 시간이 모드를 켠 뒤 탭할 수
// 있을 때까지의 지연이다. 그 전에 탭하면 선택이 아니라 앱이 반응하므로 짧아야 한다. 놓쳐도 15초마다
// 다시 찾으므로 한 번의 실패는 자동으로 회복된다.
const DNSSD_MS = 1500;
const POLL_MS = 400;            // 탭한 뒤 결과가 표시되기까지의 지연. 호출은 로컬이라 비용이 낮다
const REDISCOVER_MS = 15000;    // 핫 리스타트하면 포트가 바뀌므로 켜져 있는 동안 계속 다시 찾는다
const CALL_TIMEOUT_MS = 6000;
const SAME_TAP_MS = 60;         // 한 번의 탭이 내는 두 신호(확인 결과 0ms 차)를 하나로 본다
const DOUBLE_TAP_MS = 600;      // 두 탭이 이 안에 오면 전달로 판단한다(확인 결과 두 번 탭 313ms 차)

// 값을 담고 있는 속성 이름. 레이아웃 속성(textAlign·textDirection 같은 것)은 이름이 비슷해도 값이
// 아니므로 정확히 일치하는 것만 본다. 확인 결과 textDirection·textBaseline이 대량으로 섞여 들어왔다.
const VALUE_PROP_RE = /^(data|text|value|controller|hintText|labelText|helperText|errorText|initialValue|groupValue|selected|checked|isSelected|semanticsLabel|tooltip|message|placeholder|count)$/;
// Flutter의 속성 설명은 값을 따옴표로 감싸서 반환하므로("\"영화\"") 표시할 때 따옴표를 제거한다.
function unquote(s) {
  const t = s.trim();
  return (t.length > 1 && t[0] === '"' && t[t.length - 1] === '"') ? t.slice(1, -1) : t;
}
// 값으로 읽을 내용이 남아 있는지 확인한다. 공백·폭 없는 문자와 아이콘 문자는 값이 아니다.
// 아이콘은 폰트의 사설 영역(U+E000~U+F8FF)에 그려져 텍스트로는 ""로 보이고, 그런 항목이
// 목록에 섞여 나온다(확인 결과: 화살표 아이콘이 U+F63B로 왔다).
function hasVisible(s) {
  return /[^\s​-‏﻿-]/.test(String(s || ""));
}

const VM_URI_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/([A-Za-z0-9_+=-]+)\//;

// 식은 이 라이브러리 스코프에서 컴파일한다. 앱 코드(main.dart)는 material만 import해서 RenderObject·
// RendererBinding이 안 보이지만, 이 파일은 rendering·binding을 import하고 WidgetInspectorService와
// DebugCreator를 직접 선언하므로 필요한 심볼이 모두 이 스코프에 있다.
const INSPECTOR_LIB = "package:flutter/src/widgets/widget_inspector.dart";

// 선택을 최상위 레이어로 올리는 식. 줄바꿈이 하나라도 있으면 컴파일되지 않으므로(확인 결과:
// synthetic_debug_expression:1:5 "Can't find '}' to match '{'") 한 줄로 붙여 보낸다.
// 반환 값은 `상태|가려진후보수`다. 상태는 none(후보 없음) · nolayer(배리어 없는 앱, 변경하지
// 않음) · behind(모달 바깥을 눌러 남는 후보가 없음) · same(이미 최상위) · moved(이동함).
// 가려진 후보 수를 함께 세는 이유는 픽에 담아 보내기 위해서다. 뒤의 요소가 선택되면 픽 내용만
// 보고도 가린 레이어를 거르지 못한 것인지 가린 레이어가 없었던 것인지 구분할 수 있다.
const TOP_LAYER_EXPR = [
  "(() {",
  "final s = WidgetInspectorService.instance.selection;",
  "final cands = s.candidates;",
  "if (cands.isEmpty) return 'none|0';",
  "final bars = <RenderObject>{};",
  "void we(Element e) { if (e.widget.runtimeType.toString().contains('ModalBarrier')) { final ro = e.findRenderObject(); if (ro != null) bars.add(ro); } e.visitChildren(we); }",
  "final root = WidgetsBinding.instance.rootElement;",
  "if (root != null) we(root);",
  "if (bars.isEmpty) return 'nolayer|0';",
  "final want = <RenderObject>{}; want.addAll(cands);",
  "final idx = <RenderObject, int>{}; var cut = -1; var i = 0;",
  "void walk(RenderObject o) { if (want.contains(o)) idx[o] = i; i = i + 1; o.visitChildren(walk); if (bars.contains(o) && i - 1 > cut) cut = i - 1; }",
  "for (final v in RendererBinding.instance.renderViews) { walk(v); }",
  "RenderObject? pick; var hidden = 0;",
  "for (final c in cands) { final k = idx[c]; if (k == null) continue; if (k <= cut) { hidden = hidden + 1; continue; } if (pick == null && c.debugCreator is DebugCreator) pick = c; }",
  "if (pick == null) return 'behind|' + hidden.toString();",
  "if (identical(pick, s.current)) return 'same|' + hidden.toString();",
  "s.current = pick;",
  "return 'moved|' + hidden.toString();",
  "})()",
].join(" ");

function run(cmd, args, ms = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 4 << 20 }, (err, out) => resolve(err && !out ? "" : String(out || "")));
  });
}

// 정해진 시간만 듣고 끄는 dns-sd. 출력이 스트리밍이라 이 방식 말고는 끝을 알 수 없다.
function dnssd(args, ms = DNSSD_MS) {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn("dns-sd", args, { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return resolve(""); }
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(out));
    const t = setTimeout(() => { try { p.kill("SIGTERM"); } catch {} resolve(out); }, ms);
    p.on("close", () => { clearTimeout(t); resolve(out); });
  });
}

async function discoverMdns() {
  const browse = await dnssd(["-B", "_dartVmService._tcp", "local."]);
  const names = new Set();
  for (const line of browse.split("\n")) {
    const m = /_dartVmService\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (m && m[1] && !/Instance Name/.test(line)) names.add(m[1].trim());
  }
  const found = [];
  for (const name of names) {
    const res = await dnssd(["-L", name, "_dartVmService._tcp", "local."], 1200);
    const port = /:(\d+)\s+\(interface/.exec(res);
    const code = /authCode=(\S+)/.exec(res);
    if (port && code) found.push({ port: Number(port[1]), token: code[1], label: name.replace(/\s*\(\d+\)$/, "") });
  }
  return found;
}

// 안드로이드 에뮬레이터. mDNS에는 잡히지 않고(확인 결과: iOS 앱만 보였다) 접속 주소는 flutter run을 실행한
// 터미널에만 있다. 스크립트로 실행해 로그 파일로 보냈다면 그것도 없으므로 기기에서 직접 읽는다.
//  1) logcat에 엔진이 찍는다: "The Dart VM service is listening on http://127.0.0.1:<기기포트>/<토큰>/"
//  2) adb forward --list가 그 기기 포트를 받는 host 포트를 준다(확인 결과: tcp:62556 → tcp:41047).
//  3) 그 주소로 열면 302가 오고 location이 진짜 접속 지점(DDS)을 가리킨다. flutter run이 터미널에
//     출력하는 값과 같다(확인 결과: 62560/bQssj14LaP8=). DDS가 없으면 302가 없고 그 주소가 접속점이다.
// 서버는 launchd가 실행하므로 사용자 셸의 PATH가 아니다(확인 결과: adb를 찾지 못했다). 흔한 경로를 직접 확인한다.
let adbPathCache;
function adbPath() {
  if (adbPathCache !== undefined) return adbPathCache;
  const home = process.env.HOME || "";
  const cands = [
    process.env.IRIS_ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
    "/usr/local/share/android-commandlinetools/platform-tools/adb",
    "/opt/homebrew/bin/adb",
  ].filter(Boolean);
  adbPathCache = cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  return adbPathCache;
}

async function discoverAdb() {
  const adb = adbPath();
  if (!adb) return [];
  const list = await run(adb, ["devices"], 3000);
  const serials = list.split("\n").slice(1).map((l) => l.split("\t"))
    .filter((p) => p[1] && p[1].trim() === "device").map((p) => p[0].trim());
  if (!serials.length) return [];
  const found = [];
  for (const serial of serials) {
    const fwd = await run(adb, ["-s", serial, "forward", "--list"], 3000);
    const hostOf = new Map();
    for (const line of fwd.split("\n")) {
      const m = /tcp:(\d+)\s+tcp:(\d+)/.exec(line);
      if (m) hostOf.set(Number(m[2]), Number(m[1]));
    }
    const log = await run(adb, ["-s", serial, "logcat", "-d", "-s", "flutter:I"], 6000);
    let last = null;
    for (const line of log.split("\n")) { const m = VM_URI_RE.exec(line); if (m) last = m; }
    if (!last) continue;
    const host = hostOf.get(Number(last[1]));
    if (!host) continue;
    found.push(await resolveRedirect(host, last[2]));
  }
  return found.filter(Boolean);
}

// 302면 그 응답이 아니라 location 이 가리키는 곳이 접속 지점이다.
async function resolveRedirect(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${token}/ws`, { redirect: "manual", signal: AbortSignal.timeout(2500) });
    const loc = res.headers.get("location");
    const m = loc && VM_URI_RE.exec(loc);
    if (m) return { port: Number(m[1]), token: m[2], label: null };
  } catch {}
  return { port, token, label: null };
}

// herdr pane 내용에서 접속 주소를 읽는다. flutter run이 출력한 줄이다.
async function discoverFromPanes(herdr) {
  if (!herdr) return [];
  const found = [];
  try {
    const agents = await herdr.agentList();
    const panes = [...new Set(agents.map((a) => a.pane_id).filter(Boolean))];
    for (const p of panes) {
      let text = "";
      try { const r = await herdr.paneRead(p, "recent", "text", true, 300); text = String(r?.text || r || ""); } catch { continue; }
      // 한 pane에 여러 번 출력됐으면 마지막 값이 현재 유효한 주소다.
      let last = null;
      for (const line of text.split("\n")) { const m = VM_URI_RE.exec(line); if (m) last = m; }
      if (last) found.push({ port: Number(last[1]), token: last[2], label: null });
    }
  } catch {}
  return found;
}

// 실행 중인 앱 하나. 소켓 하나를 유지하며 JSON-RPC로 통신한다.
class Target {
  constructor(port, token, label) {
    this.port = port; this.token = token; this.label = label || null;
    this.ws = null; this.isolateId = null; this.seq = 0; this.waiting = new Map();
    this.lastKey = null;    // 직전에 전달한 선택. 같은 것을 다시 보내지 않는다
    this.dead = false;
    this.libId = undefined; // 아직 찾지 않음(null은 없다는 결론)
    this.liftOff = false;   // 최상위 레이어로 올리기를 중단했는지 여부
  }
  get key() { return `${this.port}/${this.token}`; }
  get uri() { return `ws://127.0.0.1:${this.port}/${this.token}/ws`; }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.uri); } catch (e) { return reject(e); }
      this.ws = ws;
      const fail = (e) => { this.dead = true; reject(e instanceof Error ? e : new Error(String(e))); };
      ws.on("message", (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.method === "streamNotify") { this._onStream(m.params); return; }
        const w = m.id != null ? this.waiting.get(String(m.id)) : null;
        if (!w) return;
        this.waiting.delete(String(m.id));
        if (m.error) w.reject(new Error(m.error.message || "vm error"));
        else w.resolve(m.result);
      });
      ws.on("error", fail);
      ws.on("close", () => { this.dead = true; for (const w of this.waiting.values()) w.reject(new Error("closed")); this.waiting.clear(); });
      ws.on("open", async () => {
        try {
          const vm = await this.call("getVM");
          const iso = (vm.isolates || []).find((i) => i.name === "main") || (vm.isolates || [])[0];
          if (!iso) throw new Error("isolate 없음");
          this.isolateId = iso.id;
          // 이름은 패키지명이 가장 알아보기 쉽다(pubspec의 그 이름). mDNS로 온 번들 id나 vm.name("vm")은
          // 사용자가 자기 앱으로 알아보기 어렵다. 안드로이드는 vm.name만 온다.
          try {
            const info = await this.call("getIsolate", { isolateId: iso.id });
            const m = /^package:([^/]+)\//.exec(String(info?.rootLib?.uri || ""));
            if (m) this.label = m[1];
          } catch {}
          if (!this.label) this.label = String(vm.name || "앱");
          resolve(this);
        } catch (e) { fail(e); }
      });
      setTimeout(() => { if (!this.isolateId) fail(new Error("연결 시간 초과")); }, CALL_TIMEOUT_MS);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("연결 없음"));
      const id = String(++this.seq);
      this.waiting.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { this.waiting.delete(id); return reject(e); }
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error("시간 초과: " + method)); }, CALL_TIMEOUT_MS);
    });
  }

  // 위젯 선택 모드. 켜면 탭이 앱으로 가지 않고 선택이 된다.
  async setSelect(on) {
    await this.call("ext.flutter.inspector.show", { isolateId: this.isolateId, enabled: on ? "true" : "false" });
  }

  // 전달 시점. 한 번 탭은 무엇이 선택되는지 확인하는 동작이고, 두 번 탭이 전달이다
  // (미리보기 없이 한 번에 전달되면 오히려 불편하다). 한 번 탭해도 앱 화면에는
  // Flutter가 그 위젯을 하이라이트하므로, 그것이 곧 미리보기다.
  //
  // Flutter는 손을 뗄 때 확정 신호를 보낸다(_notifyToolsOfSelection → ToolEvent의 navigate,
  // developer.inspect → Debug의 Inspect). 확인 결과: 한 번 탭이면 두 신호가 같은 밀리초에
  // 오고, 두 번 탭이면 두 그룹이 313ms 간격으로 왔다. 그래서 60ms 이내는 같은 탭으로 합치고,
  // 합쳐진 것 둘이 600ms 안에 오면 더블 탭으로 본다.
  async listenEvents() {
    let ok = false;
    for (const streamId of ["ToolEvent", "Debug"]) {
      // 이미 구독돼 있다는 오류는 성공과 같다. 이벤트는 그대로 수신된다.
      try { await this.call("streamListen", { streamId }); ok = true; }
      catch (e) { if (/already/i.test(String(e && e.message))) ok = true; }
    }
    this.streamOk = ok;
  }
  _onStream(p) {
    const ev = p && p.event;
    if (!ev) return;
    const isCommit = (p.streamId === "ToolEvent" && ev.extensionKind === "navigate"
        && ev.extensionData && ev.extensionData.source === "flutter.inspector")
      || (p.streamId === "Debug" && ev.kind === "Inspect");
    if (!isCommit) return;
    const now = Date.now();
    if (now - (this.lastSignalAt || 0) < SAME_TAP_MS) return;   // 같은 탭이 낸 둘째 신호
    this.lastSignalAt = now;
    if (now - (this.firstTapAt || 0) <= DOUBLE_TAP_MS) {
      this.firstTapAt = 0;                                      // 세 번째 탭이 곧바로 또 보내지 않게
      if (this.onCommit) this.onCommit(this);
    } else {
      this.firstTapAt = now;                                    // 첫 탭은 확인용이므로 전달하지 않는다
      this.lift().catch(() => {});                              // 하이라이트는 최상위 레이어로 옮긴다
    }
  }

  // 지금 선택된 위젯. 없으면 null. 요약 트리 기준이라 프로젝트가 만든 위젯으로 올라온 값이 온다.
  async selection() {
    const r = await this.call("ext.flutter.inspector.getSelectedSummaryWidget", { isolateId: this.isolateId, objectGroup: "ac-pick" });
    return r && r.result ? r.result : null;
  }

  // 식을 컴파일할 스코프. 앱이 실행되는 동안 바뀌지 않으므로 한 번 찾아 캐시한다.
  async inspectorLib() {
    if (this.libId !== undefined) return this.libId;
    this.libId = null;
    try {
      const iso = await this.call("getIsolate", { isolateId: this.isolateId });
      const lib = (iso.libraries || []).find((l) => l.uri === INSPECTOR_LIB);
      if (lib) this.libId = lib.id;
    } catch {}
    return this.libId;
  }

  // 선택을 최상위 레이어로 올린다. 앱 안에서 후보를 다시 거르므로 화면 하이라이트도 함께 이동한다.
  // 확인 결과(iOS 시뮬레이터): 요소 5969개 + 렌더 2683개를 탐색해 warm 16~28ms
  // (첫 회 86~219ms는 식 컴파일 포함). 탭 한 번에 한 번이면 비용이 충분히 낮다.
  async lift() {
    if (this.liftOff) return null;
    const libId = await this.inspectorLib();
    if (!libId) { this.liftOff = true; return null; }
    let r;
    try {
      r = await this.call("evaluate", { isolateId: this.isolateId, targetId: libId, expression: TOP_LAYER_EXPR });
    } catch {
      // 식을 컴파일하지 못하는 실행 방식이 있다(flutter run으로 실행하지 않은 경우 등).
      // 그때는 한 번만 알리고 다시 시도하지 않는다. 탭마다 같은 실패를 반복할 이유가 없다.
      this.liftOff = true;
      deps.onNote(`${this.label} — 맨 위 층만 고르기가 이 실행에서는 안 됩니다. 모달 뒤가 잡힐 수 있습니다.`);
      return null;
    }
    // 식이 앱 안에서 예외를 던지면 값 대신 오류가 오고, 그때는 Flutter가 고른 선택을 그대로 쓴다.
    return r && r.valueAsString != null ? String(r.valueAsString) : null;
  }

  // 현재 화면의 요약 트리. 프로젝트가 만든 위젯만, 생성 위치와 텍스트 미리보기를 포함해 반환된다.
  // 화면 스택·값·주변을 모두 이 응답 하나에서 추출한다.
  //
  // 상세 트리(getDetailsSubtree)에서는 바깥쪽 위젯을 고르면 값이 전혀 오지 않는다
  // (확인 결과: Expanded의 상세 subtree 18노드가 전부 프레임워크 체인이고 텍스트는 0개.
  // subtreeDepth를 5에서 12로 올려도 같았고, 원인은 깊이 설정이 아니었다). 카드 한 장을 고르는
  // 것은 가장 흔한 동작인데, 그때 픽에는 이름과 줄 하나만 담겼다.
  //
  // 이 방식은 같은 값을 더 낮은 비용으로 준다(확인 결과: 노드 1573개 · 185ms · 718KB). 기존의
  // getRootWidgetSummaryTree(148ms · 713KB)와 같은 비용이면서 텍스트 182개가 파일:줄과 함께 온다.
  // objectGroup은 선택을 받아올 때와 같아야 한다. 같은 그룹이면 같은 위젯이 같은 id를 받으므로
  // 고른 노드를 이 트리 안에서 그대로 찾을 수 있다(확인 결과: 다른 확장끼리도 id가 이어진다).
  async summaryTree() {
    try {
      const r = await this.call("ext.flutter.inspector.getRootWidgetTree", {
        isolateId: this.isolateId, groupName: "ac-pick",
        isSummaryTree: "true", withPreviews: "true", fullDetails: "true",
      });
      return (r && r.result) || null;
    } catch { return null; }
  }

  // 현재 열려 있는 화면 목록. 위젯 경로(chain)는 그 위젯이 어느 화면 안인지는 알려주지만
  // 그 화면에 어떤 경로로 진입했는지는 알려주지 못한다. 같은 화면에 진입점이 여럿이면 받는 쪽이
  // 재현할 수 없다(확인 결과: 홈 카테고리로 진입한 사실이 담기지 않았다).
  // 요약 트리에는 Navigator 에 쌓인 화면과 탭 셸이 함께 있으므로 이름만 추려 담는다.
  // 줄 번호는 붙이지 않는다. 라우트 builder 가 몰려 있는 위치에서는 다른 줄이 잡히고,
  // 파일:줄이 필요하면 chain 이 이미 정확한 값을 갖고 있다.
  screens(root) {
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || depth > 60 || out.length >= 12) return;
      const name = node.widgetRuntimeType || node.description || "";
      const file = node.creationLocation && String(node.creationLocation.file || "");
      // 프로젝트가 만든 화면만 담는다. 패키지 내부(go_router 등)의 Navigator·Route 는 경로가 아니다.
      if (/(Screen|Page)$/.test(name) && file && isProjectFile(file.replace(/^file:\/\//, ""))) {
        if (!seen.has(name)) { seen.add(name); out.push({ name, depth }); }
      }
      for (const c of node.children || []) walk(c, depth + 1);
    };
    walk(root, 0);
    // 얕을수록 나중에 얹힌 화면이다(루트 Navigator 에 push 된 것). 뒤에 올수록 위에 있게 정렬한다.
    return out.sort((a, b) => b.depth - a.depth).map((s) => s.name);
  }

  // 이 위젯의 위치를 알려주는 경로. 상위 체인을 전부 쓰면 읽을 수 없다. 확인 결과 한 번에
  // 343개가 왔고 대부분이 Focus·Semantics 같은 내부 위젯이다. 이름만 추려도 Column·Stack이 이어져
  // 화면 이름이 드러나지 않는다.
  //
  // 필요한 것은 위젯 경계다. 위로 올라가며 생성 파일이 바뀌는 지점만 남기면, 그 지점이
  // 이 위젯을 사용한 위치다(확인 결과: Icon(used_market_product_card.dart:131) ← UsedMarketProductCard
  // (used_market_section.dart:240) ← UsedMarketSection(store_screen.dart:139) ← StoreScreen
  // (app_router.dart:738)). 각 항목이 파일:줄을 갖고 있어 어느 계층이든 바로 열 수 있다.
  // 경계 목록과 바로 위 조상들의 핸들을 함께 반환한다. 라벨은 대개 가까운 상위 몇 계층에
  // 있고, 파일 경계까지 올라가면 화면 전체가 잡혀 라벨을 찾지 못한다(확인 결과: 주변이 비었다).
  async chainOf(valueId) {
    if (!valueId) return { marks: [] };
    try {
      const r = await this.call("ext.flutter.inspector.getParentChain", { isolateId: this.isolateId, arg: valueId, objectGroup: "ac-pick" });
      const nodes = (r?.result || []).map((x) => x?.node).filter(Boolean);
      const out = [];
      let lastFile = null;
      for (const n of [...nodes].reverse()) {          // 안쪽에서 바깥쪽으로
        const loc = n.creationLocation;
        if (!loc || !loc.file) continue;
        const file = String(loc.file).replace(/^file:\/\//, "");
        if (!isProjectFile(file)) continue;            // 패키지·SDK 코드는 이 화면의 구조가 아니다
        if (file === lastFile) continue;
        lastFile = file;
        const name = n.description || "?";
        out.push({ name, file, line: loc.line ?? null });
        // 화면에 도달하면 거기서 끊는다. 그 위는 라우터·앱 셸이라 모든 픽에 동일하게 붙고
        // (확인 결과: `offline_gate.dart:82` 의 Stack 과 `main.dart:169` 의 OfflineGate 가
        // 매번 두 항목을 차지했다), 그 정보는 화면 스택 줄이 이미 제공한다.
        if (/(Screen|Page)$/.test(name)) break;
        if (out.length >= 6) break;                    // 여섯 계층이면 화면까지 도달한다(확인 결과 4계층)
      }
      return { marks: out };
    } catch { return { marks: [] }; }
  }

  // 현재 화면의 값. 코드 위치만으로는 이 값이 왜 여기 표시되는지 알 수 없다.
  // 선택한 요소에 실제로 들어 있는 텍스트와 값을 담은 속성을 함께 추출한다.
  // 확인 결과(shop 상품 등록 화면): 쿠폰번호 줄을 탭하면 Text.data = "9000000000162"가 나온다.
  // 입력칸도 같은 방식으로 잡히고, controller·hintText·labelText가 속성으로 온다.
  async valuesOf(valueId, depth = 5) {
    if (!valueId) return { texts: [], props: [] };
    try {
      const r = await this.call("ext.flutter.inspector.getDetailsSubtree", {
        isolateId: this.isolateId, arg: valueId, objectGroup: "ac-pick", subtreeDepth: String(depth),
      });
      const texts = [], props = [], seen = new Set();
      const push = (arr, key, item) => { if (seen.has(key)) return; seen.add(key); arr.push(item); };
      (function walk(n, d) {
        if (!n || d > depth + 3 || texts.length + props.length > 24) return;
        for (const p of n.properties || []) {
          const name = String(p.name || "");
          if (!VALUE_PROP_RE.test(name)) continue;
          const v = unquote(String(p.description ?? ""));
          if (!hasVisible(v) || v === "null") continue;
          // 입력칸의 현재 값은 controller 안에 있다(확인 결과: "TextEditingController#e8675(TextEditingValue(
          // text: ┤메가박스├, …))"). 전체를 담으면 읽기 어려워 값만 추출한다. 비어 있는 경우도 표시한다.
          // 값이 비어 있는 이유도 확인할 수 있어야 한다.
          if (name === "controller") {
            const m = /text:\s*┤([\s\S]*?)├/.exec(v);
            if (m) { push(props, "p:입력값=" + m[1], { widget: n.description || "?", name: "입력값", value: m[1] || "(비어 있음)" }); continue; }
          }
          // 텍스트는 값과 함께 생성 위치도 담는다. 이 값이 코드 어디에 있는지가
          // 질문의 절반이기 때문이다. 주변 트리도 이 위치를 기준으로 만들어진다.
          if (name === "data" || name === "text") push(texts, "t:" + v, { value: v, widget: n.description || "?", ...locOf(n) });
          else push(props, `p:${name}=${v}`, { widget: n.description || "?", name, value: v.slice(0, 120) });
        }
        for (const c of n.children || []) walk(c, d + 1);
      })(r?.result, 0);
      return { texts, props };
    } catch { return { texts: [], props: [] }; }
  }

  close() { try { this.ws && this.ws.close(); } catch {} this.ws = null; }
}

// 요약 트리에서 고른 노드를 찾는다. 부모를 함께 기록해 위로도 탐색할 수 있게 한다. 주변을
// 조회하려고 앱에 여러 번 다시 요청하던 것을 이 맵 하나로 대신한다.
function locate(root, valueId) {
  const parents = new Map();
  let hit = null;
  (function walk(n, p) {
    if (!n) return;
    if (p) parents.set(n, p);
    if (!hit && valueId && n.valueId === valueId) hit = n;
    for (const c of n.children || []) walk(c, n);
  })(root, null);
  return { hit, parents };
}

// 이 위젯이 포함한 텍스트. 값과 함께 각자의 생성 위치를 담는다. 이 값이 코드 어디에
// 있는지가 질문의 절반이기 때문이다. 고른 위젯의 줄과 값의 줄은 대개 다르다.
function textsIn(node, cap = 8) {
  const out = [];
  const seen = new Set();
  (function walk(n) {
    if (!n || out.length >= cap) return;
    const v = String(n.textPreview || "");
    if (hasVisible(v) && !seen.has(v)) {
      seen.add(v);
      out.push({ value: v, widget: n.widgetRuntimeType || n.description || "?", ...locOf(n) });
    }
    for (const c of n.children || []) walk(c);
  })(node);
  return out;
}

// 노드가 생성된 위치. --track-widget-creation 이 켜졌을 때만 온다(꺼져 있으면 둘 다 null).
function locOf(n) {
  const loc = n && n.creationLocation;
  if (!loc || !loc.file) return { file: null, line: null };
  return { file: String(loc.file).replace(/^file:\/\//, ""), line: loc.line != null ? loc.line : null };
}

// 프로젝트 코드인지 판정한다. pub 캐시와 Flutter SDK는 제외하며, createdByLocalProject만으로는 구분되지
// 않는다(확인 결과: pub-cache의 go_router 위젯도 true로 왔다).
function isProjectFile(file) {
  return !!file && !/\/[.]pub-cache\//.test(file) && !/\/bin\/cache\/(?:artifacts|pkg)\//.test(file)
    && !/\/packages\/flutter(?:_[a-z_]+)?\/lib\//.test(file);
}

// 그 파일이 속한 프로젝트 루트(pubspec.yaml이 있는 곳). 경로를 짧게 표시할 때만 쓴다.
// 원본 필드의 파일 경로는 절대경로 그대로 둔다(받은 쪽이 바로 열 수 있어야 한다).
const rootCache = new Map();
function projectRootOf(file) {
  if (!file) return null;
  if (rootCache.has(file)) return rootCache.get(file);
  let dir = path.dirname(file), root = null;
  for (let i = 0; i < 12 && dir && dir !== "/"; i++) {
    if (fs.existsSync(path.join(dir, "pubspec.yaml"))) { root = dir; break; }
    dir = path.dirname(dir);
  }
  rootCache.set(file, root);
  return root;
}

// 선택 노드를 전달할 픽으로 변환한다. 화면에 표시되는 내용과 app_picks가 같은 값을 쓴다.
function pickOf(node, chain, target) {
  const loc = node.creationLocation || null;
  const file = loc ? String(loc.file).replace(/^file:\/\//, "") : null;
  return {
    kind: "flutter",
    app: target.label || "앱",
    widget: node.widgetRuntimeType || node.description || "?",
    desc: node.description || "",
    file,
    line: loc && loc.line != null ? loc.line : null,
    column: loc && loc.column != null ? loc.column : null,
    root: projectRootOf(file),
    local: isProjectFile(file),
    text: node.textPreview || "",
    chain,
    stateful: !!node.stateful,
    valueId: node.valueId || null,
  };
}

function keyOf(p) { return [p.file, p.line, p.column, p.widget, p.valueId].join("|"); }

// 픽이 어느 레이어에서 나왔는지. 앱 안에서 후보를 거른 결과를 그대로 담는다. 뒤의 요소가 선택되면
// 픽 내용만 보고도 원인을 구분할 수 있어야 한다.
function layerOf(lift) {
  if (!lift) return null;
  const [state, hidden] = String(lift).split("|");
  return { state, hidden: Number(hidden) || 0 };
}

let on = false;
let targets = new Map();     // key → Target
let pollTimer = null, discoverTimer = null;
let deps = { herdr: null, onPick: () => {}, onNote: () => {} };

// 연결하는 동안 모드가 꺼졌을 수 있다. 탐색에 몇 초가 걸리고 그 사이 사용자가 모드를 끌 수 있는데,
// 뒤늦게 끝난 탐색이 선택 모드를 켜면 그대로 남는다. 앱이 탭에 반응하지 않게 되고 사용자는
// 이유를 알 수 없다. 그래서 await 뒤마다 다시 확인하고, 이미 꺼졌으면 되돌린다.
async function attach(cands) {
  for (const c of cands) {
    if (!on) return;
    const key = `${c.port}/${c.token}`;
    if (targets.has(key)) continue;
    const t = new Target(c.port, c.token, c.label);
    try {
      await t.connect();
      if (!on) { t.close(); return; }
      await t.setSelect(true);
      if (!on) { try { await t.setSelect(false); } catch {} t.close(); return; }
      t.onCommit = (tt) => { deliver(tt).catch(() => {}); };
      await t.listenEvents();
      // 켜기 전부터 선택돼 있던 항목은 방금 가리킨 것이 아니므로 기준값으로만 사용한다.
      try { const n = await t.selection(); if (n) t.lastKey = keyOf(pickOf(n, [], t)); } catch {}
      targets.set(key, t);
      remember(t);
      deps.onNote(`앱 선택 모드 — ${t.label}. 한 번 탭하면 무엇이 잡히는지 보이고, 두 번 탭하면 전달됩니다.`);
    } catch {
      t.close();
    }
  }
}

// 한 번 연결한 앱은 기억해 둔다. 앱이 실행 중인 동안 주소는 유지되므로, 모드를 다시 켤 때는 탐색
// 없이 바로 연결한다. 모드를 켜자마자 탭하는 것이 자연스러운 동작이기 때문이다.
let known = [];
function remember(t) {
  known = [{ port: t.port, token: t.token, label: t.label }, ...known.filter((k) => k.port !== t.port)].slice(0, 4);
}

async function discover() {
  if (!on) return;
  const got = await Promise.all([discoverMdns(), discoverAdb(), discoverFromPanes(deps.herdr)]);
  const seen = new Set();
  const cands = got.flat().filter((c) => { const k = `${c.port}/${c.token}`; if (seen.has(k)) return false; seen.add(k); return true; });
  await attach(cands);
}

// 현재 선택을 한 건으로 만들어 보낸다. 확정 신호와 폴링 폴백 모두 이 경로를 쓴다.
async function deliver(t) {
  if (!on) return;
  // 담기 전에 최상위 레이어로 올린다. 모달이 떠 있으면 그 뒤의 요소가 여기서 후보에서 빠진다.
  const layer = layerOf(await t.lift());
  if (!on) return;
  let node = null;
  try { node = await t.selection(); } catch { return; }
  if (!node) return;
  const base = pickOf(node, [], t);
  t.lastKey = keyOf(base);   // 전달하지 않고 끝나도 같은 위치를 반복해 선택하지 않도록 여기서 기록한다
  if (layer && layer.state === "behind") {
    // 모달 바깥(스크림)을 누른 경우다. 그 위치에서 나올 수 있는 것은 모달 뒤의 위젯뿐이고, 그것을
    // 전달하는 것은 이 기능이 막으려는 동작이다.
    deps.onNote(`${t.label} — 모달 바깥을 눌렀습니다. 모달 안을 눌러 주세요.`);
    return;
  }
  const { marks } = await t.chainOf(node.valueId);
  // 속성에 들어 있는 값(입력칸의 현재 값·hint 등)은 요약 트리에 없어서 상세에서만 가져온다.
  const detail = await t.valuesOf(node.valueId);
  // 현재 화면의 맵을 한 번 받아 값·주변·화면 스택을 모두 여기서 추출한다.
  const root = await t.summaryTree();
  const { hit, parents } = root ? locate(root, node.valueId) : { hit: null, parents: new Map() };
  // 맵에서 고른 노드를 찾지 못하면(요약 트리에 없는 위치) 이전 방식으로 처리한다.
  const own = hit ? textsIn(hit) : detail.texts;
  const ownVals = own.map((x) => x.value);
  // 값만 있으면 그 값이 왜 여기 표시되는지 알 수 없다. 옆에 붙은 라벨이 있어야 무엇의
  // 값인지 알 수 있다(쿠폰번호 · 9000000000162). 라벨이 몇 계층 위에 있는지는 UI마다 다르므로 새 텍스트가
  // 나오는 곳까지 한 계층씩 올라간다. 맵을 이미 갖고 있어 추가 비용은 없다.
  // 다만 주변은 인접 영역이다. 위로 갈수록 화면 전체에 가까워지므로 범위를 제한한다. 끝까지
  // 올라가면 텍스트 255개 전부에 주변이 붙지만 그중 25건은 화면 전체를 담는다(확인 결과).
  // 네 계층·여덟 개로 제한하면 3분의 2에만 붙지만 화면 전체를 담는 일이 없고, 붙은 것은 인접 요소다
  // (확인 결과: "4,800원"을 고르면 <Row :577> "4,800원" · "19%").
  let around = { name: null, file: null, line: null, items: [] };
  let up = hit && parents.get(hit);
  for (let step = 0; up && step < 4; step++, up = parents.get(up)) {
    const items = textsIn(up, 20);
    if (items.length > 8) break;                       // 주변이 아니라 화면 전체에 해당한다
    if (items.some((x) => !ownVals.includes(x.value))) {
      around = { name: up.widgetRuntimeType || up.description || "?", ...locOf(up), items };
      break;
    }
  }
  deps.onPick({
    ...base, chain: marks, values: own, props: detail.props, around,
    screens: root ? t.screens(root) : [],
    layer,   // 어느 레이어에서 골랐는지와 가려진 후보를 몇 개 제외했는지
  });
}

// 확정 신호를 받지 못하는 앱을 위한 폴백(구버전 Flutter 등 스트림 구독이 안 되는 경우). 이때는 선택이
// 바뀌는 것으로만 판단할 수 있어, 누른 채 움직이면 여러 건이 전달될 수 있다.
async function poll() {
  if (!on) return;
  for (const [key, t] of [...targets]) {
    if (t.dead) { t.close(); targets.delete(key); continue; }
    if (t.streamOk) continue;
    let node = null;
    try { node = await t.selection(); } catch { continue; }
    if (!node) continue;
    // 같은 선택이 계속 잡혀 있는 것이지 새로 가리킨 것이 아니다.
    if (keyOf(pickOf(node, [], t)) === t.lastKey) continue;
    await deliver(t);                    // 담는 내용은 확정 경로와 같은 곳에서 만든다
  }
}

// 요소 선택 모드가 켜질 때 함께 켜진다. 앱이 없으면 조용히 아무 일도 하지 않는다.
export function start({ herdr, onPick, onNote }) {
  deps = { herdr, onPick: onPick || (() => {}), onNote: onNote || (() => {}) };
  if (on) return;
  on = true;
  // 기억해 둔 앱에 먼저 연결하고(즉시), 그 다음에 새로 탐색한다(느림). 유효하지 않은 주소면 조용히 실패한다.
  attach(known).catch(() => {}).then(() => discover().catch(() => {}));
  pollTimer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  discoverTimer = setInterval(() => { discover().catch(() => {}); }, REDISCOVER_MS);
}

// 끌 때는 앱의 선택 모드도 반드시 되돌린다. 켜 둔 채로 두면 앱을 사용할 수 없다.
// 연결된 앱만이 아니라 기억해 둔 주소까지 함께 끈다. 서버가 종료되거나 재시작하는 사이에 켜진 채
// 남은 앱이 있으면 여기서 해제된다(이미 꺼져 있으면 영향이 없다).
export function stop() {
  on = false;
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(discoverTimer); discoverTimer = null;
  const held = [...targets.values()];
  targets.clear();
  for (const t of held) (async () => { try { await t.setSelect(false); } catch {} t.close(); })();
  for (const k of known) {
    if (held.some((t) => t.port === k.port)) continue;
    (async () => {
      const t = new Target(k.port, k.token, k.label);
      try { await t.connect(); await t.setSelect(false); } catch {}
      t.close();
    })();
  }
}

export function state() {
  return { on, apps: [...targets.values()].map((t) => ({ app: t.label, port: t.port })) };
}
