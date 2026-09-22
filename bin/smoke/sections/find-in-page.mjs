// 소유 범위: 페이지 내 찾기(⌘F). 키를 가져갈 위치 판정 전수, 그리고 찾기를 guest 에게
//   맡기는 계약(호스트가 흉내 내지 않는다)과 강조를 지우는 위치.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사, sources 의 공유 소스, web/js/browser/find-in-page.js 의
//   순수 판정 shouldTakeFindKey. DOM 없이 부를 수 있다.
// 유지 조건: 판정은 표를 전수로 본다. 조건 하나를 뒤집으면 실패해야 한다.
//   ⌘F 가 브라우저 밖(파일·메모 편집기·터미널)에서 동작해야 한다는 것도 같은 표가 지킨다.
//   Monaco 의 찾기를 가져가면 안 된다.
// 영향 범위: web/js/browser/find-in-page.js · web/js/core/keynav.js ·
//   web/js/browser/{dock,webview-factory}.js · native/electron/main-window.cjs · web/index.html ·
//   web/css/18-browser.css.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/find-in-page.mjs
import { check, checkAsync } from "../core.mjs";
import { css, dock, findInPage, keynav, mainWindowSource, web, webviewFactory } from "../sources.mjs";

const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const FIND = bare(findInPage), KEYNAV = bare(keynav), DOCK = bare(dock);
const MAIN_WINDOW = bare(mainWindowSource), FACTORY = bare(webviewFactory);

// 어디서 무엇을 눌렀을 때 찾기 막대가 열리는가. 열여덟 경우를 전수로 확인한다.
const TABLE = [
  ["⌘F · 브라우저 탭", { key: "f", metaKey: true, browserTabActive: true }, true],
  ["⌃F · 브라우저 탭(Cmd·Ctrl 을 맞바꾼 키보드 설정에서도)", { key: "f", ctrlKey: true, browserTabActive: true }, true],
  ["⌘F · 분리 브라우저 창", { key: "f", metaKey: true, browserWindow: true }, true],
  ["⌘F · 분리 창이면 센터 탭 종류와 무관", { key: "f", metaKey: true, browserWindow: true, browserTabActive: false }, true],
  ["대문자 F 로 와도 같다", { key: "F", metaKey: true, browserTabActive: true }, true],
  ["⌘F · 파일 탭(Monaco 가 자기 찾기를 갖는다)", { key: "f", metaKey: true, browserTabActive: false }, false],
  ["⌃F · 터미널 안(커서 이동이다)", { key: "f", ctrlKey: true, browserTabActive: true, inTerminal: true }, false],
  ["⌘⇧F", { key: "f", metaKey: true, shiftKey: true, browserTabActive: true }, false],
  ["⌘⌥F", { key: "f", metaKey: true, altKey: true, browserTabActive: true }, false],
  ["수식키 없는 F(글자를 치는 중이다)", { key: "f", browserTabActive: true }, false],
  ["⌘G", { key: "g", metaKey: true, browserTabActive: true }, false],
  ["빈 이벤트", {}, false],
];

export default async function run() {
console.log("[find-in-page] 페이지에서 찾기(⌘F)");

const mod = await import(new URL("../../../web/js/browser/find-in-page.js", import.meta.url).href);

// 판정이 둘로 나뉜다. 어느 조합인가는 표(core/keymap)가, 그 위치에서 가져가도 되는가는
// find-in-page 가 소유한다. 검사도 실제 호출 순서대로 둘을 합쳐 부른다. 한쪽만 부르면
// keynav 가 실제로 하는 일과 다른 것을 검사하게 된다.
await checkAsync("⌘F 를 언제 가져가는지가 표대로다", async () => {
  const km = await import(new URL("../../../web/js/core/keymap.js", import.meta.url).href);
  const wrong = [];
  for (const [name, ev, want] of TABLE) {
    const bound = km.matchBinding(ev, km.bindingOf("find-in-page"));
    const got = mod.shouldTakeFindKey({ ...ev, bound });
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

check("keynav 이 그 판정을 직접 다시 쓰지 않고 부른다", () => {
  // 같은 조건을 두 군데 적으면 한쪽만 고쳐지고, 검사는 안 고쳐진 쪽을 못 본다.
  // 조합도 여기서 적지 않고 표를 불러 bound 로 넘긴다.
  return /shouldTakeFindKey\(\{/.test(KEYNAV) && /openFind\(\)/.test(KEYNAV)
    && /bound: matchBinding\(e, bindingOf\("find-in-page"\)\)/.test(KEYNAV);
});

check("찾기는 guest 가 한다 — 호스트가 페이지를 뒤지지 않는다", () => {
  // webview 는 별도 프로세스라 호스트에서 DOM 을 찾을 수 없고, 접근하더라도 남의 페이지를 고치게 된다.
  const usesGuest = /\.findInPage\(/.test(FIND);
  const scansHost = /querySelectorAll|createTreeWalker|innerHTML\s*=/.test(FIND);
  return usesGuest && !scansHost;
});

check("막대를 닫으면 페이지의 강조를 걷는다", () => {
  return /stopFindInPage\("clearSelection"\)/.test(FIND) && /function closeFind\(\)[\s\S]{0,240}clearFind\(\)/.test(FIND);
});

check("탭이 바뀌면 앞 탭의 강조와 셈을 되돌린다", () => {
  // 지우지 않으면 노란 강조와 "3/17" 이 다른 페이지 위에 남는다.
  return /export function updateActiveWebview\(\)[\s\S]{0,200}findRetarget\(\)/.test(FACTORY)
    && /export function findRetarget/.test(FIND);
});

check("webview 에 포커스가 있을 때의 ⌘F 가 중계된다", () => {
  // 페이지를 보는 동안 누르는 것이 보통이라 이 경로가 기본이다. 중계 쪽 표에 이름이 있어야
  // 하고(그쪽은 그 표로만 판정한다), 받는 위치도 있어야 한다.
  return /"find-in-page": \{ mod: true, key: "f" \}/.test(MAIN_WINDOW)
    && /const hit = matchRelay\(input\);/.test(MAIN_WINDOW)
    && /case "find-in-page": openFind\(\)/.test(DOCK);
});

check("찾기 막대 DOM 과 CSS 가 있다", () => {
  const ids = ["wv-find", "wv-find-q", "wv-find-count", "wv-find-prev", "wv-find-next", "wv-find-close"];
  const missing = ids.filter((id) => !web.includes(`id="${id}"`));
  if (missing.length) throw new Error("빠진 DOM: " + missing.join(", "));
  // 흐름에 넣으면 막대가 뜰 때마다 페이지가 밀려 보던 위치가 움직인다. 크롬처럼 떠 있어야 한다.
  return /\.wv-find\s*\{[^}]*position:\s*absolute/.test(css("18-browser"));
});
}
