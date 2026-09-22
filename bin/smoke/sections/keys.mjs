// 소유 범위: 수식키·이름 있는 키 표·페이지 안에서 만들어지는 키 이벤트, 대량 기입과 값 채우기.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/keys.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[10m] 키 — 수식키는 같은 인자로 들어오고, 누른 탭 밖으로 새지 않는다");
{
  const cdp = cdpCmdInputSource, native = readAll("native"), m2 = read("bin/iris-mcp.mjs");
  // 도구를 둘로 나누면 쓰는 쪽이 어느 것인지 매번 판단해야 하고 그만큼 실수가 난다.
  check("특수키 전용 도구를 따로 만들지 않는다", () =>
    /name: "browser_key"/.test(m2) && !/browser_special_key|browser_hotkey|browser_chord/.test(m2));
  check("수식키를 한 문자열로 받는다", () =>
    /String\(args\.key \|\| "Enter"\)\.split\("\+"\)/.test(cdp)
    && /const name = parts\.pop\(\);/.test(cdp)
    && /cmd: "metaKey", command: "metaKey"/.test(cdp));
  // sendInputEvent 는 창의 입력 경로를 타서 다른 앱으로 샐 수 있고, dispatchKeyEvent 는 화면에
  // 없는 webview 에 성공을 돌려주고도 전달되지 않는다(둘 다 확인). 음성 조건은 native 전체에서
  // 확인하고, 대량 기입의 페이지 안 입력·가시성 계약은 그 소유자 조각만 확인한다.
  {
    const bulk = sliceBetween(cdp, "    async bulkfill(", "    async key(", "대량 기입 입력 경로");
    // sendInputEvent 는 창의 입력 경로를 타서 다른 앱·탭으로 샐 수 있어 키·일반 입력에는 금지다.
    // 예외는 Cloudflare 통과용 네이티브 selector 클릭(cdp-control 의 nativeClickSel) 하나다. CDP 를
    // 붙이면 그 순간 이 탭이 챌린지에서 봇으로 걸리고(확인 결과: 부착 시 ahrefs Turnstile 실패),
    // CDP 없이 실제 입력을 넣는 방법이 sendInputEvent 뿐이라 그 함수만 허용한다. 그 밖의
    // sendInputEvent 와 모든 dispatchKeyEvent 는 금지이고, 이 검사가 그 경계를 지킨다.
    const nativeClickFn = sliceBetween(native, "async function nativeClickSel(", "// [Cloudflare 통과 · 배경 탭]", "네이티브 selector 클릭");
    check("키는 창이 아니라 페이지 안에서 만들어진다", () =>
      /sendInputEvent\(/.test(nativeClickFn)
      && !/sendInputEvent\(/.test(native.replace(nativeClickFn, ""))
      && !/send\("Input\.dispatchKeyEvent"/.test(native)
      && /new KeyboardEvent\("keydown", init\)/.test(cdp));
    // 배경 탭(display:none)은 네이티브 입력이 닿지 않아 CDP-free `.click()` 으로 누른다. 이 경로는
    // CDP 를 붙이지 않아야 하고(부착이 탐지 신호) 네이티브 입력을 섞어서도 안 된다. executeJavaScript+.click() 만 쓴다.
    const jsClickFn = sliceBetween(native, "async function jsClickSel(", "async function cdpExecRaw(", "배경 탭 CDP-free 클릭");
    check("배경 탭은 CDP 없이 페이지 안 클릭으로 누른다", () =>
      /wc\.executeJavaScript\(/.test(jsClickFn)
      && /\.click\(\)/.test(jsClickFn)
      && !/sendInputEvent\(/.test(jsClickFn)
      && !/send\("Input\./.test(jsClickFn)
      && !/wc\.debugger\.attach/.test(jsClickFn));
    // sel-click(ref 아님)은 누르기 전에 붙은 CDP 를 뗀다(부착이 탐지 신호). 그다음 보이는 탭은
    // 네이티브, 배경 탭은 JS 클릭으로 나뉘고 둘 다 CDP 없이 동작한다. ref 클릭만 기존 CDP 경로다.
    const selClickBranch = sliceBetween(native, '(cmd === "click" || cmd === "dblclick") && args && args.sel && !args.ref)', "const send = ensureAttached(wc);", "sel-click 2단 분기");
    check("selector 클릭은 CDP를 떼고 가시성으로 native·JS를 가른다", () =>
      /detachIdle\(wc\)/.test(selClickBranch)
      && /isTabShown\(wc\.id\)/.test(selClickBranch)
      && /nativeClickSel\(wc, args\.sel/.test(selClickBranch)
      && /jsClickSel\(wc, args\.sel/.test(selClickBranch));
    check("보이지 않는 탭에는 넣지 않는다", () =>
      /if \(!isTabShown\(wc\.id\)\) \{/.test(bulk)
      && /보이지 않는 탭에는 대량으로 넣지 않습니다/.test(bulk));
    // 페이지로 넘기는 스크립트에 자리표시자가 그대로 남으면 그 안에서 문법 오류가 나고, 결과는
    // "글을 넣지 못했습니다" 한 줄로만 돌아온다(확인 결과). 실제로 값이 끼워지는지 본다.
    check("페이지로 넘기는 값이 자리표시로 남지 않는다", () =>
      /const t = \$\{JSON\.stringify\(String\(text\)\)\};/.test(bulk)
      && /const key = \$\{JSON\.stringify\(mkey\)\}, vk = \$\{mvk\};/.test(bulk)
      && !/\$\{"\$\{/.test(bulk));
    check("값도 페이지 안에서 넣는다", () =>
      // OS 입력은 이 앱에서 쓸 수 없다. webview 게스트는 임베더가 태그에 포커스를 줘야
      // hasFocus 가 참이 되고, 아니면 크로미움이 키를 버린다(확인 결과: 편집기가 열린 채
      // 5칸을 입력했는데 한 글자도 들어가지 않았다).
      /document\.execCommand\("insertText", false, t\)/.test(bulk)
      && /new InputEvent\("beforeinput"/.test(bulk)
      && /new KeyboardEvent\("keydown", init\)/.test(bulk)
      && !/send\("Input\.(insertText|dispatchKeyEvent)"/.test(bulk));
    check("대량 기입은 이동키 넷 말고는 누르지 않는다", () =>
      /const MOVE = \{ Enter:/.test(bulk)
      && /ArrowRight/.test(bulk)
      && /이동키는 Enter·Tab·ArrowDown·ArrowRight 중 하나여야 합니다/.test(bulk));
    check("친 뒤에 화면이 달라졌는지 보고 말한다", () =>
      /const before = await textOf\(\)/.test(bulk)
      && /const after = await textOf\(\)/.test(bulk)
      && /화면이 한 글자도 달라지지 않았습니다/.test(bulk)
      && /landed: seen \? "확인됨" : "확인 못 함"/.test(bulk)
      // 입력되지 않았으면 그 이유도 함께 반환한다. 원인을 찾으려고 앱을 다시 설치하지 않게 한다.
      && /커서 \$\{why\.active/.test(bulk));
    check("중간에 실패하면 멈추고 몇 칸 들어갔는지 돌려준다", () =>
      /failed = \{ at: i \+ 1/.test(bulk)
      && /break;/.test(bulk)
      && /앞 \$\{done\}칸은 이미 들어갔습니다/.test(bulk));
  }
  check("이벤트만 보내고 끝내지 않는다 — 편집까지 한다", () =>
    /el\.value = el\.value\.slice\(0, s\) \+ typed \+ el\.value\.slice\(e\)/.test(cdp)
    && /new Event\("input", \{ bubbles: true \}\)/.test(cdp));
  check("textarea에서 Enter는 줄을 바꾼다", () =>
    /key === "Enter" && el\.tagName === "TEXTAREA"/.test(cdp));
  check("Tab은 실제로 포커스를 옮긴다", () =>
    /next\.focus\(\); did = "포커스 이동"/.test(cdp));
  check("ctrl·meta 조합은 글자를 타이핑하지 않는다", () =>
    /!M\.ctrlKey && !M\.metaKey && \[\.\.\.key\]\.length === 1/.test(cdp));
  check("수식키가 있으면 대문자로 shift를 유추하지 않는다", () =>
    // "Ctrl+A"에 shift를 얹으면 Ctrl+Shift+A라는 다른 단축키가 된다.
    /if \(\/\^\[A-Z\]\$\/\.test\(name\) && !parts\.length\) mods\.shiftKey = true;/.test(cdp));
  check("신뢰된 이벤트가 아니라는 한계를 감추지 않는다", () =>
    /isTrusted가 거짓이라/.test(cdp));
  check("모르는 키·수식키는 조용히 지나가지 않는다", () =>
    /모르는 수식키/.test(cdp) && /모르는 키/.test(cdp) && /누를 키가 없습니다/.test(cdp));
  check("이름 있는 키만 표를 쓴다 — 글자는 글자에서 뽑는다", () =>
    /"Key" \+ name\.toUpperCase\(\)/.test(cdp)
    && /const fkey = \/\^f\(\[1-9\]\|1\[0-2\]\)\$\/\.exec\(lower\);/.test(cdp));
}

}
