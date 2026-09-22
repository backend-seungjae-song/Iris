// 단축키 표. 무엇이 어디에 등록되어 있고 무엇을 바꿀 수 있는지를 담는다.
//
// 소유 범위
//   기본 바인딩 선언(KEYMAP)과 사용자가 바꾼 값(overrides), 그리고 키 하나에 대한 순수 판정
//   (일치하는가 matchBinding · 어떻게 표기하는가 formatBinding · 누른 키를 무엇으로 읽는가
//   bindingFromEvent · 겹치는가 findConflicts).
//
// 제공 API
//   KEYMAP · bindingOf(id) · setOverrides(map) · getOverrides() · resolvedKeymap() ·
//   matchBinding · formatBinding · bindingFromEvent · sameBinding · findConflicts · bindingKey · subscribeKeymap.
//
// 의존 대상
//   없다. DOM 도 서버도 참조하지 않고 이벤트 형태의 값과 바인딩 형태의 값만 다루므로,
//   창(ESM)과 검사(Node)가 같은 파일을 그대로 호출한다.
//
// 유지 조건
//   ⌘ 와 ⌃ 는 한 필드(mod)로 다룬다. Cmd↔Ctrl 를 맞바꾼 키보드 배치가 있어 코드 곳곳이 이미
//   둘을 함께 받는다. 여기서 분리하면 화면에 표시된 키와 실제 동작하는 키가 달라진다. 둘을
//   실제로 구분해야 하는 항목(⌃W 와 ⌘W)은 lock 으로 표에서 제외했다.
//   숫자·Tab 은 key 가 아니라 code 로 판정한다. macOS 에서 ⌥1 의 key 는 "¡" 다.
//   lock 이 붙은 항목은 바꿀 수 없다. 그 키들은 포커스 위치에 따라 다른 동작을 하도록 구현돼
//   있어, 키만 교체하면 그 분기가 어긋난다. 이유를 lock 에 적어 화면에 표시한다.
//
// 영향 범위
//   core/keynav 의 판정, browser/dock 의 ac-shortcut 표, native/electron/main-window 의 중계
//   (그쪽은 이 표를 IPC 로 받는다), devtool/keymap-page 의 화면, 서버의 keymap 저장.
//   현재 목록 확인: node bin/importers.mjs web/js/core/keymap.js

// where 는 사용자에게 보여줄 맥락 설명이자 겹침 판정의 단위다. 같은 키라도 맥락이 다르면
// 실제로는 충돌하지 않는다. ⌘F 가 브라우저 탭에서만 페이지 찾기인 것이 그런 경우다.
export const ANYWHERE = "어디서나";
export const ON_BROWSER = "브라우저 탭";
export const ON_EDITOR = "편집기";
export const MAIN_WINDOW = "메인 창";

// def: { mod, alt, shift, key }, 키 위치로 판정할 항목은 { …, code }.
// mod = ⌘ 또는 ⌃(한 필드로 다룬다, 위 유지 조건 참조).
export const KEYMAP = [
  { id: "editor-minimap", label: "파일 미니맵", where: ON_EDITOR, def: { alt: true, code: "KeyM" } },
  { id: "editor-wrap", label: "줄바꿈", where: ON_EDITOR, def: { alt: true, code: "KeyZ" } },
  { id: "md-bold", label: "마크다운 볼드", where: ON_EDITOR, def: { mod: true, key: "b" } },
  { id: "md-italic", label: "마크다운 이탈릭", where: ON_EDITOR, def: { mod: true, key: "i" } },
  { id: "md-link", label: "마크다운 링크", where: ON_EDITOR, def: { mod: true, key: "k" } },
  { id: "md-strike", label: "마크다운 취소선", where: ON_EDITOR, def: { mod: true, shift: true, key: "x" } },
  { id: "md-code", label: "마크다운 코드", where: ON_EDITOR, def: { mod: true, shift: true, key: "c" } },
  { id: "md-codeblock", label: "마크다운 코드 블록", where: ON_EDITOR, def: { mod: true, shift: true, key: "b" } },
  { id: "md-list", label: "마크다운 목록", where: ON_EDITOR, def: { mod: true, shift: true, key: "u" } },
  { id: "md-check", label: "마크다운 체크 목록", where: ON_EDITOR, def: { mod: true, alt: true, key: "k" } },
  { id: "md-quote", label: "마크다운 인용", where: ON_EDITOR, def: { mod: true, alt: true, key: "q" } },
  { id: "screen-toggle", label: "다음 창 (고른 창이 없으면 메인 화면 ↔ 스페이스 브라우저)", where: ANYWHERE, def: { alt: true, code: "Tab" } },
  { id: "screen-toggle-back", label: "이전 창", where: ANYWHERE, def: { alt: true, shift: true, code: "Tab" } },
  { id: "screen-main", label: "메인 화면으로", where: ANYWHERE, def: { alt: true, code: "Digit1" } },
  { id: "screen-browser", label: "스페이스 브라우저로", where: ANYWHERE, def: { alt: true, code: "Digit2" } },
  { id: "tab-prev", label: "가운데 탭 이전", where: ANYWHERE, def: { alt: true, key: "ArrowLeft" } },
  { id: "tab-next", label: "가운데 탭 다음", where: ANYWHERE, def: { alt: true, key: "ArrowRight" } },
  { id: "agent-prev", label: "에이전트 이전", where: ANYWHERE, def: { alt: true, key: "ArrowUp" } },
  { id: "agent-next", label: "에이전트 다음", where: ANYWHERE, def: { alt: true, key: "ArrowDown" } },
  { id: "space-prev", label: "스페이스 이전", where: ANYWHERE, def: { alt: true, shift: true, key: "ArrowUp" } },
  { id: "space-next", label: "스페이스 다음", where: ANYWHERE, def: { alt: true, shift: true, key: "ArrowDown" } },
  { id: "rail-prev", label: "왼쪽 도구 페이지 이전", where: ANYWHERE, def: { mod: true, alt: true, key: "ArrowUp" } },
  { id: "rail-next", label: "왼쪽 도구 페이지 다음", where: ANYWHERE, def: { mod: true, alt: true, key: "ArrowDown" } },
  { id: "pick-toggle", label: "요소 지목 모드", where: ANYWHERE, def: { mod: true, shift: true, key: "e" } },
  { id: "sketch", label: "화면 스케치", where: ANYWHERE, def: { mod: true, shift: true, key: "d" } },
  { id: "detach", label: "브라우저 분리 / 도킹", where: ANYWHERE, def: { mod: true, shift: true, key: "o" } },
  { id: "rec-toggle", label: "화면 녹화 시작 / 종료", where: ON_BROWSER, def: { mod: true, shift: true, key: "a" } },
  { id: "memo-archive", label: "메모 오늘 자 보관", where: ANYWHERE, def: { mod: true, shift: true, key: "s" } },
  { id: "file-search", label: "파일 검색", where: ANYWHERE, def: { mod: true, shift: true, key: "p" } },
  { id: "new-tab", label: "새 탭", where: ANYWHERE, def: { mod: true, key: "t" } },
  { id: "reopen-tab", label: "닫은 탭 되살리기", where: ANYWHERE, def: { mod: true, shift: true, key: "t" } },
  { id: "new-tab-alt", label: "새 탭(대체 조합)", where: ANYWHERE, def: { alt: true, shift: true, key: "t" },
    lock: "새 탭의 두 번째 자리라 따로 바꾸지 않습니다. 위의 새 탭을 바꾸세요." },
  { id: "find-in-page", label: "페이지에서 찾기", where: ON_BROWSER, def: { mod: true, key: "f" } },
  { id: "find-next", label: "다음 찾기", where: ON_BROWSER, def: { mod: true, key: "g" } },
  { id: "find-prev", label: "이전 찾기", where: ON_BROWSER, def: { mod: true, shift: true, key: "g" } },
  { id: "focus-url", label: "주소창으로", where: ON_BROWSER, def: { mod: true, key: "l" } },
  { id: "nav-back", label: "뒤로", where: ON_BROWSER, def: { mod: true, key: "[" } },
  { id: "nav-forward", label: "앞으로", where: ON_BROWSER, def: { mod: true, key: "]" } },
  { id: "print-page", label: "인쇄", where: ON_BROWSER, def: { mod: true, key: "p" } },
  { id: "devtools", label: "개발자 도구", where: ON_BROWSER, def: { key: "F12" } },

  // 아래는 잠긴 항목이다. 목록에는 보이되 바꿀 수 없다. 같은 키가 포커스에 따라 다른 동작을
  // 하도록 구현돼 있어 키만 교체하면 그 분기가 어긋난다. 이유는 화면에 그대로 표시한다.
  { id: "reload-tab", label: "페이지 새로고침", where: ON_BROWSER, def: { mod: true, key: "r" },
    lock: "같은 ⌘R 이 터미널 포커스에선 이름 변경이고, 메인 창에선 도킹된 브라우저 탭일 때만 새로고침입니다." },
  { id: "force-reload-tab", label: "강제 새로고침", where: ON_BROWSER, def: { mod: true, shift: true, key: "r" },
    lock: "메인 창에서 같은 ⌘⇧R 이 앱 전체 재로딩입니다. 창에 따라 뜻이 갈립니다." },
  { id: "rename", label: "이름 변경", where: MAIN_WINDOW, def: { mod: true, shift: true, key: "r" },
    lock: "⌃⇧R 은 브라우저 하드리로드를 가로챈 자리라 조합이 고정입니다." },
  { id: "close-tab", label: "탭 닫기", where: ANYWHERE, def: { mod: true, key: "w" },
    lock: "⌃W 와 ⌘W 가 서로 다른 탭을 닫고, 터미널 포커스에선 셸의 단어 삭제라 양보합니다." },
  { id: "save-file", label: "파일 저장", where: ON_EDITOR, def: { mod: true, key: "s" },
    lock: "⌘⇧S(메모 보관)와 한 글자 차이라, 바꾸면 둘 중 하나가 조용히 먹힙니다." },
  { id: "zoom-in", label: "확대", where: ON_BROWSER, def: { mod: true, key: "=" },
    lock: "확대·축소·원복은 셋이 한 벌이고 네이티브 zoom 단계와 묶여 있습니다." },
  { id: "zoom-out", label: "축소", where: ON_BROWSER, def: { mod: true, key: "-" }, lock: "확대와 한 벌입니다." },
  { id: "zoom-reset", label: "확대 원복", where: ON_BROWSER, def: { mod: true, key: "0" }, lock: "확대와 한 벌입니다." },
];

const BY_ID = new Map(KEYMAP.map((x) => [x.id, x]));
const subscribers = new Set();

export function subscribeKeymap(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
let overrides = {};   // id → binding. 서버가 정본이고 여기 사본을 둔다.

export function setOverrides(map) {
  const next = {};
  if (map && typeof map === "object") {
    for (const [id, b] of Object.entries(map)) {
      const item = BY_ID.get(id);
      // 잠긴 항목의 override 는 받지 않는다. 저장돼 있더라도 여기서 걸러야 표에서 항목을 새로
      // 잠갔을 때 이전 저장분이 다시 적용되지 않는다.
      if (!item || item.lock) continue;
      const nb = normalizeBinding(b);
      if (nb) next[id] = nb;
    }
  }
  overrides = next;
  for (const subscriber of subscribers) subscriber();
}

export function getOverrides() { return { ...overrides }; }

export function normalizeBinding(b) {
  if (!b || typeof b !== "object") return null;
  const out = { mod: !!b.mod, alt: !!b.alt, shift: !!b.shift };
  if (b.code) { out.code = String(b.code); return out; }
  if (!b.key) return null;
  out.key = String(b.key);
  // 한 글자 키는 소문자로 통일한다. 그래야 shift 여부와 글자 대소문자가 서로 간섭하지 않는다.
  if (out.key.length === 1) out.key = out.key.toLowerCase();
  if (out.alt && /^[a-z]$/.test(out.key)) {
    out.code = `Key${out.key.toUpperCase()}`;
    delete out.key;
  }
  return out;
}

export function bindingOf(id) {
  const item = BY_ID.get(id);
  if (!item) return null;
  if (!item.lock && overrides[id]) return overrides[id];
  return normalizeBinding(item.def);
}

// 화면과 검사가 함께 쓰는 결과다. 현재 적용되는 조합과 기본값에서 바뀌었는지를 함께 준다.
export function resolvedKeymap() {
  return KEYMAP.map((item) => {
    const def = normalizeBinding(item.def);
    const cur = bindingOf(item.id);
    return { ...item, def, binding: cur, changed: !sameBinding(def, cur) };
  });
}

export function matchBinding(ev, b) {
  if (!ev || !b) return false;
  // ⌘ 와 ⌃ 는 한 필드로 다룬다(위 유지 조건).
  if (!!(ev.metaKey || ev.ctrlKey) !== !!b.mod) return false;
  if (!!ev.altKey !== !!b.alt) return false;
  if (!!ev.shiftKey !== !!b.shift) return false;
  if (b.code) return String(ev.code || "") === b.code;
  const k = String(ev.key || "");
  if (!k) return false;
  return k.length === 1 ? k.toLowerCase() === String(b.key).toLowerCase() : k === b.key;
}

// 누른 키를 그대로 바인딩으로 읽는다. 수식키만 눌린 상태는 아직 조합이 아니다. 그때 확정하면
// 사용자가 ⌘ 를 누르는 순간 ⌘ 하나가 저장된다.
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock"]);
export function bindingFromEvent(ev) {
  if (!ev) return null;
  const k = String(ev.key || "");
  if (!k || MODIFIER_KEYS.has(k)) return null;
  const code = String(ev.code || "");
  // 숫자와 Tab 은 키 위치로 판정한다. ⌥ 를 함께 누르면 key 값이 달라진다(⌥1 = "¡").
  const byCode = code === "Tab" || /^Digit[0-9]$/.test(code) || (ev.altKey && /^Key[A-Z]$/.test(code));
  const b = { mod: !!(ev.metaKey || ev.ctrlKey), alt: !!ev.altKey, shift: !!ev.shiftKey };
  if (byCode) b.code = code; else b.key = k.length === 1 ? k.toLowerCase() : k;
  return b;
}

export function sameBinding(a, b) {
  if (!a || !b) return a === b;
  a = normalizeBinding(a); b = normalizeBinding(b);
  return !!a.mod === !!b.mod && !!a.alt === !!b.alt && !!a.shift === !!b.shift
    && (a.code || "") === (b.code || "")
    && String(a.key || "").toLowerCase() === String(b.key || "").toLowerCase();
}

// 같은 조합인지 비교하는 키. 겹침 판정이 이 값으로 묶는다.
export function bindingKey(b) {
  if (!b) return "";
  b = normalizeBinding(b);
  const what = b.code ? "@" + b.code : String(b.key || "").toLowerCase();
  return (b.mod ? "M" : "") + (b.alt ? "A" : "") + (b.shift ? "S" : "") + "-" + what;
}

const ARROW_GLYPH = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
const CODE_GLYPH = { Tab: "Tab", Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9" };

export function formatBinding(b) {
  if (!b) return "";
  let out = "";
  if (b.mod) out += "⌘";
  if (b.alt) out += "⌥";
  if (b.shift) out += "⇧";
  if (b.code) return out + (CODE_GLYPH[b.code] || (/^Key[A-Z]$/.test(b.code) ? b.code.slice(3) : b.code));
  const k = String(b.key || "");
  if (ARROW_GLYPH[k]) return out + ARROW_GLYPH[k];
  return out + (k.length === 1 ? k.toUpperCase() : k);
}

// 같은 조합에 둘 이상이 걸린 항목을 찾는다. 맥락이 겹칠 때만 실제 충돌이고, 맥락이 다르면
// 서로 다른 순간에 적용된다(⌘F 는 브라우저 탭에서만 페이지 찾기다). 둘을 구분하지 않으면
// 정상인 배치가 충돌로 표시되고 그 경고는 곧 무시된다.
export function findConflicts(list) {
  const byKey = new Map();
  for (const item of (list || [])) {
    const k = bindingKey(item.binding);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(item);
  }
  const out = [];
  for (const [k, items] of byKey) {
    if (items.length < 2) continue;
    const wheres = new Set(items.map((x) => x.where));
    const overlaps = wheres.size === 1 || wheres.has(ANYWHERE);
    out.push({ key: k, keys: formatBinding(items[0].binding), ids: items.map((x) => x.id), overlaps });
  }
  return out;
}
