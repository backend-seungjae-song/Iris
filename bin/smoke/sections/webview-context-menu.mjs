// 소유 범위: 페이지 우클릭 메뉴. 무엇을 선택했을 때 어떤 항목이 표시되는지 전수, 그리고
//   "새 탭"이 우리 탭으로 가는가·http(s) 밖으로는 안 여는가 같은 경계.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사, sources 의 공유 소스,
//   native/electron/webview-context-menu.cjs 의 순수 판정 menuPlan. Electron 없이 호출할 수 있다.
// 유지 조건: 판정은 표를 전수로 본다. 분기 하나를 지우면 실패해야 한다.
//   "새 탭에서 열기"가 Electron 팝업 창으로 열리면 탭 목록에 잡히지 않고 로그인 프로필이 갈린다.
//   그 경로가 ac-open-tab 인지 검사로 강제한다.
// 영향 범위: native/electron/{webview-context-menu,webview-lifecycle,main}.cjs.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/webview-context-menu.mjs
import { check, checkAsync } from "../core.mjs";
import { contextMenuSource, main, webviewLifecycleSource } from "../sources.mjs";

const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const CTX = bare(contextMenuSource), LIFECYCLE = bare(webviewLifecycleSource), MAIN = bare(main);

// 무엇을 선택했는가 → 표시할 항목. 크롬에서 같은 위치에 뜨는 것과 같아야 한다.
const CASES = [
  ["맨 페이지", {}, { has: ["back", "forward", "reload", "page-copy-url", "inspect"], hasNot: ["copy", "link-open-tab"] }],
  ["맨 페이지 · 뒤로 갈 곳 없음", {}, { nav: { canGoBack: false, canGoForward: true }, has: ["back-off", "forward"], hasNot: ["back"] }],
  ["링크", { linkURL: "https://a.example/b" }, { has: ["link-open-tab", "link-copy", "inspect"], hasNot: ["back", "reload"] }],
  ["이미지", { hasImageContents: true, srcURL: "https://a.example/i.png" }, { has: ["image-open-tab", "image-copy", "image-copy-url", "image-save"], hasNot: ["back"] }],
  ["mediaType 로만 온 이미지", { mediaType: "image", srcURL: "https://a.example/i.png" }, { has: ["image-copy"], hasNot: [] }],
  ["이미지 링크", { linkURL: "https://a.example/b", hasImageContents: true, srcURL: "https://a.example/i.png" }, { has: ["link-open-tab", "image-save"], hasNot: [] }],
  ["글자 선택", { selectionText: "  찾을 말  " }, { has: ["copy", "search-selection"], hasNot: ["paste", "back"] }],
  ["입력칸", { isEditable: true }, { has: ["cut", "copy", "paste", "select-all", "undo", "redo"], hasNot: ["search-selection", "back"] }],
  ["입력칸 안에서 글자 선택", { isEditable: true, selectionText: "x" }, { has: ["paste"], hasNot: ["search-selection"] }],
  ["공백만 선택한 것은 선택이 아니다", { selectionText: "   " }, { has: ["back", "reload"], hasNot: ["search-selection"] }],
];

export default async function run() {
console.log("[webview-context-menu] 페이지 우클릭 메뉴");

const mod = await import(new URL("../../../native/electron/webview-context-menu.cjs", import.meta.url).href);
const menuPlan = mod.menuPlan || (mod.default && mod.default.menuPlan);

await checkAsync("무엇을 짚었느냐에 따라 서는 항목이 표대로다", async () => {
  const wrong = [];
  for (const [name, params, want] of CASES) {
    const plan = menuPlan(params, want.nav || { canGoBack: true, canGoForward: true });
    for (const id of want.has) if (!plan.includes(id)) wrong.push(`${name}: ${id} 가 없다`);
    for (const id of want.hasNot) if (plan.includes(id)) wrong.push(`${name}: ${id} 가 있으면 안 된다`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

await checkAsync("구분선이 맨 앞·맨 뒤에 오거나 둘이 붙지 않는다", async () => {
  const bad = [];
  for (const [name, params] of CASES) {
    const plan = menuPlan(params, { canGoBack: true, canGoForward: true });
    if (plan[0] === "-" || plan[plan.length - 1] === "-") bad.push(name + ": 끝에 구분선");
    for (let i = 1; i < plan.length; i++) if (plan[i] === "-" && plan[i - 1] === "-") bad.push(name + ": 구분선 둘이 붙음");
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("어떤 경우에도 메뉴가 비지 않는다", async () => {
  // 항목이 하나도 없으면 우클릭이 동작하지 않는 것과 같다.
  for (const [name, params] of CASES) {
    const plan = menuPlan(params, { canGoBack: false, canGoForward: false });
    if (!plan.length) throw new Error(name + " 에서 빈 메뉴");
  }
  return true;
});

check("새 탭은 우리 탭으로 연다 — Electron 팝업 창이 아니라", () => {
  // 창으로 열면 탭 목록에 안 잡히고 프로필(로그인)이 갈린다. webview-lifecycle 이 같은 이유로
  // 같은 경로를 쓴다.
  return /host\.send\("ac-open-tab"/.test(CTX) && !/new BrowserWindow|shell\.openExternal/.test(CTX);
});

check("http(s) 가 아닌 주소로는 탭을 열지 않는다", () => {
  // file: 로 열리면 앱이 자기 파일을 페이지에 노출한다.
  return /\/\^https\?:\/i\.test\(u\)/.test(CTX) && /const u = httpOnly\(url\)/.test(CTX);
});

check("메뉴는 페이지를 고치지 않는다", () => {
  // 하는 일은 읽기와 우리 브라우저의 이동뿐이어야 한다.
  return !/executeJavaScript|insertCSS|insertText/.test(CTX);
});

check("guest 마다 실제로 걸린다", () => {
  return /attachContextMenu\(wc\)/.test(LIFECYCLE)
    && /attachContextMenu:\s*createWebviewContextMenu\(/.test(MAIN);
});
}
