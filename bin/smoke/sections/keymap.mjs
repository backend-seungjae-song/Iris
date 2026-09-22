// 소유 범위: 단축키 표. 판정 전수, 두 벌인 표가 갈라지지 않는가, 화면·저장 연결.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구, sources 의 공유 소스, web/js/core/keymap.js 의 순수
//   판정. DOM 도 서버도 모르므로 Node 에서 그대로 부른다.
// 유지 조건: 표가 두 벌인 것(창 ESM · 메인 CJS)은 서로 부를 수 없어서다. 그 둘이
//   같은지 대조하는 검사가 이 파일의 핵심이다. 없으면 화면에 적힌 것과 페이지에서 동작하는
//   것이 달라진다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/keymap.mjs
import {
  cannotMeasure, check, checkAsync, read,
} from "../core.mjs";
import { css, keynav, mainJs, mainWindowSource, web } from "../sources.mjs";

export default async function run() {
const settingsView = read("web/js/devtool/settings-view.js");
console.log("[2h5] 단축키 표");

const km = await import(new URL("../../../web/js/core/keymap.js", import.meta.url).href);
const page = read("web/js/devtool/keymap-page.js");
const store = read("server/keymap-store.js");
const serverIndex = read("server/index.js");

// 창(ESM)과 메인 프로세스(CJS)는 서로 부를 수 없어 표가 두 벌이다. 갈라지면 화면에 적힌 것과
// 페이지에서 실제로 동작하는 것이 달라지고, 사용자가 가장 늦게 알아챈다.
check("중계 표의 기본값이 선언과 같다", () => {
  const src = /const DEFAULT_RELAY = \{([\s\S]*?)\n\};/.exec(mainWindowSource);
  if (!src) cannotMeasure("중계 표를 못 찾았다 — 세는 방식이 깨졌다");
  // 선언을 그대로 평가한다. 손으로 다시 적으면 그 사본이 세 번째 표가 된다.
  const relay = new Function("return {" + src[1] + "\n}")();
  const ids = Object.keys(relay);
  if (ids.length < 20) cannotMeasure(`중계 항목을 ${ids.length}개만 읽었다 — 세는 방식이 깨졌다`);
  const wrong = [];
  for (const id of ids) {
    const declared = km.KEYMAP.find((x) => x.id === id);
    if (!declared) { wrong.push(`${id}: 선언에 없다`); continue; }
    if (declared.lock) { wrong.push(`${id}: 잠근 것을 중계 표가 들고 있다`); continue; }
    if (!km.sameBinding(km.normalizeBinding(declared.def), km.normalizeBinding(relay[id]))) {
      wrong.push(`${id}: ${km.formatBinding(relay[id])} ≠ 선언 ${km.formatBinding(declared.def)}`);
    }
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

check("이전 창 기본값도 두 표가 같다", () => {
  const src = /const DEFAULT_RELAY = \{([\s\S]*?)\n\};/.exec(mainWindowSource);
  if (!src) cannotMeasure("중계 표를 못 찾았다 — 세는 방식이 깨졌다");
  const relay = new Function("return {" + src[1] + "\n}")();
  const declared = km.KEYMAP.find((item) => item.id === "screen-toggle-back");
  return !!declared && Object.prototype.hasOwnProperty.call(relay, "screen-toggle-back")
    && km.sameBinding(km.normalizeBinding(declared.def), km.normalizeBinding(relay["screen-toggle-back"]));
});

// 기본 배치가 이미 겹쳐 있으면 화면의 경고가 첫날부터 켜져 있고, 켜진 경고는 곧 안 보인다.
check("기본 배치에 같은 맥락 겹침이 없다", () => {
  const bad = km.findConflicts(km.resolvedKeymap()).filter((c) => c.overlaps);
  if (bad.length) throw new Error(bad.map((c) => `${c.keys}: ${c.ids.join(" · ")}`).join(" / "));
  return true;
});

// ⌘ 와 ⌃ 를 갈라 놓으면 Cmd 와 Ctrl 을 맞바꾼 키보드 배치에서 화면과 실제가 어긋난다.
await checkAsync("키 판정이 표대로다", async () => {
  const TABLE = [
    ["⌘F 는 페이지에서 찾기", { key: "f", metaKey: true }, "find-in-page", true],
    ["⌃F 도 같다(Cmd·Ctrl 은 한 자리)", { key: "f", ctrlKey: true }, "find-in-page", true],
    ["대문자로 와도 같다", { key: "F", metaKey: true }, "find-in-page", true],
    ["⌘⇧F 는 아니다", { key: "f", metaKey: true, shiftKey: true }, "find-in-page", false],
    ["⌘⌥F 도 아니다", { key: "f", metaKey: true, altKey: true }, "find-in-page", false],
    ["수식키 없는 F 는 아니다", { key: "f" }, "find-in-page", false],
    ["⌘⇧G 는 이전 찾기", { key: "g", metaKey: true, shiftKey: true }, "find-prev", true],
    ["⌘G 는 이전 찾기가 아니다", { key: "g", metaKey: true }, "find-prev", false],
    ["⌥1 은 자리로 읽는다(글자는 ¡)", { key: "¡", code: "Digit1", altKey: true }, "screen-main", true],
    ["⌥1 을 글자로 보면 안 맞는다", { key: "1", code: "", altKey: true }, "screen-main", false],
    ["F12 는 수식키가 붙으면 아니다", { key: "F12", metaKey: true }, "devtools", false],
    ["F12 단독", { key: "F12" }, "devtools", true],
    ["빈 이벤트", {}, "find-in-page", false],
  ];
  const wrong = [];
  for (const [name, ev, id, want] of TABLE) {
    const got = km.matchBinding(ev, km.bindingOf(id));
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

// 수식키만 눌린 상태에서 확정하면, 사용자가 ⌘ 를 누르는 순간 ⌘ 하나가 저장된다.
await checkAsync("누른 키를 무엇으로 읽는가", async () => {
  const TABLE = [
    ["⌘⇧T", { key: "T", code: "KeyT", metaKey: true, shiftKey: true }, "⌘⇧T"],
    ["⌥1 은 자리로", { key: "¡", code: "Digit1", altKey: true }, "⌥1"],
    ["⌥Tab 도 자리로", { key: "Tab", code: "Tab", altKey: true }, "⌥Tab"],
    ["화살표", { key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true }, "⌥⇧↑"],
    ["⌘ 만 눌린 것은 아직 조합이 아니다", { key: "Meta", metaKey: true }, null],
    ["⇧ 만", { key: "Shift", shiftKey: true }, null],
    ["빈 이벤트", {}, null],
  ];
  const wrong = [];
  for (const [name, ev, want] of TABLE) {
    const b = km.bindingFromEvent(ev);
    const got = b ? km.formatBinding(b) : null;
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

// 맥락이 다르면 같은 키라도 충돌하지 않는다. 둘을 한 덩어리로 세면 정상 배치가 실패로 잡히고,
// 그 경고는 곧 무시된다.
await checkAsync("겹침은 맥락까지 본다", async () => {
  const A = { mod: true, key: "k" };
  const TABLE = [
    ["같은 맥락이면 진짜 겹침", [{ id: "a", where: km.ON_BROWSER, binding: A }, { id: "b", where: km.ON_BROWSER, binding: A }], true],
    ["맥락이 다르면 안 겹친다", [{ id: "a", where: km.ON_BROWSER, binding: A }, { id: "b", where: km.ON_EDITOR, binding: A }], false],
    ["한쪽이 어디서나면 겹친다", [{ id: "a", where: km.ANYWHERE, binding: A }, { id: "b", where: km.ON_EDITOR, binding: A }], true],
  ];
  const wrong = [];
  for (const [name, list, want] of TABLE) {
    const got = km.findConflicts(list);
    const overlaps = got.length === 1 && got[0].overlaps === want;
    if (!overlaps) wrong.push(`${name}: ${JSON.stringify(got)} (기대 overlaps=${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  return true;
});

// 잠근 것에 저장분이 남아 있으면, 표를 고쳐 무언가를 잠근 날에 예전 값이 복원된다.
// 잠금은 두 겹이다. 받을 때(setOverrides)와 꺼낼 때(bindingOf)이고, 한쪽만 지워도 성질은
// 유지돼 이 검사는 통과한다(확인 결과). 이 검사는 어느 줄이 있는가가 아니라 성질이 성립하는지를
// 보고, 둘 다 지우면 실패한다. 한 줄만 지워도 실패하길 바라면 다른 검사가 필요하다.
await checkAsync("잠긴 항목은 바꿔치기되지 않는다", async () => {
  const before = km.formatBinding(km.bindingOf("close-tab"));
  km.setOverrides({ "close-tab": { mod: true, key: "q" }, "find-in-page": { mod: true, key: "j" } });
  const locked = km.formatBinding(km.bindingOf("close-tab"));
  const open = km.formatBinding(km.bindingOf("find-in-page"));
  km.setOverrides({});
  if (locked !== before) throw new Error(`잠긴 것이 바뀌었다: ${before} → ${locked}`);
  if (open !== "⌘J") throw new Error(`안 잠긴 것이 안 바뀌었다: ${open}`);
  return true;
});

// 창에서 바꾼 키가 메인 프로세스에 안 가면, 앱 UI 위에서만 먹고 페이지 위에서는 안 먹는다.
check("바꾼 표가 메인 프로세스까지 간다", () =>
  /acHost\.setKeymap\(getKeymapOverrides\(\)\)/.test(mainJs)
  && /setKeymap: \(map\) => ipcRenderer\.send\("ac-keymap", map\)/.test(read("native/electron/preload.cjs"))
  && /ipcMain\.on\("ac-keymap",\s*\(e, map\)\s*=>\s*\{[\s\S]{0,500}?setRelayKeymap\(map\);[\s\S]{0,200}?\n\}\);/
    .test(read("native/electron/main.cjs"))
  && /function setRelayKeymap\(map\)/.test(mainWindowSource));

// 저장이 서버에 없으면 창을 껐다 켤 때마다 되돌아간다.
check("바꾼 것은 서버가 들고 파일로 남긴다", () =>
  /export function setKeymapOverride\(id, binding\)/.test(store)
  && /fs\.renameSync\(tmp, p\)/.test(store)
  && /path\.join\(stateHome\(\), "keymap\.json"\)/.test(store)
  && /msg\.type === "keymap-set"[\s\S]{0,140}broadcast\(keymapWire\(\)\)/.test(serverIndex)
  && /msg\.type === "keymap-reset"[\s\S]{0,140}broadcast\(keymapWire\(\)\)/.test(serverIndex)
  && /"keymap": dispatchWs\(handleKeymapMessage\)/.test(mainJs));

// 원격에서 다른 사용자의 단축키를 바꾸면 안 된다. 다른 로컬 쓰기와 같은 경계다.
check("단축키 변경은 로컬에서만", () =>
  /msg\.type === "keymap-set"\) \{ if \(ws\._local &&/.test(serverIndex)
  && /msg\.type === "keymap-reset"\) \{ if \(ws\._local &&/.test(serverIndex));

// 새 조합을 받는 동안 그 키가 실제로 실행되면, ⌘⇧D 를 지정하려는 순간 창이 분리된다.
check("녹음 중에는 그 키가 실행되지 않는다", () => {
  const seg = /document\.addEventListener\("keydown", \(e\) => \{[\s\S]*?\}, true\);/.exec(page);
  if (!seg) throw new Error("녹음 핸들러를 못 찾음");
  return /if \(!recording\) return;/.test(seg[0])
    && /e\.preventDefault\(\);/.test(seg[0])
    && /e\.stopPropagation\(\);/.test(seg[0])
    && /\}, true\);$/.test(seg[0]);   // 캡처여야 keynav 의 캡처보다 앞선다
});

// 잠긴 것을 화면에서 누를 수 있으면 사용자는 바뀐 줄 안다.
// 그리는 쪽은 settings-view, 연결은 keymap-page 에 있으므로 둘을 함께 본다.
// 시작을 막는 쪽(page)과 아예 누를 것을 안 주는 쪽(view)이 둘 다 있어야 한다.
check("잠긴 항목은 녹음을 시작하지 않는다", () =>
  /if \(!item \|\| item\.lock\) return;/.test(page)
  && /data-km-rec/.test(settingsView) && /item\.lock\s*\n?\s*\?/.test(settingsView));

// 사본을 화면에서 고치면 다음 방송에 되돌아가 깜빡인다.
check("화면은 저장을 서버에 부탁만 한다", () =>
  /wsSend\(\{ type: "keymap-set", id, binding: b \}\)/.test(page)
  && /wsSend\(\{ type: "keymap-reset", id: reset\.dataset\.kmReset \}\)/.test(page)
  && !/setOverrides\(/.test(page));

check("화면이 rail 에 걸려 있고 DOM 이 있다", () =>
  /data-rail="keymap"/.test(web)
  && /id="km-panel"/.test(web) && /id="km-body"/.test(web) && /id="km-search"/.test(settingsView)
  && /keymap: \{ enter: enterKeymapPage \}/.test(mainJs)
  // 화면의 정적 사실은 rail.js 가 아니라 표가 갖는다. body class 도 거기서 온다.
  && /id: "keymap"[\s\S]{0,400}?body: "km-active"/.test(read("web/js/core/rail-items.js"))
  && /canDisable: false/.test(/id: "keymap"[\s\S]*?\n  \}/.exec(read("web/js/core/rail-items.js"))[0])
  && /for \(const f of RAIL_ITEMS\) if \(f\.body\) document\.body\.classList\.toggle\(f\.body, view === f\.id\);/
      .test(read("web/js/devtool/rail.js")));

await checkAsync("창 전환 목록은 진입과 다시 읽기에서만 새로 열거하고 revision은 host 목록만 읽는다", async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const root = { addEventListener(type, handler) { listeners[type] = handler; } };
  const body = { innerHTML: "", querySelector() { return null; } };
  const model = { windows: [], status: { listRevision: 0 } };
  let refreshes = 0;
  let reloads = 0;
  globalThis.document = { addEventListener() {} };
  globalThis.fetch = async (url, options = {}) => {
    if (url !== "/features" || (options.method || "GET") !== "GET") throw new Error(`예상하지 않은 요청: ${url}`);
    return { ok: true, status: 200, json: async () => ({ exists: true, revision: 1, hidden: [], local: true }) };
  };
  try {
    const mod = await import(new URL(`../../../web/js/devtool/keymap-page.js?재진입=${Date.now()}`, import.meta.url).href);
    mod.initKeymapPage({
      $: (selector) => selector === "#km-panel" ? root : selector === "#km-body" ? body : null,
      wsSend() {}, getRailScreens: () => [], getSwitcher: () => model,
      refreshWindows: async () => { refreshes += 1; },
      reloadWindows: async () => { reloads += 1; },
    });
    const windows = { dataset: { kmSec: "windows" } };
    listeners.click({ target: { closest: (selector) => selector === "[data-km-sec]" ? windows : null } });
    await Promise.resolve();
    assertCount(refreshes, 1, "분류 진입");

    mod.enterKeymapPage();
    await Promise.resolve();
    assertCount(refreshes, 2, "화면 재진입");

    listeners.click({ target: { closest: (selector) => selector === "#sw-refresh" ? {} : null } });
    await Promise.resolve();
    assertCount(refreshes, 3, "다시 읽기");

    model.status.listRevision = 1;
    mod.renderKeymapPage();
    await Promise.resolve();
    mod.renderKeymapPage();
    await Promise.resolve();
    assertCount(refreshes, 3, "revision 변경 뒤 새 열거");
    assertCount(reloads, 1, "revision 변경 뒤 host 목록 읽기");
    const freshWiring = /refreshWindows:\s*async \(\) => \{([\s\S]{0,300}?)\n\s*\},/.exec(mainJs);
    if (!freshWiring
        || !/await syncSwitcher\(\{ op: "list", refresh: true \}\);/.test(freshWiring[1])
        || !/return syncSwitcher\(\{ op: "media" \}\);/.test(freshWiring[1])) {
      throw new Error("새 열거 뒤 media를 직접 읽는 배선이 없다");
    }
    if (!/reloadWindows:\s*\(\)\s*=>\s*syncSwitcher\(\{ op: "list" \}\)/.test(mainJs)) {
      throw new Error("host 목록만 읽는 배선이 없다");
    }
    const reloadWiring = /reloadWindows:\s*\(\)\s*=>\s*([^\n]+)/.exec(mainJs);
    if (!reloadWiring || /media/.test(reloadWiring[1])) throw new Error("revision 경로가 media를 다시 읽는다");
    return true;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

function assertCount(got, want, place) {
  if (got !== want) throw new Error(`${place}: 목록 갱신 ${got}회, 기대 ${want}회`);
}

// rail 아이콘이 이모지가 되면 OS 버전마다 모양이 달라지고, 자체 색을 유지해 활성 상태가
// currentColor 를 따르지 않는다. 하나만 섞여도 그 줄만 크기가 어긋난다.
check("rail 아이콘은 전부 선 그림이다", () => {
  const rail = /<nav class="actrail"[\s\S]*?<\/nav>/.exec(web);
  if (!rail) throw new Error("rail 을 못 찾음");
  const buttons = rail[0].match(/<button\b[\s\S]*?<\/button>/g) || [];
  if (buttons.length < 9) cannotMeasure(`rail 버튼을 ${buttons.length}개만 찾았다 — 세는 방식이 깨졌다`);
  const noSvg = buttons.filter((b) => !/<svg viewBox="0 0 24 24"/.test(b));
  if (noSvg.length) throw new Error(`선 그림이 없는 버튼 ${noSvg.length}개`);
  // 이모지는 서러게이트 쌍이거나 기호다. 아이콘 위치에 남은 것이 있으면 잡는다.
  const icons = rail[0].match(/<span class="ri">[\s\S]*?<\/span>/g) || [];
  const emoji = icons.filter((x) => /[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u.test(x.replace(/<[^>]*>/g, "")));
  if (emoji.length) throw new Error(`아이콘 자리에 남은 이모지 ${emoji.length}개`);
  return /\.rail-ico \.ri svg \{[^}]*stroke:currentColor/.test(css("02-rail"));
});

// 조합을 화면이 따로 적기 시작하면 표와 갈라진다.
check("keynav 이 조합을 다시 적지 않는다", () =>
  /import \{ bindingOf, matchBinding \} from "\.\/keymap\.js";/.test(keynav)
  && !/e\.key === "\["/.test(keynav) && !/e\.key === "\]"/.test(keynav));
}
