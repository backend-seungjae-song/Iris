// 소유 범위: 크롬 사용자에게 익숙한 브라우저 단축키가 실제로 연결돼 있는지 확인한다.
//   페이지에 포커스가 있을 때(메인 프로세스 중계)와 앱 UI 에 있을 때(렌더러) 양쪽을 본다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사와 sources 의 공유 소스.
// 유지 조건: 두 경로가 같은 이름으로 연결돼야 한다. 중계 이름과 dock 의 case 가
//   일치하지 않으면 페이지 위에서만 키가 동작하지 않고, 눌러 보기 전에는 드러나지 않는다.
//   ⌘←→ 는 의도적으로 받지 않는다. 입력칸에서는 줄 끝 이동이고, 메인 프로세스는 포커스가
//   입력칸인지 알 수 없다. 가로채면 입력 중에 페이지가 이동한다. 그 결정도 검사로 강제한다.
// 영향 범위: native/electron/main-window.cjs · web/js/browser/dock.js ·
//   web/js/core/keynav.js.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/browser-shortcuts.mjs
import { check } from "../core.mjs";
import { dock, keynav, mainWindowSource } from "../sources.mjs";

const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const MAIN_WINDOW = bare(mainWindowSource), DOCK = bare(dock), KEYNAV = bare(keynav);

// 중계 이름 → dock 이 그 이름으로 하는 일.
const RELAYED = [
  ["find-in-page", /case "find-in-page": openFind\(\)/],
  ["find-next", /case "find-next": findNext\(true\)/],
  ["find-prev", /case "find-prev": findNext\(false\)/],
  ["focus-url", /case "focus-url":[\s\S]{0,60}urlInput\.focus\(\)/],
  ["nav-back", /case "nav-back":[\s\S]{0,120}goBack\(\)/],
  ["nav-forward", /case "nav-forward":[\s\S]{0,120}goForward\(\)/],
  ["print-page", /case "print-page":[\s\S]{0,120}\.print\(\)/],
];

export default async function run() {
console.log("[browser-shortcuts] 크롬에서 손에 익은 키가 여기서도 되는가");

check("페이지에 포커스가 있을 때 중계되는 이름이 다 있다", () => {
  // 이름은 조건문이 아니라 중계 표(DEFAULT_RELAY)에 있다. 표에 없으면 그 키는 페이지 위에서
  // 아무 동작도 하지 않고 앱 UI 에서만 동작한다.
  const missing = RELAYED.map(([name]) => name)
    .filter((name) => !new RegExp(`"${name}": \\{`).test(MAIN_WINDOW));
  if (missing.length) throw new Error("중계 표에 없음: " + missing.join(", "));
  return true;
});

check("중계된 이름마다 실제로 하는 일이 있다", () => {
  // 이름만 보내고 받는 쪽이 없으면 키는 눌려도 아무 동작이 없고, 이 고장은 눈에 띄지 않는다.
  const dead = RELAYED.filter(([, re]) => !re.test(DOCK)).map(([name]) => name);
  if (dead.length) throw new Error("받는 자리 없음: " + dead.join(", "));
  return true;
});

check("앱 UI 에 포커스가 있을 때도 같은 키가 산다", () => {
  // 주소창·탭바에 포커스가 있는 경우다. 여기가 비면 "주소창을 눌렀다가 ⌘[ 를 누르면 안 된다"가 된다.
  // 조합은 표가 정하므로 여기서는 그 이름을 실제로 불러 쓰는지만 본다.
  return /bindingOf\("find-next"\)[\s\S]{0,80}findNext/.test(KEYNAV)
    && /bindingOf\("find-prev"\)[\s\S]{0,80}findNext/.test(KEYNAV)
    && /bindingOf\("focus-url"\)[\s\S]{0,120}focus\(\)/.test(KEYNAV)
    && /bindingOf\("nav-back"\)[\s\S]{0,80}goBack\(\)/.test(KEYNAV)
    && /bindingOf\("nav-forward"\)[\s\S]{0,80}goForward\(\)/.test(KEYNAV)
    && /bindingOf\("print-page"\)[\s\S]{0,80}\.print\(\)/.test(KEYNAV);
});

check("⌘←→ 는 가져가지 않는다", () => {
  // 페이지·주소창 입력 중에는 줄 끝 이동이다. 가로채면 입력 중에 페이지가 이동한다.
  return !/ArrowLeft"\)[\s\S]{0,60}goBack/.test(MAIN_WINDOW)
    && !/send\("nav-back"\)[\s\S]{0,40}Arrow/.test(MAIN_WINDOW);
});

check("⌘⇧P 는 여전히 파일 검색이다", () => {
  // ⌘P 는 인쇄이고, 그 위에 파일 검색을 겹치면 자주 쓰는 기능을 드물게 쓰는 기능과 맞바꾸게 된다.
  // 둘은 shift 로 구분되는 서로 다른 표 항목이며, 같은 조합이 되면 아래 검사가 실패한다.
  return /"file-search": \{ mod: true, shift: true, key: "p" \}/.test(MAIN_WINDOW)
    && /"print-page": \{ mod: true, key: "p" \}/.test(MAIN_WINDOW);
});
}
