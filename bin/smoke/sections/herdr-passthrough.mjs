// 소유 범위: herdr 를 그대로 둔다. 의도적으로 바꾸는 것 말고는 막지 않는다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/herdr-passthrough.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2k] herdr 그대로 — 우리가 일부러 바꾸는 것 말고는 막지 않는다");
// 마우스 트래킹을 전부 억제하면 herdr 의 탭 클릭·"1 new message (click) ↓" 배너·복사 토스트가
// 동작하지 않는다. 억제의 목적은 "드래그=로컬 선택" 하나이므로 그것만 남기고 나머지는 돌려준다.
check("움직이지 않은 클릭은 herdr로 전달", () => {
  const seg = sliceBetween(xtermWiring, 'terminalInner.addEventListener("mouseup"', 'terminalInner.addEventListener("contextmenu"', "움직이지 않은 클릭은 herdr로 전달");
  return /wsSend\(\{ type: "pty\.input", data: "\\x1b\[<" \+ b \+ at \+ "M\\x1b\[<" \+ b \+ at \+ "m" \}\)/.test(seg);
});
check("드래그는 herdr로 안 감(로컬 선택 유지)", () => {
  const seg = sliceBetween(xtermWiring, 'terminalInner.addEventListener("mouseup"', 'terminalInner.addEventListener("contextmenu"', "드래그는 herdr로 안 감(로컬 선택 유지)");
  return /Math\.abs\(e\.clientX - mdX\) > 3 \|\| Math\.abs\(e\.clientY - mdY\) > 3\) return;/.test(seg)
    && /if \(mdHadSel\) return;/.test(seg);
});
check("우리 커스텀 제스처와 링크 클릭은 가로채지 않음", () => {
  const seg = sliceBetween(xtermWiring, 'terminalInner.addEventListener("mouseup"', 'terminalInner.addEventListener("contextmenu"', "우리 커스텀 제스처와 링크 클릭은 가로채지 않음");
  return /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.shiftKey\) return;/.test(seg)
    && /querySelector\("\.xterm-cursor-pointer"\)\) return;/.test(seg);
});
check("좌·가운데·우 버튼 모두 전달", () => {
  const seg = sliceBetween(xtermWiring, 'terminalInner.addEventListener("mouseup"', 'terminalInner.addEventListener("contextmenu"', "좌·가운데·우 버튼 모두 전달");
  return /e\.button === 1 \? 1 : e\.button === 2 \? 2 : 0/.test(seg)
    && /if \(getAppMouseOn\(\)\) e\.preventDefault\(\)/.test(xtermWiring); // 우클릭을 브라우저 메뉴가 가로채지 않게
});
check("휠·클릭이 같은 좌표 계산을 씀", () => {
  const n = (xtermWiring.match(/cellAt\(/g) || []).length;
  return /function cellAt\(clientX, clientY\)/.test(xtermWiring) && n >= 3; // 정의 + 휠 + 클릭
});
check("앱이 마우스를 안 쓰면 개입하지 않음", () => {
  const seg = sliceBetween(xtermWiring, 'terminalInner.addEventListener("mouseup"', 'terminalInner.addEventListener("contextmenu"', "앱이 마우스를 안 쓰면 개입하지 않음");
  return /if \(!getAppMouseOn\(\) \|\| !ws \|\| ws\.readyState !== 1\) return;/.test(seg);
});
// Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있다. 터미널 링크 제스처는 어느 쪽을 눌러도 동작해야 한다.
// (cmd+w=herdr 탭 닫기 / ctrl+w=셸 단어삭제처럼 의도적으로 구분해야 하는 경우는 해당 없음.)
check("Finder 제스처는 meta·ctrl 양쪽을 받는다", () => {
  // 링크 자체가 ⌘·⌃ 를 누르고 있을 때만 성립한다. 그 위에 얹히는
  // 제스처가 ⌘⇧/⌃⇧ = Finder 다. 둘 다 meta·ctrl 양쪽을 받아야 동작이 일관된다.
  const reveal = /const wantsReveal = \(ev\) => !!\(ev && ev\.shiftKey && \(ev\.metaKey \|\| ev\.ctrlKey\)\)/.test(fileRouting);
  const gate = /export function linkModeFromEvent\(e\) \{ return !!\(e && \(e\.metaKey \|\| e\.ctrlKey\)\); \}/.test(xtermWiring);
  return reveal && gate;
});

// 키만 눌렀을 때 밑줄이 곧바로 떠야 한다. xterm 은 마지막으로 본 셀과 같으면 링크 제공자를
// 호출하지 않으므로(lib/xterm.js 의 _handleMouseMove) 제자리로 mousemove 를 보내는 것은
// 효과가 없고, 사용자가 마우스를 실제로 움직여야만 활성화된다.
await checkAsync("⌘ 를 누르면 마우스를 안 움직여도 링크가 산다", async () => {
  const mod = await import(new URL("../../../web/js/panel/xterm-wiring.js", import.meta.url).href);
  const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  const cases = [
    ["한가운데", { x: 400, y: 300 }, rect],
    ["맨 아래(아래로 못 간다)", { x: 400, y: 599 }, rect],
    ["맨 위", { x: 400, y: 1 }, rect],
    ["아주 낮은 터미널(옆으로 흔든다)", { x: 400, y: 10 }, { left: 0, top: 0, right: 800, bottom: 20, width: 800, height: 20 }],
    ["크기를 모른다", { x: 400, y: 300 }, null],
  ];
  const wrong = [];
  for (const [name, pointer, r] of cases) {
    const pts = mod.linkProbePoints(pointer, r);
    if (pts.length !== 2) { wrong.push(`${name}: ${pts.length}개`); continue; }
    const [probe, back] = pts;
    // 끝은 반드시 원래 위치여야 한다. 아니면 밑줄이 다른 줄에 뜬다.
    if (back.x !== pointer.x || back.y !== pointer.y) { wrong.push(`${name}: 제자리로 안 돌아온다`); continue; }
    // 앞은 반드시 다른 셀이어야 한다. 같으면 xterm 이 제공자를 호출하지 않는다.
    if (probe.x === back.x && probe.y === back.y) { wrong.push(`${name}: 같은 자리를 찍는다`); continue; }
    if (Math.abs(probe.x - back.x) + Math.abs(probe.y - back.y) < mod.LINK_PROBE_JUMP) {
      wrong.push(`${name}: 한 셀보다 가깝다`); continue;
    }
    // 그리고 안쪽이어야 한다. 밖으로 나가면 좌표가 잘려 같은 셀로 되돌아온다.
    if (r && (probe.y < r.top || probe.y > r.bottom - 1 || probe.x < r.left || probe.x > r.right - 1)) {
      wrong.push(`${name}: 밖으로 나간다 (${probe.x},${probe.y})`);
    }
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  // 포인터를 한 번도 관측하지 못했으면 보낼 좌표가 없다.
  if (mod.linkProbePoints(null, rect).length) throw new Error("포인터가 없는데 자리를 찍는다");
  return true;
});
check("키를 눌렀을 때 그 두 자리를 실제로 흘린다", () => {
  const seg = /function setLinkMode\(on\) \{[\s\S]*?\n\}/.exec(xtermWiring);
  if (!seg) throw new Error("setLinkMode 를 못 찾음");
  return /const points = linkProbePoints\(lastPointer, rect\);/.test(seg[0])
    && /for \(const point of points\)/.test(seg[0])
    && /clientX: point\.x, clientY: point\.y/.test(seg[0])
    && /metaKey: on, ctrlKey: on/.test(seg[0]);
});

// 좌표가 맞아도 대상이 틀리면 아무 일도 일어나지 않는다. xterm 은 .xterm-screen 에 mousemove
// 를 걸고 그것은 컨테이너의 자손이다. 이벤트는 위로만 전파되므로 컨테이너에 보낸 것은 자손에
// 닿지 않는다. 헤드리스 확인 결과: 컨테이너에 보내면 제공자 호출 0, .xterm-screen 에 보내면 1·2.
// 앞선 검사 둘은 좌표만 봐서 이 실패를 보지 못하고, 기능이 동작하지 않는 채로 통과했다.
await checkAsync("쏘는 대상이 xterm 이 실제로 듣는 자리다", async () => {
  const mod = await import(new URL("../../../web/js/panel/xterm-wiring.js", import.meta.url).href);
  const screen = { tag: "screen" };
  const asked = [];
  const inner = { tag: "inner", querySelector: (sel) => { asked.push(sel); return sel === ".xterm-screen" ? screen : null; } };
  if (mod.linkProbeTarget(inner) !== screen) throw new Error("컨테이너에 그대로 쏜다");
  if (!asked.includes(".xterm-screen")) throw new Error("듣는 자리를 찾지도 않는다");
  // 아직 열리지 않았거나 구조가 바뀌었으면 컨테이너로라도 보낸다. 아무것도 하지 않고 끝내지 않는다.
  const bare = { tag: "bare", querySelector: () => null };
  if (mod.linkProbeTarget(bare) !== bare) throw new Error("찾는 것이 없을 때 아무 데도 안 쏜다");
  if (mod.linkProbeTarget(null) !== null) throw new Error("없는 것에 쏘려 한다");
  const seg = /function setLinkMode\(on\) \{[\s\S]*?\n\}/.exec(xtermWiring);
  if (!seg) throw new Error("setLinkMode 를 못 찾음");
  if (!/const el = linkProbeTarget\(inner\);/.test(seg[0])) throw new Error("고른 자리를 안 쓴다");
  if (/getTerminalInner\(\)\.dispatchEvent/.test(seg[0])) throw new Error("컨테이너에 직접 쏜다");
  return true;
});

// Ctrl/Cmd+Shift+클릭 한 번을 xterm의 shift 선택 확장이 함께 소비해 "반쯤 드래그한 듯한" 선택이 남았다.
check("Ctrl/Cmd+Shift 클릭이 선택 확장에 이중 소비되지 않음", () => {
  const seg = sliceBetween(xtermWiring, "function selService", 'terminalInner.addEventListener("contextmenu"', "Ctrl/Cmd+Shift 클릭이 선택 확장에 이중 소비되지 않음");
  return /if \(e\.shiftKey && \(e\.metaKey \|\| e\.ctrlKey\)\) \{/.test(seg)
    && /ss\.disable\(\); selOff = true;/.test(seg) && /ss\.enable\(\)/.test(seg);
});
check("이벤트 자체는 막지 않음(링크 클릭 보존)", () => {
  // mousedown을 막으면 xterm이 링크 대상을 기억하지 못해 링크 클릭이 통째로 죽는다.
  const seg = sliceBetween(xtermWiring, "function selService", 'terminalInner.addEventListener("contextmenu"', "이벤트 자체는 막지 않음(링크 클릭 보존)");
  return !/stopPropagation\(\)/.test(seg) && !/preventDefault\(\)/.test(seg);
});
check("내부 API 없으면 폴백 + 로그", () => {
  const seg = sliceBetween(xtermWiring, "function selService", 'terminalInner.addEventListener("contextmenu"', "내부 API 없으면 폴백 + 로그");
  return /xterm\.clearSelection\(\)/.test(seg) && /selection service API 없음/.test(xtermWiring);
});
check("선택 서비스 API가 vendor에 실재", () => {
  const v = read("web/vendor/xterm.js");
  return /disable\(\)\{this\.clearSelection\(\),this\._enabled=!1\}enable\(\)\{this\._enabled=!0\}/.test(v)
    && /this\._selectionService=this/.test(v);
});

// vendor 는 저장소에 없다(.gitignore). clone 한 사람에게도 화면이 뜨려면 의존성에서 그대로
// 만들어 낼 수 있어야 한다. 손으로 받아다 넣으면 지금 것이 어느 버전인지 답할 수 없고,
// clone 하면 편집기·터미널이 404 가 된다.
check("vendor를 의존성에서 만들어 낼 수 있다", () => {
  const gen = read("scripts/build-vendor.mjs");
  return /@xterm\/xterm/.test(gen) && /@xterm\/addon-fit/.test(gen)
    && /jszip/.test(gen) && /monaco-editor/.test(gen)
    && /"build:vendor": "node scripts\/build-vendor\.mjs"/.test(read("package.json"))
    && /"prepare": "node scripts\/build-vendor\.mjs"/.test(read("package.json"));   // clone 후 install만으로 준비
});
check("vendor 버전이 package.json에 못박혀 있다", () => {
  const pkgRaw = JSON.parse(read("package.json"));
  const d = pkgRaw.dependencies || {};
  // 범위(^)가 아니라 정확한 버전을 쓴다. 저장소에 있던 파일과 바이트가 같은 것이 그 버전이다.
  return d["@xterm/xterm"] === "6.0.0" && d["@xterm/addon-fit"] === "0.11.0";
});
check("화면이 부르는 vendor 경로가 모두 실재한다", () => {
  const wanted = [...web.matchAll(/["'(]\/vendor\/([A-Za-z0-9._\/-]+)/g)].map((m) => m[1]);
  return new Set(wanted).size > 0 && [...new Set(wanted)].every((rel) => existsSync(path.join(ROOT, "web/vendor", rel)));
});

}
