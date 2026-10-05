// 소유 범위: 메인 화면 ↔ 스페이스 브라우저 이동. 판정 표 전수, 키를 code 로 읽는지,
//   webview 포커스에서 돌아오는 경로가 실제로 연결돼 있는지.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사, sources 의 공유 소스, web/js/core/screen-switch.js 의
//   순수 판정 두 개(planScreen·onSpaceBrowserIn). 이 둘은 DOM 없이 호출할 수 있다.
// 유지 조건: 판정은 표를 전수로 본다. 분기를 하나라도 소스에서 지우면 실패해야 한다.
// 영향 범위: web/js/core/{screen-switch,keynav}.js · web/js/browser/dock.js ·
//   native/electron/main-window.cjs 의 중계.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/screen-switch.mjs
import { runInNewContext } from "node:vm";
import {
  cannotMeasure, check, checkAsync, read as readSrc,
} from "../core.mjs";
import { dock, keynav, mainWindowSource, screenSwitch } from "../sources.mjs";

// 주석을 먼저 제거한다. 제거하지 않으면 "e.code 로 본다"라고 적어 둔 주석이 검사를 통과시킨다.
// 확인 결과: e.code 를 e.key 로 바꿔도 통과했다. 러너의 도달성 검사도 같은 이유로
// 같은 처리를 한다.
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const KEYNAV = bare(keynav), DOCK = bare(dock), MAIN_WINDOW = bare(mainWindowSource), SWITCH = bare(screenSwitch);

// 창 종류·도킹·현재 보고 있는 화면. 이름은 사람이 읽는 설명이다.
const WHERE = {
  "메인 창·분리 상태": { browserMode: false, sharedWindow: false, docked: false, activeKind: "file" },
  "메인 창·도킹·브라우저 탭": { browserMode: false, sharedWindow: false, docked: true, activeKind: "browser" },
  "메인 창·도킹·파일 탭": { browserMode: false, sharedWindow: false, docked: true, activeKind: "file" },
  "메인 창·도킹·빈 센터": { browserMode: false, sharedWindow: false, docked: true, activeKind: null },
  "스페이스 브라우저 창": { browserMode: true, sharedWindow: false, docked: false, activeKind: null },
  "공유 브라우저 창": { browserMode: true, sharedWindow: true, docked: false, activeKind: null },
  "메모 창": { browserMode: false, sharedWindow: false, memoMode: true, docked: false, activeKind: null },
};

// 열여덟 분기 전부. main = ⌥1, browser = ⌥2, toggle = ⌥Tab.
const TABLE = {
  "메인 창·분리 상태": { main: "none", browser: "openBrowser", toggle: "openBrowser" },
  "메인 창·도킹·브라우저 탭": { main: "centerMain", browser: "centerBrowser", toggle: "centerMain" },
  "메인 창·도킹·파일 탭": { main: "none", browser: "centerBrowser", toggle: "centerBrowser" },
  "메인 창·도킹·빈 센터": { main: "none", browser: "centerBrowser", toggle: "centerBrowser" },
  "스페이스 브라우저 창": { main: "focusConsole", browser: "none", toggle: "focusConsole" },
  "공유 브라우저 창": { main: "focusConsole", browser: "openBrowser", toggle: "openBrowser" },
  "메모 창": { main: "none", browser: "none", toggle: "none" },
};

// 현재 스페이스 브라우저를 보고 있는가. 토글 방향이 여기서 정해진다.
const ON_BROWSER = {
  "메인 창·분리 상태": false,
  "메인 창·도킹·브라우저 탭": true,
  "메인 창·도킹·파일 탭": false,
  "메인 창·도킹·빈 센터": false,
  "스페이스 브라우저 창": true,
  "공유 브라우저 창": false,
  "메모 창": false,
};

export default async function run() {
console.log("[screen-switch] 메인 화면 ↔ 스페이스 브라우저");

const mod = await import(new URL("../../../web/js/core/screen-switch.js", import.meta.url).href);

await checkAsync("어디서 어느 키를 눌러도 갈 곳이 하나로 정해진다", async () => {
  const wrong = [];
  for (const [where, ctx] of Object.entries(WHERE)) {
    for (const target of ["main", "browser", "toggle"]) {
      const got = mod.planScreen(target, ctx);
      const want = TABLE[where][target];
      if (got !== want) wrong.push(`${where} + ${target}: ${want} 여야 하는데 ${got}`);
    }
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

await checkAsync("토글 방향은 지금 브라우저를 보고 있는지로 정해진다", async () => {
  const wrong = [];
  for (const [where, ctx] of Object.entries(WHERE)) {
    const got = mod.onSpaceBrowserIn(ctx);
    if (got !== ON_BROWSER[where]) wrong.push(`${where}: ${ON_BROWSER[where]} 여야 하는데 ${got}`);
  }
  // 토글은 그 판정을 사용한다. 보고 있으면 메인 쪽 계획, 아니면 브라우저 쪽 계획이다.
  for (const [where, ctx] of Object.entries(WHERE)) {
    if (ctx.memoMode) continue;
    const want = mod.planScreen(mod.onSpaceBrowserIn(ctx) ? "main" : "browser", ctx);
    if (mod.planScreen("toggle", ctx) !== want) wrong.push(`${where}: 토글이 판정을 따르지 않는다`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

// macOS 에서 ⌥1 은 e.key 가 "¡", ⌥2 는 "™" 다. key 로 판정하면 이 기능이 동작하지 않는다.
check("⌥숫자는 글자가 아니라 자리로 읽는다", () => {
  // 조합 선언은 표에 있다. code 로 적혀 있어야 하고, 표를 읽는 판정도 code 를 봐야 한다.
  const km = readSrc("web/js/core/keymap.js");
  return /def: \{ alt: true, code: "Digit1" \}/.test(km)
    && /def: \{ alt: true, code: "Digit2" \}/.test(km)
    && /if \(b\.code\) return String\(ev\.code \|\| ""\) === b\.code/.test(km)
    && !/e\.key\s*===\s*"[12]"/.test(KEYNAV);
});

const platforms = ["darwin", "win32"];
const keymapFor = (platform) => runInNewContext(
  readSrc("web/js/core/keymap.js").replace(/^import[^\n]*;$/gm, "").replace(/\bexport /g, "")
    + "\n({ bindingOf, matchBinding });",
  { isHostWindows: () => platform === "win32" },
);
const keynavFor = (platform, km) => {
  const listeners = [], actions = [];
  const ctx = { isHostWindows: () => platform === "win32", ...km,
    document: { addEventListener: (_name, fn) => listeners.push(fn) },
    isAgentRenaming: () => false, currentSwitcherState: () => ({}),
    gotoMainScreen: () => actions.push("main"), gotoSpaceBrowser: () => actions.push("browser"),
    runSwitcherKey: (dir) => { actions.push(dir); return "step"; },
  };
  runInNewContext(keynav.replace(/^import[\s\S]*?from "[^"\n]+";$/gm, "").replace(/\bexport /g, "")
    + "\ninitKeynav({ MEMO_MODE: false });", ctx);
  if (listeners.length < 2) cannotMeasure("화면 이동 키 리스너를 찾지 못했다");
  return (event) => {
    actions.length = 0;
    listeners[1]({ preventDefault() {}, stopPropagation() {}, ...event });
    return [...actions];
  };
};

check("⌥1·⌥2는 수식키가 더 붙으면 아니다", () => {
  for (const platform of platforms) {
    const km = keymapFor(platform), press = keynavFor(platform, km);
    for (const [code, key, target] of [["Digit1", "¡", "main"], ["Digit2", "™", "browser"]]) {
      const event = { code, key, altKey: true };
      if (press(event).join() !== target) throw new Error(`${platform} ${code}: 이동하지 않았다`);
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey"])
        if (press({ ...event, [modifier]: true }).length) throw new Error(`${platform} ${code}+${modifier}: 이동했다`);
    }
  }
  return true;
});

check("⌥Tab에 Shift가 붙으면 이전 창이다", () => {
  for (const platform of platforms) {
    const km = keymapFor(platform), press = keynavFor(platform, km);
    const event = platform === "win32" ? { code: "Backquote", key: "`", ctrlKey: true }
      : { code: "Tab", key: "Tab", altKey: true };
    if (!km.matchBinding(event, km.bindingOf("screen-toggle")) || press(event).join() !== "1")
      throw new Error(`${platform}: 다음 창 키가 틀렸다`);
    if (!km.matchBinding({ ...event, shiftKey: true }, km.bindingOf("screen-toggle-back"))
      || press({ ...event, shiftKey: true }).join() !== "-1") throw new Error(`${platform}: 이전 창 키가 틀렸다`);
    const other = platform === "win32" ? { code: "Tab", altKey: true } : { code: "Backquote", ctrlKey: true };
    if (press(other).length) throw new Error(`${platform}: 다른 플랫폼의 창 이동 키를 소비했다`);
  }
  return true;
});

check("webview 포커스에서도 네 키가 중계된다", () => {
  for (const platform of platforms) {
    const module = { exports: {} }, handlers = new Map(), guestHandlers = new Map(), sent = [];
    runInNewContext(mainWindowSource, { module, process: { platform } });
    const owner = { isDestroyed: () => false, webContents: { send: (channel, name) => sent.push([channel, name]) } };
    module.exports.createMainWindow({ app: { on: (name, fn) => handlers.set(name, fn) },
      BrowserWindow: { fromWebContents: () => owner } });
    handlers.get("web-contents-created")({}, { getType: () => "webview", on: (name, fn) => guestHandlers.set(name, fn) });
    const listener = guestHandlers.get("before-input-event");
    if (!listener) throw new Error(`${platform}: webview 중계가 연결되지 않았다`);
    const toggle = platform === "win32" ? { control: true, code: "Backquote", key: "`" } : { alt: true, code: "Tab", key: "Tab" };
    for (const [id, input] of [["screen-toggle", toggle], ["screen-toggle-back", { ...toggle, shift: true }],
      ["screen-main", { alt: true, code: "Digit1", key: "¡" }], ["screen-browser", { alt: true, code: "Digit2", key: "™" }]]) {
      sent.length = 0;
      let prevented = 0;
      listener({ preventDefault: () => prevented++ }, { type: "keyDown", ...input });
      if (sent.length !== 1 || sent[0][0] !== "ac-shortcut" || sent[0][1] !== id || prevented !== 1)
        throw new Error(`${platform} ${id}: 소유 창으로 한 번 중계하지 않았다`);
      for (const bad of [{ ...input, code: "WrongCode" }, { ...input, alt: !input.alt },
        { ...input, shift: !input.shift }, { ...input, control: true, alt: true }]) {
        sent.length = 0;
        listener({ preventDefault() {} }, { type: "keyDown", ...bad });
        if (sent.some(([, name]) => name === id)) throw new Error(`${platform} ${id}: 다른 조합도 중계했다`);
      }
    }
  }
  return true;
});

check("중계로 보내는 이름은 모두 받는 표에 있다", () => {
  // 이름은 두 곳에서 나온다. 중계 표(대부분)와, 표에서 제외돼 조건문으로 남은 몇 개를 모두 검사한다.
  const sent = new Set();
  const relay = /const DEFAULT_RELAY = \{([\s\S]*?)\n\};/.exec(MAIN_WINDOW);
  if (!relay) cannotMeasure("중계 표를 못 찾았다 — 세는 방식이 깨졌다");
  for (const m of relay[1].matchAll(/^\s*"([^"]+)":/gm)) sent.add(m[1]);
  for (const call of MAIN_WINDOW.matchAll(/(?<![.\w])send\(([^)]*)\)/g))
    for (const lit of call[1].matchAll(/"([^"]+)"/g)) sent.add(lit[1]);
  if (sent.size < 20) cannotMeasure(`중계 이름을 ${sent.size}개만 찾았다 — 세는 방식이 깨졌다`);
  const handled = new Set([...DOCK.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
  const orphan = [...sent].filter((n) => !handled.has(n));
  if (orphan.length) throw new Error(`받는 곳이 없는 중계 이름: ${orphan.join(", ")}`);
  return ["screen-toggle", "screen-toggle-back", "screen-main", "screen-browser"]
    .every((n) => sent.has(n) && handled.has(n));
});

// 도킹에서 센터를 옮기는 순서는 탭바 클릭과 같아야 한다. 다르면 렌더나 영속 중 하나가 빠진다.
check("도킹 전환은 탭바 클릭과 같은 순서를 쓴다", () =>
  /setActiveTab\(sp, tab \? tab\.id : null\);\s*\n\s*renderTabs\(\); showActiveTab\(\); persistFileTabs\(\);/.test(SWITCH)
  && /if \(tab && tab\.kind === "browser"\) bsMutate\(\{ op: "tab\.switch"/.test(SWITCH));

// 순서가 뒤집히면 사용자가 지정한 것과 반대로 동작한다. ⌥1 이 메인, ⌥2 가 브라우저다.
check("⌥1은 메인 화면, ⌥2는 스페이스 브라우저", () =>
  /if \(hit === "screen-main"\) gotoMainScreen\(\);\s*\n\s*else gotoSpaceBrowser\(\);/.test(KEYNAV));

check("중계된 네 이름도 같은 곳으로 간다", () =>
  /case "screen-toggle": runSwitcherKey\(1\);/.test(DOCK)
  && /case "screen-toggle-back": runSwitcherKey\(-1\);/.test(DOCK)
  && /case "screen-main": gotoMainScreen\(\);/.test(DOCK)
  && /case "screen-browser": gotoSpaceBrowser\(\);/.test(DOCK));

check("돌아올 자리를 기억한다", () => /lastMainTab\.set\(sp, cur\.id\)/.test(SWITCH));
}
