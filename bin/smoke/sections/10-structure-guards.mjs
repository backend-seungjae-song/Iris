// 소유 범위: [0] 화면 카탈로그부터 [0.55g] 네이티브 도달성까지의 구조·셔틀·자기검사.
// 제공 API: 원래 [0] 자리에서 도달성 검사 직전까지 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스, slice-anchor와 Node 파일·경로 API.
// 유지 조건: 검사 이름·순서·문구, 자기검사 대상·경계 표식, 셔틀 범위, full smoke 출력.
// 영향 범위: 러너가 도달성 검사 직전에 호출하며, 뒤쪽 11 구조 섹션과 출력 순서가 이어진다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/10-structure-guards.mjs
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  cannotMeasure, check, checkAsync, filesUnder, read, readAll, ROOT, sourceFiles, WEB_SHUTTLE_EXCLUDES,
} from "../core.mjs";
import {
  allCss, browserWindowManagerSource, css, main, memoWindowManagerSource, rail, record, screenMarkup, web,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
const screenCatalog = JSON.parse(read("docs/iris-screens.json"));
const sequentialAudit = read("docs/iris-sequential-audit.md");

console.log("[0] 화면 카탈로그 — 모든 최상위 UI 진입점이 대주제에 속하는가");
// 자리 번호를 S01부터 연속으로 요구하면 화면을 가운데에 추가할 때 뒤 번호가 전부 밀리고,
// 두 사람이 같은 날 화면을 추가하면 같은 번호에서 충돌한다. 병렬 작업이 충돌하는 자리는
// 그곳 하나였다. 그래서 자리 번호 대신 이름을 키로 쓴다.
// 이름은 새로 짓지 않고 이미 있는 entry 를 그대로 쓴다. 이름이 둘이면 나중에 갈라진다.
// 이 검사는 그 이름이 키로 쓸 수 있는 형태인지 확인한다.
check("화면 이름이 열쇠로 쓸 수 있는 모양이다", () => {
  const names = (screenCatalog.screens || []).map((x) => x.entry);
  if (names.length < 10) cannotMeasure(`화면을 ${names.length} 개만 셌다 — 카탈로그를 못 읽었다`);
  if (new Set(names).size !== names.length) throw new Error("화면 이름이 겹친다 — 열쇠로 못 쓴다");
  const bad = names.filter((n) => !/^[a-z][a-z0-9-]*$/.test(n));
  if (bad.length) throw new Error("열쇠로 쓸 수 없는 이름: " + bad.join(", "));
  // 자리 번호가 남아 있으면 이름 기반 전환이 끝나지 않은 것이다.
  if (names.some((n) => /^S\d+$/.test(n))) throw new Error("아직 자리 번호를 쓰는 화면이 있다");
  return true;
});
check("rail 화면 집합은 화면 카탈로그와 정확히 같다", () => {
  const actual = [...web.matchAll(/<button\b[^>]*\bdata-rail="([^"]+)"/g)].map((m) => m[1]);
  const expected = screenCatalog.screens.filter((x) => x.kind === "rail").map((x) => x.entry);
  return actual.length === expected.length && actual.every((entry, i) => entry === expected[i]);
});
// 영역 이름의 출처는 셋이다. 마크업에 직접 적혀 있거나(앱 셸이 그리는 영역), rail 표가 그
// 이름을 제공하고 rail 이 그 표에서 요소를 만들거나, 가운데 화면
// 등록표가 이름을 제공하고 앱 셸이 #center-body 안에 만든다. 마크업만 보면 옮긴 영역이
// 없는 항목으로 잡힌다.
const { RAIL_ITEMS } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
const railPanelIds = new Set(RAIL_ITEMS.map((f) => f.panel).filter(Boolean));
// 가운데 화면은 기능이 registerTabView 로 등록한다. Node 에서는 아무도 등록하지 않으므로
// 소스에서 선언을 추출한다.
const tabViewPanelIds = new Set(
  sourceFiles("web").filter((f) => f.endsWith(".js"))
    .flatMap((f) => [...read(f).matchAll(/registerTabView\(\{[^}]*panelId:\s*"([^"]+)"/g)].map((m) => m[1])));
check("카탈로그의 화면·하위 표면 DOM이 모두 존재한다", () => {
  if (railPanelIds.size < 5) throw new Error(`rail 표에서 자리 이름을 ${railPanelIds.size} 개만 셌다`);
  if (tabViewPanelIds.size < 2) cannotMeasure(`가운데 지면 선언을 ${tabViewPanelIds.size} 개만 찾았다 — 훑개가 죽었다`);
  return screenCatalog.screens.every((screen) => [...(screen.rootIds || []), ...(screen.surfaceIds || [])]
    .every((id) => screenMarkup.includes(`id="${id}"`) || railPanelIds.has(id) || tabViewPanelIds.has(id)));
});
check("별도 Iris 브라우저 창 두 종류가 카탈로그와 정확히 같다", () => {
  const windows = screenCatalog.screens.filter((x) => x.kind === "browser-window");
  const native = readAll("native");
  return windows.length === 2
    && windows[0].entry === "space-browser" && windows[0].query === "?mode=browser"
    && windows[1].entry === "shared-browser" && windows[1].query === "?mode=browser&space=__shared__"
    && /function createBrowserModeWindow\(shared, opts\)/.test(browserWindowManagerSource)
    && /getAppUrl\(\) \+ "\/\?mode=browser" \+ \(shared \? "&space=" \+ encodeURIComponent\(SHARED_SPACE\) : ""\)/.test(native);
});
check("browser-window-manager가 main 조립부에 연결됨", () =>
  /const browserWindowManager = createBrowserWindowManager\(\{/.test(main)
  && /browserWindowManager\.createBrowserModeWindow\(false, opts\)/.test(main)
  && /browserWindowManager\.createBrowserModeWindow\(true\)/.test(main));
check("별도 Iris 메모 창 두 범위가 카탈로그와 정확히 같다", () => {
  const windows = screenCatalog.screens.filter((x) => x.kind === "memo-window");
  return windows.length === 2
    && windows[0].entry === "space-memo" && windows[0].query.includes("mode=memo&kind=local")
    && windows[1].entry === "shared-memo" && windows[1].query === "?mode=memo&kind=shared"
    && /function createMemoModeWindow\(input = \{\}\)/.test(memoWindowManagerSource)
    && /openLocalMemo/.test(read("native/electron/preload.cjs"))
    && /openSharedMemo/.test(read("native/electron/preload.cjs"));
});
check("memo-window-manager가 main 조립부에 연결됨", () =>
  /const memoWindowManager = createMemoWindowManager\(\{/.test(main)
  && /memoWindowManager\.registerMemoIpc\(\)/.test(main)
  && /memoWindowManager\.memoWindowSnapshot\(\)\.records/.test(main)
  && /memoWindowManager\.createMemoModeWindow\(record\)/.test(main));
// native 전체에서 계산한다. 창을 만드는 코드가 여러 모듈로 흩어져도(main-window ·
// browser-window-manager · memo-window-manager) 총 개수는 셋이어야 하고, 네 번째가
// 생기면 걸린다. main.cjs 만 보면 모듈을 옮긴 순간 0이 되어 검사가 무력해진다.
check("사용자 UI BrowserWindow 생성 지점은 메인·브라우저·메모 세 곳뿐이다", () => {
  // 두 종류를 각각 검사로 강제한다. 어느 쪽이 늘어도 실패하고, 메시지가 어느 쪽인지 알려 준다.
  // 한쪽만 계산하면 새 창이 다른 종류로 들어가 검사를 통과한다.
  const src = readAll("native");
  let ui = 0, offscreen = 0;
  for (const m of src.matchAll(/\bnew BrowserWindow\(/g)) {
    const opts = src.slice(m.index, m.index + 400);
    if (/offscreen:\s*true/.test(opts)) offscreen++; else ui++;
  }
  // offscreen 하나는 전체 캡처 타일을 canvas 로 이어 붙이는 보이지 않는 창이다(cdp-capture-tools).
  // 넷째는 탭 하나만 담는 창이다(detached-tab-window). 창 종류가 늘면 이 수를 직접 올리게
  // 하는 것이 이 검사의 목적이다. 창을 늘리는 것은 검토 없이 지나가면 안 되는 결정이다.
  if (ui !== 4) throw new Error(`사용자 UI 창 생성 ${ui}곳 — 메인·브라우저·메모·탭분리 넷이어야 한다`);
  if (offscreen !== 1) throw new Error(`보이지 않는 유틸 창 생성 ${offscreen}곳 — 타일 합성 하나뿐이어야 한다`);
  return true;
});
check("순차 점검표가 카탈로그의 모든 화면을 정확한 순서로 포함한다", () => {
  const expected = screenCatalog.screens.map((x) => x.entry);
  const actual = [...sequentialAudit.matchAll(/^## ([a-z][a-z0-9-]*)\s+/gm)].map((m) => m[1]);
  if (actual.length < 10) cannotMeasure(`점검표에서 화면 머리글을 ${actual.length} 개만 찾았다 — 세는 방식이 깨졌다`);
  return actual.length === expected.length && actual.every((id, i) => id === expected[i]);
});
// 항목 번호는 화면 이름에 붙는다(workspace-01). 화면을 가운데에 넣어도 다른 번호가 밀리지
// 않는다. 자리 번호를 버린 이유가 그것이므로, 여기서 그 형식이 지켜지는지 확인한다.
check("점검표 항목 번호가 화면 이름에 붙어 있다", () => {
  const items = [...sequentialAudit.matchAll(/\|\s*([a-z][a-z0-9-]*)-(\d{2})\s*\|/g)];
  if (items.length < 40) cannotMeasure(`항목을 ${items.length} 개만 찾았다 — 세는 방식이 깨졌다`);
  const names = new Set(screenCatalog.screens.map((x) => x.entry));
  const orphan = [...new Set(items.map((m) => m[1]))].filter((n) => !names.has(n));
  if (orphan.length) throw new Error("카탈로그에 없는 화면의 항목: " + orphan.join(", "));
  return true;
});
check("순차 점검표는 현재 점검 항목을 하나만 지정한다", () =>
  (sequentialAudit.match(/\|\s*점검 중\s*\|/g) || []).length === 1);

// 셔틀이 조용히 좁아지는 것을 막는다.
//
// readAll 은 모놀리스가 모듈로 쪼개져도 검사가 대상 텍스트를 잃지 않게 하는 장치다. 그런데
// 셔틀이 어떤 파일을 빠뜨려도 대부분의 검사는 실패하지 않는다. 긍정 단정은 실패하지만
// 부정 단정(`!/x/.test`)과 개수 기반 검사는 텍스트가 없으면 그대로 통과하기 때문이다.
//
// 확인 결과: server 셔틀을 index.js 하나로 줄여도 1071 ok / 0 fail 이 그대로였다.
// 지금은 대상 텍스트가 전부 index.js 안에 있어서 그렇고, 분할 뒤에는 같은 통과가 실제 구멍이 된다.
// 그래서 셔틀 자신을 검사한다. 디스크에 있는 소스가 하나라도 빠지면 여기서 걸린다.
// 모듈로 분리할 때 생기는 오류 하나를 검사로 강제한다.
//
// 최상위가 전부 function 선언이면 호이스팅되므로, 파일 한가운데 있는
// `const blog = …` 를 앞쪽 함수가 참조해도 실제 호출은 나중이라 문제가 없다.
// 그것을 모듈로 분리해 `initX({ blog })` 로 넘기면 값이 그 줄에서 평가된다.
// 선언이 아래에 있으면 TDZ 에 걸려 렌더러가 그 지점에서 중단된다.
//
// 확인 결과: initHandoff 가 blog 를 선언보다 먼저 평가해
// "Cannot access 'blog' before initialization" 으로 렌더러가 중단됐는데,
// smoke 1075 ok / 0 fail · node --check 통과 · pnpm test 전부 통과였다.
// 소스 모양 검사 셋이 모두 통과한 상태로 앱이 깨져 있었다. 그래서 이 검사를 둔다.
console.log("[0.4] 초기화 순서 — init 에 넘기는 값이 그 줄에서 이미 선언돼 있는가");
check("init 인자는 TDZ 를 밟지 않는다", () => {
  const src = read("web/js/main.js");
  const lines = src.split("\n");
  // const/let/class 는 TDZ 가 있다. function 선언과 var 는 호이스팅되고, import 는 최상단이다.
  const tdzDecl = new Map();
  lines.forEach((line, index) => {
    const m = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m && !tdzDecl.has(m[1])) tdzDecl.set(m[1], index);
  });
  const problems = [];
  lines.forEach((line, index) => {
    if (!/^\s*init[A-Z][\w$]*\s*\(/.test(line)) return;
    // 그 호출이 닫힐 때까지 모은다(대개 한두 줄, 길어야 대여섯 줄).
    let text = "", depth = 0, i = index;
    do {
      text += lines[i];
      for (const ch of lines[i]) { if (ch === "(") depth++; else if (ch === ")") depth--; }
      i++;
    } while (depth > 0 && i < lines.length && i - index < 40);
    for (const ident of new Set(text.match(/[A-Za-z_$][\w$]*/g) || [])) {
      const declaredAt = tdzDecl.get(ident);
      if (declaredAt !== undefined && declaredAt > index) {
        problems.push(`${ident}: ${index + 1}행에서 쓰고 ${declaredAt + 1}행에서 선언`);
      }
    }
  });
  if (problems.length) throw new Error(problems.join(" / "));
  return true;
});

console.log("[0.5] 셔틀 — 검사가 보는 소스가 디스크의 소스와 같은가");
for (const { area, root, accept, excludes = new Set() } of [
  { area: "server", root: "server", accept: (rel) => /\.(?:js|mjs|cjs)$/.test(rel) },
  { area: "web", root: "web", accept: (rel) => !rel.startsWith("web/vendor/") && /\.(?:html|js|mjs|css)$/.test(rel), excludes: WEB_SHUTTLE_EXCLUDES },
  { area: "native", root: "native/electron", accept: (rel) => rel.endsWith(".cjs") },
]) {
  check(`${area} 셔틀이 디스크의 소스를 하나도 빠뜨리지 않는다`, () => {
    const listed = sourceFiles(area);
    const onDisk = filesUnder(root, accept, { includeSymlinks: true });
    const missing = onDisk.filter((rel) => !listed.includes(rel) && !excludes.has(rel));
    if (missing.length) throw new Error(`셔틀에서 빠진 파일: ${missing.join(", ")}`);
    if (area === "web" && !listed.includes("web/index.html")) throw new Error("셔틀에서 web/index.html이 빠짐");
    // 목록에 있다고 내용이 담긴 것은 아니므로 바이트 수로 확인한다.
    // 원본 합계 + 경계 주석 = 셔틀 길이가 아니면 어딘가에서 잘린 것이다.
    const text = readAll(area);
    const raw = listed.reduce((sum, rel) => sum + Buffer.byteLength(read(rel)), 0);
    const boundary = listed.slice(1).reduce((sum, rel) => sum + Buffer.byteLength(`\n/* ===== ${rel.toUpperCase()} ===== */\n`), 0);
    const got = Buffer.byteLength(text);
    if (got !== raw + boundary) throw new Error(`셔틀 길이 ${got} ≠ 원본 ${raw} + 경계 ${boundary}`);
    return listed.length > 0;
  });
}

console.log("[0.55] 소유 검사의 대상 — web 이 다시 이어붙기 시작했는가");
// 모듈을 분리하면 소유 검사가 대상을 잃는다. 그때 검사를 소유자로 다시 겨냥하지 않고
// 이 변수에 그 파일을 이어붙이면 검사는 다시 통과하지만, "이 파일들 중 어디에나
// 이 형태가 있으면 통과"가 된다. 어느 파일이 그 동작을 소유하는지 알 수 없게 되고,
// 같은 이름이 둘에 있으면 소유자에서 지워도 통과한다.
// 실제로 그렇게 이어붙인 검사 65개가 약해진 상태였다.
// 서버 쪽에서도 같은 방식이 잘못된 통과를 만들어, 분류를 고치자 숨은 실패 4건이 드러났다.
// 그래서 이 규칙을 검사로 강제한다. 새 모듈의 검사는 그 모듈 파일을 읽는다.
check("web 은 index.html 과 main.js 만 읽는다", () => {
  const decl = /const web = ([^;]*);/.exec(readFileSync(path.join(ROOT, "bin/smoke/sources.mjs"), "utf8"));
  if (!decl) throw new Error("web 선언을 못 찾음");
  const reads = [...decl[1].matchAll(/read\("([^"]+)"\)/g)].map((m) => m[1]);
  const extra = reads.filter((rel) => rel !== "web/index.html" && rel !== "web/js/main.js");
  if (extra.length) throw new Error(`web 에 이어붙은 파일: ${extra.join(", ")} — 검사를 그 파일로 겨냥하라`);
  return reads.length === 2;
});

// allCss 는 스무 개 CSS 를 이어붙인 소스다. "이 규칙이 어디에도 없어야 한다"는 음성 조건에는
// 그 범위 전체가 필요하지만, 양성 조건에 쓰면 A 파일의 규칙이
// B 파일 검사를 통과시켜 소유가 사라진다. 그래서 음성으로만 쓰이는지를 검사로 강제한다.
// 자기 자신을 집계하지 않으려고 토큰을 런타임에 붙인다.
check("allCss 는 음성 조건에만 쓰인다", () => {
  const src = [read("bin/smoke.mjs"), ...sourceFiles("smoke").map((rel) => read(rel))].join("\n");
  const tok = "test(all" + "Css)";
  const re = new RegExp(`(!?)\\/(?:[^\\/\\\\\\n]|\\\\.|\\[[^\\]]*\\])+\\/[gimsuy]*\\.${tok.replace("(","\\(").replace(")","\\)")}`, "g");
  const uses = [...src.matchAll(re)];
  const total = src.split(tok).length - 1;
  const positive = uses.filter((m) => m[1] !== "!").length;
  if (positive) throw new Error(`allCss 를 양성 조건에 씀 ${positive}곳 — 그 검사는 소유 파일 하나를 보게 하라`);
  // 정규식이 못 잡은 호출 형태가 있으면 이 검사는 아무것도 확인하지 않은 것이다
  if (uses.length !== total) throw new Error(`allCss 사용 ${total}곳 중 ${uses.length}곳만 판정함 — 부름꼴을 확인하라`);
  return uses.length > 0;
});


// async-check-guard:start
// 동기 check() 에 async 함수를 넘기면 Promise 가 돌아오고, 그것은 false 가 아니므로 언제나
// 통과한다. 안에서 던진 예외는 unhandled rejection 으로 사라진다. 확인 결과:
// 그렇게 넣은 검사에 변이 다섯을 심었는데 하나도 잡히지 않았다.
// 비동기는 await checkAsync 로 호출한다.
check("동기 check 에 async 함수를 넘기지 않는다", () => {
  const full = readFileSync(path.join(ROOT, "bin/smoke/sections/10-structure-guards.mjs"), "utf8");
  const beginToken = ["// async-check-", "guard:start"].join("");
  const endToken = ["// async-check-", "guard:end"].join("");
  const begin = full.indexOf(beginToken), end = full.indexOf(endToken);
  if (begin < 0 || end <= begin) throw new Error("async check 자기 검사 블록 경계를 못 찾음");
  const smokeModules = [read("bin/smoke.mjs"), ...sourceFiles("smoke")
    .filter((rel) => rel !== "bin/smoke/sections/10-structure-guards.mjs")
    .map((rel) => read(rel))].join("\n");
  const code = (full.slice(0, begin) + full.slice(end + endToken.length) + "\n" + smokeModules)
    .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  // 넓게 집계하는 쪽과 판정하는 쪽을 나눈다. 둘이 일치하지 않으면 모르는 호출 형태가 생긴 것이다.
  const anyCheck = /(?<!async )\bcheck\(\s*(?:"|`)/g;
  const asyncArg = /(?<!async )\bcheck\(\s*(?:"[^"]*"|`[^`]*`)\s*,\s*async\b/g;
  const control = 'check("x", async () => {});';
  if ([...control.matchAll(anyCheck)].length !== 1 || [...control.matchAll(asyncArg)].length !== 1) {
    throw new Error("async check 판정기 양성 대조군을 못 찾음");
  }
  const bad = [...code.matchAll(asyncArg)].length;
  if (bad) throw new Error(`동기 check 에 async 함수를 넘긴 자리 ${bad}곳 — await checkAsync 를 써라`);
  if ([...code.matchAll(anyCheck)].length < 100) throw new Error("check 호출을 거의 못 찾았다 — 판정기를 확인하라");
  return true;
});
// async-check-guard:end

// raw-indexOf-slice-guard:start
check("검사 소스에 raw indexOf 슬라이스가 없다", () => {
  // smoke 만이 아니라 test/** 도 본다. 거기에도 슬라이스 위에 doesNotMatch 를 얹은 곳이
  // 여럿이고, 기준점이 사라지면 똑같이 통과한다. 이 저장소에서 실제로 발생한 문제다.
  const full = readFileSync(path.join(ROOT, "bin/smoke/sections/10-structure-guards.mjs"), "utf8");
  const beginToken = ["// raw-indexOf-", "slice-guard:start"].join("");
  const endToken = ["// raw-indexOf-", "slice-guard:end"].join("");
  const begin = full.indexOf(beginToken), end = full.indexOf(endToken);
  if (begin < 0 || end <= begin) throw new Error("raw 슬라이스 자기 검사 블록 경계를 못 찾음");
  const tests = readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).sort();
  if (tests.length < 5) throw new Error(`test/*.mjs 를 ${tests.length}개만 찾았다 — 훑는 방식을 확인하라`);
  const outside = full.slice(0, begin) + full.slice(end + endToken.length)
    + read("bin/smoke.mjs")
    + sourceFiles("smoke")
      .filter((rel) => rel !== "bin/smoke/sections/10-structure-guards.mjs")
      .map((rel) => read(rel)).join("\n")
    + tests.map((f) => read(`test/${f}`)).join("\n");
  // 문자열을 지우면 안 된다. web["slice"](web["indexOf"](…)) 꼴이 web[""](web[""](…)) 가 되어
 // 넓게 집계하는 쪽조차 보지 못한다. 그러면 "부름꼴 대조"가 그 형태에 대해 무의미해진다.
  // 확인 결과: 대괄호 호출을 심었는데 대조가 걸리지 않았다. 주석만 제거하고 문자열은 남긴다.
  const code = outside.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  // actualRe는 계산형 프로퍼티·괄호·공백까지 넓게 세고, judgedRe는 허용하지 않을 정본 부름꼴을
  // 판정한다. 둘이 다르면 정규식이 모르는 부름꼴이 생긴 것이므로 raw가 0이어도 통과시키지 않는다.
  const actualRe = /\b([A-Za-z_$][\w$]*)\s*(?:\.\s*slice\s*|\[\s*["']slice["']\s*\])\(\s*(?:\(\s*)*\1\s*(?:\.\s*indexOf\s*|\[\s*["']indexOf["']\s*\])\(/g;
  const judgedRe = /\b([A-Za-z_$][\w$]*)\.slice\(\s*\1\.indexOf\(/g;
  const count = (src, re) => [...src.matchAll(re)].length;
  const control = 'probe.slice(probe.indexOf("start"), probe.indexOf("end"))';
  if (count(control, actualRe) !== 1 || count(control, judgedRe) !== 1) {
    throw new Error("raw 슬라이스 판정기 양성 대조군을 못 찾음");
  }
  const actual = count(code, actualRe), judged = count(code, judgedRe);
  if (actual !== judged) {
    throw new Error(`raw indexOf 슬라이스 후보 ${actual}곳 중 ${judged}곳만 판정함 — 부름꼴을 확인하라`);
  }
  if (judged) throw new Error(`raw indexOf 슬라이스 ${judged}곳 — bin/slice-anchor.mjs 의 sliceBetween/sliceFrom 을 써라`);
  return true;
});
// raw-indexOf-slice-guard:end

console.log("[0.55b] import 한 이름을 그 모듈이 정말 내주는가");
// 없는 이름을 import 하면 브라우저가 모듈 그래프를 링크하는 단계에서 멈춰 화면이 뜨지 않는다.
// 그런데 node --check 는 파일을 하나씩만 보므로 통과하고,
// 이 스위트의 나머지도 통과한다. 실제로 browser/tabs.js 를 분리하면서
// const 화살표 함수 11개에 export 를 빠뜨렸을 때 1079/0 통과였고 렌더러만 중단됐다.
// 정적으로 판정 가능한 것을 런타임에 맡기지 않는다.
check("import 한 이름이 그 모듈의 export 에 있다", () => {
  const files = sourceFiles("web").filter((rel) => rel.endsWith(".js"));
  const exportsOf = new Map();
  for (const rel of files) {
    const src = read(rel);
    const set = new Set();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) set.add(m[1]);
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name && name !== "default") set.add(name);
      }
    exportsOf.set(rel, set);
  }
  const bad = [];
  for (const rel of files) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    for (const m of read(rel).matchAll(/import\s+\{([\s\S]*?)\}\s+from\s+"(\.[^"]+)"/g)) {
      const target = path.posix.normalize(`${dir}/${m[2]}`);
      const has = exportsOf.get(target);
      if (!has) { bad.push(`${rel}: ${m[2]} 를 못 찾음`); continue; }
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !has.has(name)) bad.push(`${rel}: ${name} 을 ${target} 이 내주지 않는다`);
      }
    }
  }
  if (bad.length) throw new Error(bad.join(" / "));
  return files.length > 1;
});

console.log("[0.55c] 만든 모듈을 아무도 부르지 않는가");
// 소유 검사는 "그 파일에 그 코드가 있는가"만 본다. 그래서 모듈을 만들어 놓고 main 에서
// import 하는 줄을 빠뜨려도 전부 통과한다. 파일은 있지만 기능은 동작하지 않는다.
// 적대 검사에서 panel import 두 줄을 지운 변이를 소유 검사가 그대로 통과시켰다.
// 이름 문자열로 계산하는 것도 안 된다. index.html 이 로드하는 동명의 고전 스크립트에도 걸린다.
// import 절과 동적 import 를 따라 main.js 에서 도달 가능한지 본다. capability 는 켠 것만 로드하므로
// 정적 from 으로는 참조되지 않는다. 둘 다 보지 않으면 lazy 와 고아가 구별되지 않는다.
check("web/js 의 모든 모듈이 main.js 에서 import 로 닿는다", () => {
  const files = sourceFiles("web").filter((rel) => rel.endsWith(".js") && rel.startsWith("web/js/"));
  const known = new Set(files);
  const seen = new Set();
  const stack = ["web/js/main.js"];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const dir = cur.slice(0, cur.lastIndexOf("/"));
    const src = read(cur);
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"|\bimport\(\s*"(\.[^"]+)"\s*\)/g)) {
      const spec = m[1] || m[2];
      const target = path.posix.normalize(`${dir}/${spec}`);
      if (known.has(target)) stack.push(target);
    }
  }
  const orphans = files.filter((rel) => !seen.has(rel));
  if (orphans.length) throw new Error(`main 에서 닿지 않는 모듈: ${orphans.join(", ")}`);
  return files.length > 1;
});

// 서버도 같다. 모듈을 만들고 index.js 에서 호출하는 줄을 빠뜨리면 그 handler 는 실행되지 않고
// 소유 검사는 전부 통과한다. 파일은 있지만 기능은 동작하지 않는다.
check("server 의 모든 모듈이 index.js 에서 import 로 닿는다", () => {
  const files = sourceFiles("server").filter((rel) => rel.endsWith(".js"));
  const known = new Set(files);
  // 진입점은 index.js 하나가 아니다. package.json 이 직접 실행하는 스크립트도 진입점이다
  // (server/selftest.js 는 `pnpm selftest` 로만 실행된다). 직접 나열하면 스크립트가 늘 때 틀려진다.
  const scripts = Object.values(JSON.parse(read("package.json")).scripts || {}).join(" ");
  const entries = ["server/index.js", ...files.filter((rel) => scripts.includes(rel))];
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const dir = cur.slice(0, cur.lastIndexOf("/"));
    // import 만 집계하면 자식 프로세스 진입점이 고아로 잡힌다. 그 파일은 fork 로 호출되므로
    // 연결하는 줄이 `new URL("./x.js", import.meta.url)` 이다. 호출하는 코드는 실재하는데
    // 검사가 그 형태를 몰라 실패하고, 그러면 쓰지 않는 import 를 추가해 통과시키는 회피만
    // 남는다. 그래서 인식할 연결 형태를 늘린다.
    for (const m of read(cur).matchAll(/from\s+"(\.[^"]+)"|new URL\(\s*"(\.[^"]+)"\s*,\s*import\.meta\.url\s*\)/g)) {
      const target = path.posix.normalize(`${dir}/${m[1] || m[2]}`);
      if (known.has(target)) stack.push(target);
    }
  }
  const orphans = files.filter((rel) => !seen.has(rel));
  if (orphans.length) throw new Error(`index 에서 닿지 않는 모듈: ${orphans.join(", ")}`);
  return files.length > 1;
});

console.log("[0.55d] 계약 헤더가 적어 둔 조사 명령이 사실인가");
// 헤더 끝의 "지금 목록은 이걸로 센다"는 다음 세션이 실제로 치는 명령이다. 그런데 파일 이름으로
// 집계하던 이전 형태는 두 가지를 틀리게 계산했다. 헤더 자기 문자열에 걸려 자기 파일을 결과에 넣고,
// 같은 폴더에서 './x.js' 로 참조하는 소비자를 놓쳤다.
// 파일 이름으로 집계하는 것도 안 된다. state.js 와 tabs.js 는 서로 다른 폴더에 둘씩 있어서
// 다른 폴더의 소비자까지 함께 집계됐다. 그래서 import 절의 경로를 실제로 해석하는 bin/importers.mjs 를
// 정본 도구로 두고, 헤더는 그 명령 한 형태만 통과시킨다.
check("헤더의 조사 명령이 정본 형태인가", () => {
  const files = [
    ...sourceFiles("web").filter((rel) => rel.endsWith(".js") && rel.startsWith("web/js/")),
    ...sourceFiles("server").filter((rel) => rel.endsWith(".js")),
    // native 도 같은 규칙을 따른다. 여기가 빠져 있어 native 모듈의 조사 명령은 오타로 바꿔도
 // 통과했다. native 는 CJS 라 importers 가 require 도 인식하도록 넓혔다.
    ...sourceFiles("native").filter((rel) => rel.endsWith(".cjs")),
    ...sourceFiles("smoke"),
  ];
  const bad = [];
  let found = 0;
  for (const rel of files) {
    const m = /지금 목록은 이걸로 센다: (.*)/.exec(read(rel));
    if (!m) continue;
    found++;
    const want = `node bin/importers.mjs ${rel}`;
    if (m[1].trim() !== want) bad.push(`${rel}: ${m[1].trim()}`);
  }
  if (bad.length) throw new Error(`정본 형태가 아님 — ${bad.join(" / ")}`);
  return found > 0;
});

console.log("[0.55g] 네이티브 모듈을 아무도 부르지 않는가");
// web·server 에는 "만들어 놓고 호출하는 줄을 빠뜨리면 실패"가 있는데 native 에는 없었다.
// 문법 검사는 새 .cjs 를 자동으로 찾아 통과시키므로, 아무도 require 하지 않는 모듈이
// 전부 통과한 채로 남는다. 파일은 있지만 기능은 동작하지 않는다. main.cjs 와 path.join(__dirname, …)
// 으로 로드되는 preload 를 진입점으로 두고 require 를 따라간다.
// 그래프 탐색은 bin/graph.mjs 하나가 담당한다. 이 자리에서 자체 정규식으로 다시 탐색하면
// 그 정규식이 모르는 형태가 생길 때 실패한다. 실제로 기능 표가 경계를 require.resolve
// 로 표기하자 그 모듈을 아무도 호출하지 않는다고 판정했다. 같은 사실을 두 곳에서 각자
// 계산하면 반드시 갈라지고, 갈라진 쪽이 약해진다. graph.mjs 머리말이 그래서 하나로
// 모았는데 이 자리가 남아 있었다.
await checkAsync("native 의 모든 .cjs 가 진입점에서 닿는다", async () => {
  const { buildGraph } = await import(new URL("../../graph.mjs", import.meta.url).href);
  const g = buildGraph();
  const nativeCjs = g.files.filter((rel) => rel.startsWith("native/") && rel.endsWith(".cjs"));
  if (nativeCjs.length < 20) cannotMeasure(`native 의 .cjs 를 ${nativeCjs.length} 개만 셌다 — 계측기가 죽었다`);
  const orphans = nativeCjs.filter((rel) => g.orphans.includes(rel));
  if (orphans.length) throw new Error(`진입점에서 닿지 않는 모듈: ${orphans.join(", ")}`);
  return true;
});

// 이 검사가 지키는 대상은 기능이 아니라 저장소 상태다.
// git 이 아는 파일만 공개본에 담기므로, add 를 잊은 파일은 이 저장소에서는 증상이 없고
// 받는 사람에게만 없다. 그래서 구조 가드가 소유한다.
  check("여기 있는 파일은 git 또는 이번 추출 셔틀이 알고 있다", () => {
    // 공개본은 git이 아는 파일만 담는다(scripts/export-public.mjs). 그래서 여기서 정상 동작하는
    // 파일이라도 add를 안 했으면 받는 사람에게는 없다. 이 저장소에서는 증상이
 // 없어서 드러나지 않는다. 실제로 server/env.cjs가 상태 폴더 이름을
    // 정하는데 빠져 있었고, patches/node-pty가 빠져 pnpm install이 깨질 상태였다.
    // .gitignore가 부산물을 이미 걸러 주므로, 그 뒤에 남는 것은 전부 add를 잊은 것이다.
    // 추출 패킷은 git add를 금지하면서 신규 모듈까지 포함한 smoke 통과를 요구한다.
    // 그래서 그 경로만 소스 셔틀이 실제로 읽는 동안 허용한다. 커밋 뒤에는 untracked가 아니므로
    // 이 예외에 걸리지 않고, 다른 미추적 파일은 곧바로 실패한다.
    // 추출이 진행되는 동안에만 신규 모듈 경로를 여기 둔다. 커밋되면 즉시 비운다.
    // 남겨 두면 그 경로의 실제 add 누락을 이 예외가 통과시킨다.
 // 비어 있는 것이 정상이다. window-media 둘은 커밋되어 더 이상 예외가 필요 없다.
    // 남겨 두면 그 경로의 실제 add 누락을 이 예외가 통과시킨다. 위에 적은 것과 같은 이유다.
    const extractionModules = new Set([]);
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean);
    const shuttled = new Set([
      ...sourceFiles("server"), ...sourceFiles("web"), ...sourceFiles("native"), ...sourceFiles("smoke"),
      ...filesUnder("test", (rel) => rel.endsWith(".mjs")),
    ]);
    const unexpected = out.filter((rel) => !extractionModules.has(rel) || !shuttled.has(rel));
    if (unexpected.length) console.log("       git과 추출 셔틀이 모르는 파일: " + unexpected.join(", "));
    return unexpected.length === 0;
  });


}
