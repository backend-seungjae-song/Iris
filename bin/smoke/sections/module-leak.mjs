// 소유 범위: 모듈을 분리할 때 호출부만 남는 사고를 잡는 검사. 어떤 파일이 부르는
//   이름이 그 파일 어디에도 바인딩되지 않고 전역도 아니면, 그 줄은 호출 시점에
//   ReferenceError 가 되고 화면에는 아무 일도 일어나지 않은 것처럼 보인다. 분리
//   브라우저 창에서 탭·그룹을 지목해도 채팅에 아무것도 붙지 않은 사고가 있었고, 원인은
//   main 이 옮겨간 deliver*PickLocal 셋의 호출부만 들고 있던 것이었다.
// 제공 API: 러너가 한 번 부르는 기본 run, 그리고 재사용 가능한 strip·localNames·
//   unboundCalls·scannedModules.
// 의존 대상: core 의 check·read·sourceFiles. 파서 대신 한 번에 훑는 작은
//   렉서로 주석·문자열·템플릿·정규식을 제거한 뒤, 선언·매개변수·import 에서 이 파일에
//   바인딩된 이름을 모은다.
// 유지 조건: 이 검사는 넉넉한 쪽(못 잡는 쪽)으로 틀려야 한다. 바인딩 수집이 과하면
//   진짜 누수를 놓치고, 모자라면 정상 파일이 실패해 무관한 작업을 막는다. 후자가
//   훨씬 비싸다. 그래서 GLOBALS 는 넉넉히 두고, 애매하면 통과시킨다.
//   검사 목록에서 최상위 파일을 빠뜨리면 안 된다. 처음 이 검사를 만들 때 'web/js/**/*.js' 로
//   검사했는데 그 패턴은 최상위 main.js 를 제외했고, 누수가 거기 있어서 검사가 그대로
//   통과했다. 그래서 세 최상위 파일의 존재를 별도로 검사한다.
// 영향 범위: web/js · server · native/electron 전부. 모듈을 분리할 때마다 이 검사가
//   먼저 실패한다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/module-leak.mjs
import { check, read, sourceFiles } from "../core.mjs";

const ID = /[A-Za-z_$][\w$]*/g;
const addAll = (set, text) => { for (const m of text.matchAll(ID)) set.add(m[0]); };

// 언어 키워드와 실행 환경이 이미 주는 이름. 여기 있는 것은 "안 묶였어도 괜찮다".
// 모자라면 정상 파일이 실패하므로 넉넉하게 둔다.
const GLOBALS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "await", "async", "function",
  "import", "super",
  "var", "let", "const", "new", "delete", "void", "in", "of", "do", "else", "throw", "yield",
  "Array", "Object", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "JSON", "Math", "Error",
  "TypeError", "RangeError", "Intl", "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array",
  "Float32Array", "Float64Array", "ArrayBuffer", "DataView", "TextEncoder", "TextDecoder",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "structuredClone", "queueMicrotask", "atob", "btoa", "fetch",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "window", "document", "navigator", "location", "history", "screen", "console",
  "alert", "confirm", "prompt", "getComputedStyle", "matchMedia", "getSelection", "scrollTo",
  "addEventListener", "removeEventListener", "dispatchEvent", "postMessage", "open", "close",
  "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "Headers", "Request",
  "Response", "WebSocket", "EventSource", "AbortController", "Image", "Audio", "Worker",
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "DragEvent",
  "InputEvent", "ClipboardEvent", "WheelEvent", "Node", "Element", "HTMLElement", "Range",
  "DOMParser", "XMLSerializer", "CSS", "Notification", "ClipboardItem", "Option",
  "localStorage", "sessionStorage", "indexedDB", "crypto", "performance", "globalThis",
  "Terminal", "monaco",   // 스크립트 태그로 먼저 들어오는 벤더 전역
  "require", "module", "exports", "process", "Buffer", "setImmediate",
  "clearImmediate", "super", "__dirname", "__filename",   // 서버·네이티브(CJS) 쪽 전역
]);

// 한 번에 훑는 렉서. 주석·문자열·템플릿·정규식을 공백으로 지운다. 이 넷을 정규식 여러 벌로
// 따로 지우면 서로의 경계가 어긋난다. 주석 안의 따옴표 하나가 그다음 문자열 짝을 깨뜨리고,
// `/^localhost(:\d+)?/` 같은 정규식이 localhost() 호출로 읽힌다.
// 템플릿은 중첩된다. `${g ? `<b>${g}</b>` : ""}` 처럼 안쪽에 또 템플릿이 있으면, 바깥을
// 첫 백틱에서 끊는 스캐너는 그 지점부터 파일 끝까지 어긋난다. tree.js 가 그렇게 전체가
// 지워져 그 안의 함수 정의가 없는 이름으로 잡혔다. 그래서 스택으로 센다.
export function strip(src) {
  const out = [];
  const stack = [];               // {t:"tpl"} 템플릿 본문 · {t:"interp", d} 그 안의 ${ }
  let i = 0, prev = "";
  const top = () => stack[stack.length - 1];
  const inTemplate = () => !!top() && top().t === "tpl";
  const push = (ch) => { out.push(ch); if (!/\s/.test(ch)) prev = ch; };
  const blank = (n) => { for (let k = 0; k < n; k++) out.push(" "); };
  // `/` 앞에 값이 오면 나눗셈, 연산자·키워드가 오면 정규식이다.
  const regexAllowed = () => {
    if (!prev) return true;
    if ("(,=:[!&|?{};+-*%~^<>".includes(prev)) return true;
    const tail = out.join("").match(/([A-Za-z_$][\w$]*)\s*$/);
    return !!(tail && ["return", "typeof", "case", "in", "of", "delete", "void", "instanceof", "new", "do", "else", "yield", "await"].includes(tail[1]));
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (inTemplate()) {
      if (c === "\\") { blank(2); i += 2; continue; }
      if (c === "`") { blank(1); i++; stack.pop(); prev = "`"; continue; }
      if (c === "$" && d === "{") { blank(2); i += 2; stack.push({ t: "interp", d: 0 }); prev = "("; continue; }
      out.push(c === "\n" ? "\n" : " "); i++; continue;
    }
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const j = e < 0 ? src.length : e; blank(j - i); i = j; continue; }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2); const j = e < 0 ? src.length : e + 2;
      for (let k = i; k < j; k++) out.push(src[k] === "\n" ? "\n" : " ");
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === c) { j++; break; }
      }
      blank(j - i); prev = '"'; i = j; continue;
    }
    if (c === "`") { blank(1); i++; stack.push({ t: "tpl" }); continue; }
    if (c === "{" && top() && top().t === "interp") { top().d++; push(c); i++; continue; }
    if (c === "}" && top() && top().t === "interp") {
      if (top().d === 0) { blank(1); i++; stack.pop(); prev = ")"; continue; }
      top().d--; push(c); i++; continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1, cls = false, ok = false;
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) { j++; ok = true; break; }
      }
      if (ok) { while (j < src.length && /[a-z]/.test(src[j])) j++; blank(j - i); prev = "/"; i = j; continue; }
    }
    push(c); i++;
  }
  return out.join("");
}

// 바인딩 목록 하나(선언문의 declarator 들, 또는 매개변수 목록)에서 *이름* 만 모은다.
// `=` 오른쪽은 값이지 이름이 아니고(`const block = noticeBlock(...)`), 구조분해는 안으로
// 들어가야 한다(`({ app, log = console.log, now = () => new Date() } = {})`). 이 둘 중
// 하나만 빠져도 멀쩡한 이름이 "없는 이름"이 되거나, 값 쪽 이름이 이 파일 것으로 세어져
// 진짜 누수를 놓친다.
function addBindings(text, set) {
  let d = 0, cur = "";
  const parts = [];
  for (const c of text) {
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (c === "," && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  for (const part of parts) {
    let dd = 0, cut = -1;
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      if ("([{".includes(c)) dd++;
      else if (")]}".includes(c)) dd--;
      else if (c === "=" && dd === 0 && part[i + 1] !== "=" && !"=!<>".includes(part[i - 1] || "")) { cut = i; break; }
    }
    let bind = (cut >= 0 ? part.slice(0, cut) : part).trim();
    const colon = bind.indexOf(":");
    if (colon >= 0 && !bind.startsWith("{") && !bind.startsWith("[")) bind = bind.slice(colon + 1).trim();
    const inner = bind.match(/^[{[]([\s\S]*)[\]}]$/);
    if (inner) addBindings(inner[1], set);
    else addAll(set, bind);
  }
}

// const·let·var 한 문장의 declarator 목록을 떼어 낸다.
function collectDeclarators(s, set) {
  for (const m of s.matchAll(/\b(?:const|let|var)\s/g)) {
    let depth = 0, j = m.index + m[0].length;
    const from = j;
    for (; j < s.length && j < from + 4000; j++) {
      const c = s[j];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ";" && depth === 0) break;
    }
    addBindings(s.slice(from, j), set);
  }
}

// 매개변수. 괄호를 짝으로 세어 안쪽까지 들어간다. 기본값에 또 괄호가 있는 형태가 흔하고,
// 한 겹만 보는 정규식은 그 함수의 매개변수를 전부 놓친다.
function collectParams(s, set) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "(") continue;
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") { depth--; if (!depth) break; }
    }
    if (j >= s.length) break;
    const after = s.slice(j + 1, j + 4).trimStart();
    if (!after.startsWith("=>") && !after.startsWith("{")) continue;
    addBindings(s.slice(i + 1, j), set);
  }
}

// 이 파일 안에서 이름이 바인딩되는 위치 전부.
export function localNames(s) {
  const set = new Set();
  for (const m of s.matchAll(/\bimport\s[^;]*?from\s/gs)) addAll(set, m[0]);
  for (const m of s.matchAll(/\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  collectDeclarators(s, set);
  collectParams(s, set);
  for (const m of s.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) set.add(m[1]);
  for (const m of s.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  // 객체 메서드 축약(`provideLinks(y, cb) {`)은 정의다. 호출로 세면 없는 이름이 된다.
  for (const m of s.matchAll(/([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) set.add(m[1]);
  return set;
}

// 분리한 세 런타임 전부. 모듈을 분리한 대상이 이 셋이므로 셋을 다 본다.
// sourceFiles("web")는 index.html·css 도 주므로 .js 만 남긴다.
export function scannedModules() {
  return [
    ...sourceFiles("web").filter((rel) => rel.startsWith("web/js/") && rel.endsWith(".js")),
    ...sourceFiles("server").filter((rel) => /\.(?:js|mjs|cjs)$/.test(rel)),
    ...sourceFiles("native").filter((rel) => /\.(?:js|mjs|cjs)$/.test(rel)),
  ];
}

// 이 파일 어디에도 안 묶인 채 불리는 이름. 전역이 아니면 부르는 순간 ReferenceError 다.
export function unboundCalls(sources) {
  const files = sources || new Map(scannedModules().map((f) => [f, read(f)]));
  const out = [];
  for (const [f, raw] of files) {
    const s = strip(raw);
    const local = localNames(s);
    for (const m of s.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[2];
      if (local.has(n) || GLOBALS.has(n)) continue;
      out.push(`${f} → ${n}()`);
    }
  }
  return [...new Set(out)];
}

export default async function run() {
console.log("[module-leak] 갈라낸 자리에 호출부만 남지 않았는가");

check("훑는 목록에 세 런타임의 최상위 모듈이 다 있다", () => {
  const mods = scannedModules();
  const missing = ["web/js/main.js", "server/index.js", "native/electron/main.cjs"].filter((f) => !mods.includes(f));
  if (missing.length) throw new Error("빠짐: " + missing.join(", "));
  return mods.length > 140;
});

check("어느 모듈도 안 묶인 이름을 부르지 않는다", () => {
  const leaks = unboundCalls();
  if (leaks.length) throw new Error(leaks.join(" · ").slice(0, 300));
  return true;
});

// 이 검사가 실제로 위반을 감지하는지 확인한다. 감지하지 못하는 검사는 통과해도 의미가 없다.
// 이 저장소에서 실제로 났던 형태를 그대로 넣는다. 옮겨간 함수의 호출부만 남은 파일이다.
check("옮겨간 함수의 호출부만 남으면 그 자리를 짚어낸다", () => {
  const leaked = [["t.js", 'import { initPickHost } from "./p.js";\ninitPickHost();\nfunction h(m) { deliverTabPickLocal(m.tab); }\n']];
  const clean = [["t.js", 'import { deliverTabPickLocal, initPickHost } from "./p.js";\ninitPickHost();\nfunction h(m) { deliverTabPickLocal(m.tab); }\n']];
  return unboundCalls(new Map(leaked)).length === 1 && unboundCalls(new Map(clean)).length === 0;
});

// 렉서가 잘못 동작하면 없는 이름이 생겨 무관한 작업이 막힌다. 실제로 걸렸던 두 형태를 고정한다.
check("정규식·주석 안의 글자를 호출로 읽지 않는다", () => {
  const src = [["t.js", 'const u = "x";\nif (/^localhost(:\\d+)?/.test(u)) f();\n// wired" 라고 적힌 주석 안의 rotate() 도 아니다\nfunction f() {}\n']];
  return unboundCalls(new Map(src)).length === 0;
});
}
