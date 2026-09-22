// 소유 범위: [0.55h] 조립부 주입 검사부터 [1] 고정 19칸 문법·MCP 기동 검사까지.
// 제공 API: 러너의 유일한 도달성 검사 직후 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스와 Node 자식 프로세스·경로 API.
// 유지 조건: 검사 이름·순서·문구, syntaxBatches 19칸, MCP 실제 기동, full smoke 출력.
// 영향 범위: 앞쪽 10 구조 섹션과 러너 도달성 검사가 이 run의 앞 출력 위치를 고정한다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/11-structure-guards-after-reachability.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";

import { check, filesUnder, read, ROOT, sourceFiles } from "../core.mjs";
import { bookmarks, css, main, mcp, pickHost, record, web } from "../sources.mjs";

export default async function run() {
// 한 줄 안의 따옴표 문자열만 제거한다. 줄 단위라 최악이라도 그 줄 하나만 과하게 지워지고,
// 파일 전체가 뭉개져 검사가 아무것도 보지 않고 통과하는 일은 없다.
const stripLineStrings = (line) => line
  .replace(/\/\/.*$/, "")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/`(?:\\.|[^`\\])*`/g, "``");


console.log("[0.55h] 조립부의 주입값을 무력화할 수 있는가");
// 분리한 모듈은 의존을 주입받는다. 그래서 모듈 안이 옳아도 조립부가 빈 함수를 넘기면
// 그 기능은 동작하지 않는다. 이를 확인하는 검사가 없었다(적대 검사).
// 행동 검사는 스스로 가짜 의존을 주입하므로 생산 조립부를 한 번도 실행하지 않고, 소스 검사의
// 정규식은 값 끝을 붙잡지 않아 `X: realFn && (() => {})` 를 접두사로 통과시킨다.
//
// 이 검사는 그 계열을 증명으로 닫지 않고 우회 형태를 금지한다. 진짜 함수를 적어 둔 채로
// 무력화하는 모양(단락 평가·빈 화살표·리터럴)을 조립부의 주입 객체에서 금지한다.
// 남는 부분은 개발 앱 런타임 확인이 맡는다(뜰 때·나갈 때 상태 파일이 갱신되는지, 창 제목이
// 각각 뜨는지는 조립부가 실제로 돌아야만 참이다).
check("조립부 주입값에 무력화 모양이 없다", () => {
  const files = sourceFiles("native").filter((rel) => rel.endsWith(".cjs"));
  // 값 하나를 통째로 죽이는 모양들. 정상 코드에는 나올 이유가 없다.
  const SABOTAGE = [
    [/^(false|true|null|undefined|0|""|'')$/, "리터럴로 대체됨"],
    [/^\(\s*[^)]*\)\s*=>\s*\{\s*\}$/, "빈 화살표"],
    [/^\(\s*[^)]*\)\s*=>\s*\(\s*\{\s*\}\s*\)$/, "빈 객체만 내는 화살표"],
    // 빈 함수만이 아니라 "늘 같은 값"도 무력화다. 판정을 늘 참으로, 목록을 늘 비어 있게,
    // 경로를 늘 같은 문자열로 넘기면 그 자리의 기능은 사라진다(적대 검사가 짚음:
    // allWindows: () => [] · isTrustedSender: () => true 는 위 모양 어디에도 안 걸렸다).
    [/^(async\s*)?\(\s*[^)]*\)\s*=>\s*(true|false|null|undefined|0|""|''|`\s*`|\[\s*\]|\{\s*\})$/, "늘 같은 값만 내는 화살표"],
    [/^(async\s*)?\(\s*[^)]*\)\s*=>\s*\(\s*(true|false|null|undefined|0|""|''|\[\s*\])\s*\)$/, "늘 같은 값만 내는 화살표"],
    [/&&\s*\(?\s*(async\s*)?\(\s*[^)]*\)\s*=>/, "단락 평가로 빈 함수 붙임"],
    [/\|\|\s*\(?\s*(async\s*)?\(\s*[^)]*\)\s*=>/, "단락 평가로 빈 함수 붙임"],
    [/^(false\s*&&|true\s*\|\|)/, "상수 단락으로 꺼짐"],
    [/=>\s*(false\s*&&|true\s*\|\|)/, "화살표 안에서 상수 단락으로 꺼짐"],
  ];
  const bad = [];
  let scanned = 0;
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/\bcreate[A-Z]\w*\(\{/g)) {
      // 여는 중괄호부터 짝이 맞는 자리까지 잘라 낸다. 문자열·주석은 건너뛴다.
      let i = m.index + m[0].length - 1, depth = 0, end = -1;
      for (let k = i; k < src.length; k++) {
        const c = src[k];
        if (c === '"' || c === "'" || c === "`") { const q = c; k++; while (k < src.length && src[k] !== q) { if (src[k] === "\\") k++; k++; } continue; }
        if (c === "/" && src[k + 1] === "/") { while (k < src.length && src[k] !== "\n") k++; continue; }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end < 0) continue;
      const body = src.slice(i + 1, end);
      // 최상위 쉼표로 속성을 가른다.
      const props = [];
      let d = 0, start = 0;
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (c === '"' || c === "'" || c === "`") { const q = c; k++; while (k < body.length && body[k] !== q) { if (body[k] === "\\") k++; k++; } continue; }
        if (c === "/" && body[k + 1] === "/") { while (k < body.length && body[k] !== "\n") k++; continue; }
        if (c === "{" || c === "(" || c === "[") d++;
        else if (c === "}" || c === ")" || c === "]") d--;
        else if (c === "," && d === 0) { props.push(body.slice(start, k)); start = k + 1; }
      }
      props.push(body.slice(start));
      for (const raw of props) {
        const text = raw.replace(/\/\/[^\n]*/g, "").trim();
        if (!text) continue;
        const colon = (() => {           // 속성 이름과 값을 가르는 첫 최상위 콜론
          let dd = 0;
          for (let k = 0; k < text.length; k++) {
            const c = text[k];
            if (c === "(" || c === "{" || c === "[") dd++;
            else if (c === ")" || c === "}" || c === "]") dd--;
            else if (c === ":" && dd === 0) return k;
          }
          return -1;
        })();
        if (colon < 0) { scanned++; continue; }   // 축약 속성(`screen,`)은 무력화할 수 없다
        const name = text.slice(0, colon).trim();
        const value = text.slice(colon + 1).trim();
        scanned++;
        for (const [re, why] of SABOTAGE) {
          if (re.test(value)) { bad.push(`${rel} ${name}: ${why} — ${value.slice(0, 60)}`); break; }
        }
      }
    }
  }
  if (bad.length) throw new Error(bad.join(" / "));
  // 검사한 대상이 없으면 이 검사는 아무것도 보지 않고 통과한다. 조립부는 여럿이다.
  if (scanned < 40) throw new Error(`주입 속성을 ${scanned}개밖에 못 봤다 — 조립부를 놓치고 있다`);
  return true;
});


console.log("[0.55f] 갈라 둔 CSS 가 실제로 실리고 순서가 그대로인가");
// CSS 는 순서가 곧 의미다. 한 블록을 여러 파일로 나누면 <link> 순서가 기존 cascade 를 대신한다.
// 한 줄을 빠뜨리거나 순서를 바꿔도 문법 오류가 없고 검사도 실패하지 않으며, 화면만 달라진다.
// 그래서 파일 이름에 번호를 박고, 그 번호순과 문서에 실린 순서가 같은지를 본다.
check("web/css 가 번호순 그대로 index.html 에 실린다", () => {
  const files = sourceFiles("web").filter((rel) => rel.startsWith("web/css/") && rel.endsWith(".css"));
  const linked = [...read("web/index.html").matchAll(/<link rel="stylesheet" href="(\/css\/[^"]+)"/g)]
    .map((m) => `web${m[1]}`);
  const want = [...files].sort();
  if (linked.join(" ") !== want.join(" ")) {
    throw new Error(`실린 순서 ${linked.join(" ")} / 번호순 ${want.join(" ")}`);
  }
  return want.length > 1;
});
// 규칙을 문장으로만 두면 <style> 한 블록에 다시 쌓기 쉬우므로 검사로 강제한다.
check("index.html 에 인라인 style 블록이 없다", () => {
  const html = read("web/index.html");
  if (/<style[\s>]/.test(html)) throw new Error("index.html 에 <style> 블록이 되살아났다");
  return true;
});

console.log("[0.55e] 서버 전송 계층이 기능을 붙들고 있는가");
// 전송이 기능을 import 하면 그 기능은 연결 코드와 함께만 고칠 수 있게 된다. 창 쪽
// web/js/core/ws.js 가 이 규칙을 따르고 서버도 같다. 무엇을 처음 보낼지·어떤 type 을
// 누가 처리할지·끊길 때 무엇을 거둘지는 전부 조립부(server/index.js)가 콜백으로 준다.
check("ws-transport 는 아무것도 import 하지 않는다", () => {
  const t = read("server/ws-transport.js");
  const imports = t.split("\n").filter((l) => /^\s*import\s/.test(l));
  if (imports.length) throw new Error(`전송이 import 함 — ${imports.join(" / ")}`);
  return /export function attachWs/.test(t) && /export function broadcast/.test(t);
});

console.log("[0.6] 옮긴 선언 — main 이 import 없이 부르는 이름이 있는가");
// 추출에서 실제로 나는 사고다. 선언은 모듈로 나갔는데 main 에 참조가 남으면
// node --check 도 이 스위트의 나머지도 전부 통과하고, 그 기능을 누를 때만 죽는다.
// 실제로 smoke 1075/0 과 node --check 가 통과한 상태에서 렌더러가 실행되지 않았다.
//
// 놓치는 것보다 헛짚는 것이 낫다. 주석·문자열을 정규식으로 지우고 남은 코드만 보는
// 앞선 설계는 정규식으로 JS 를 토큰화할 수 없어서(정규식 리터럴 안의 따옴표·백틱)
// 5,915줄 중 3,883줄을 뭉개고 아무것도 보지 않은 채 통과했다.
// 그래서 원문을 그대로 뒤지고 문법상 확실히 참조가 아닌 자리만 뺀다.
check("main 이 import 없이 부르는 export 가 없다", () => {
  const mainLines = read("web/js/main.js").split("\n");
  const mainRaw = mainLines.join("\n");

  // 확실히 참조가 아닌 줄: import 문, 줄 전체 주석, 블록 주석 안쪽.
  const skip = new Array(mainLines.length).fill(false);
  let inBlock = false, inImport = false;
  mainLines.forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { skip[i] = true; if (t.includes("*/")) inBlock = false; return; }
    if (t.startsWith("/*")) { skip[i] = true; if (!t.includes("*/")) inBlock = true; return; }
    if (t.startsWith("//")) { skip[i] = true; return; }
    if (inImport) { skip[i] = true; if (/from\s*["']/.test(line)) inImport = false; return; }
    if (/^import\b/.test(t)) { skip[i] = true; if (!/from\s*["']/.test(line)) inImport = true; }
  });

  const imported = new Set();
  for (const m of mainRaw.matchAll(/import\s+\{([\s\S]*?)\}\s+from/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  for (const m of mainRaw.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1]);
  for (const m of mainRaw.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) imported.add(m[1]);

  // main 이 스스로 선언한 이름. 넓게 잡는다. 좁게 잡으면 오탐이 늘어 검사가 무시된다.
  const declared = new Set();
  for (const m of mainRaw.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of mainRaw.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of mainRaw.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(":").pop().trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }

  const found = [];
  for (const rel of sourceFiles("web")) {
    if (rel === "web/js/main.js" || !rel.endsWith(".js")) continue;
    const src = read(rel);
    const exported = new Set();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) exported.add(m[1]);
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name && name !== "default") exported.add(name);
      }
    for (const name of exported) {
      if (imported.has(name) || declared.has(name)) continue;
      // 바로 뒤의 `:` 는 객체 키이거나 라벨이라 참조가 아니다.
      const re = new RegExp("(?<![\\w$.])" + name.replace(/[$]/g, "\\$") + "(?![\\w$])\\s*(:?)");
      for (let i = 0; i < mainLines.length; i++) {
        if (skip[i]) continue;
        const m = re.exec(stripLineStrings(mainLines[i]));
        if (!m || m[1] === ":") continue;
        found.push(`${name} (${rel}) — main.js:${i + 1}`);
        break;
      }
    }
  }
  if (found.length) throw new Error(found.join(" / "));
  return true;
});

console.log("[0.7] 옮긴 사설 상태 — main 이 모듈 안의 것을 부르는가");
// [0.6] 은 export 된 이름만 본다. 모듈이 export 하지 않는 최상위 상태를 main 이 부르면
// 그것도 죽은 참조인데 그쪽은 보이지 않는다. 실제로 발생한 사례는 다음과 같다.
// bookmarks 를 떼어낼 때 제안 상태(sugTyped·sugIdx·sugItems)가 모듈 사설이 됐는데
// 주소창 리스너는 main 에 남아 그 셋을 계속 불렀다. 구문 검사도 이 스위트도 통과했고
// 렌더러도 정상으로 떴다. 주소창을 누르는 순간에만 죽는 상태였다.
check("main 이 모듈의 사설 상태를 부르지 않는다", () => {
  const mainLines = read("web/js/main.js").split("\n");
  const mainRaw = mainLines.join("\n");

  const skip = new Array(mainLines.length).fill(false);
  let inBlock = false, inImport = false;
  mainLines.forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { skip[i] = true; if (t.includes("*/")) inBlock = false; return; }
    if (t.startsWith("/*")) { skip[i] = true; if (!t.includes("*/")) inBlock = true; return; }
    if (t.startsWith("//")) { skip[i] = true; return; }
    if (inImport) { skip[i] = true; if (/from\s*["']/.test(line)) inImport = false; return; }
    if (/^import\b/.test(t)) { skip[i] = true; if (!/from\s*["']/.test(line)) inImport = true; }
  });

  // main 이 스스로 가진 이름. 같은 이름을 각자 쓰는 것은 문제가 아니다.
  // import 한 이름도 main 의 것이다. 모듈이 같은 이름을 사설로 갖고 있어도 상관없다.
  const own = new Set();
  for (const m of mainRaw.matchAll(/import\s+\{([\s\S]*?)\}\s+from/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) own.add(name);
    }
  for (const m of mainRaw.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) own.add(m[1]);
  // id 가 붙은 요소는 브라우저가 같은 이름의 전역으로 노출한다(docxview·fileview 등).
  // 모듈이 같은 이름을 사설로 갖고 있어도 main 쪽 참조는 그 전역이지 모듈 것이 아니다.
  for (const m of read("web/index.html").matchAll(/\sid="([A-Za-z_$][\w$]*)"/g)) own.add(m[1]);
  // preload 가 올려두는 것과 페이지가 쓰는 브라우저 전역.
  for (const g of ["acHost", "monaco", "XLSX", "docx", "marked", "hljs"]) own.add(g);
  for (const m of mainRaw.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
  // 한 줄에 여러 개를 선언하는 형태(const a = …, b = …, c = …)를 전부 담는다.
  // 첫 이름만 담으면 두 번째부터가 "모듈 사설"로 오인된다(bNote·fileview 가 그랬다).
  //
  // 다만 선언부만 본다. 예전엔 const 로 시작하는 줄 전체에서 =·,·; 앞의 이름을 다 담았는데,
  // 한 줄에 문장이 여럿이면(const id = x; x = null; f(id);) 그 줄에 등장하는 남의 이름까지
  // main 의 것으로 포함했다. 그래서 실제 죽은 참조를 놓쳤다. context-menu 를 분리한 뒤
  // main 에 남은 pendingSpaceFocus 세 곳을 이 검사가 통과시켰고, 렌더러가
  // 스페이스 목록을 받을 때마다 실패했다.
  for (const line of mainLines) {
    const decl = /^\s*(?:const|let|var)\s+([^;]*)/.exec(line);
    if (!decl) continue;
    for (const part of decl[1].split(",")) {
      const m = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (m) own.add(m[1]);
    }
  }
  for (const m of mainRaw.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(":").pop().trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) own.add(name);
    }
  // 함수 인자도 main 의 것이다. 좁게 잡으면 오탐이 늘어 검사가 무시된다.
  for (const m of mainRaw.matchAll(/\(([^()]{0,200})\)\s*=>/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) own.add(name);
    }

  const found = [];
  for (const rel of sourceFiles("web")) {
    if (rel === "web/js/main.js" || !rel.endsWith(".js")) continue;
    const src = read(rel);
    // export 되지 않은 최상위 const/let/var 만 본다. 함수는 이름이 흔해 오탐이 많다.
    const priv = new Set();
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) priv.add(m[1]);
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?)*)\s*;/gm))
      for (const part of m[1].split(",")) {
        const name = part.trim().split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) priv.add(name);
      }
    for (const name of priv) {
      if (own.has(name) || name.length < 4) continue; // 짧은 이름은 우연 일치가 많다
      const re = new RegExp("(?<![\\w$.])" + name.replace(/[$]/g, "\\$") + "(?![\\w$])\\s*(:?)");
      for (let i = 0; i < mainLines.length; i++) {
        if (skip[i]) continue;
        const m = re.exec(stripLineStrings(mainLines[i]));
        if (!m || m[1] === ":") continue;
        found.push(`${name} (${rel} 사설) — main.js:${i + 1}`);
        break;
      }
    }
  }
  if (found.length) throw new Error(found.join(" / "));
  return true;
});

console.log("[1] 문법 — 모든 소스가 파싱되는가");
const nativeSyntaxSources = sourceFiles("native");
const syntaxSources = [
  ...nativeSyntaxSources,
  ...filesUnder("server", (rel) => /\.(?:js|mjs|cjs)$/.test(rel)),
  ...filesUnder("web", (rel) => !rel.startsWith("web/vendor/") && /\.(?:js|mjs|cjs)$/.test(rel)),
].sort();
// 문법 검사 수는 리팩터링 기준선의 일부다. 새 모듈을 재귀 발견하되 기존 19개 슬롯에 나눠
// 검사하면 대상은 넓어지고 결과 계수는 바뀌지 않는다.
const syntaxBatches = Array.from({ length: 19 }, () => []);
syntaxSources.forEach((rel, index) => syntaxBatches[index % syntaxBatches.length].push(rel));
for (const [index, batch] of syntaxBatches.entries()) {
  const label = batch.length === 1 ? batch[0] : `소스 문법 ${index + 1}/19 (${batch.length}개)`;
  check(label, () => {
    if (!batch.length) return false;
    for (const f of batch) {
      try { execFileSync(process.execPath, ["--check", path.join(ROOT, f)]); }
      catch (error) { throw new Error(`${f}: ${error.message || error}`); }
    }
  });
}
check("web/index.html inline scripts", () => {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m, n = 0;
  while ((m = re.exec(web))) {
    n++;
    const moduleScript = /\btype\s*=\s*(?:["']module["']|module(?:\s|$))/i.test(m[1]);
    if (moduleScript) execFileSync(process.execPath, ["--input-type=module", "--check"], { input: m[2] });
    else new Function(m[2]);
  }
  return n > 0;
});
check("ORCA_INJECT 주입 스크립트가 유효 JS", () => {
  const m = pickHost.match(/const ORCA_INJECT = `([\s\S]*?)`;/); if (!m) return false;
  new Function(m[1].replace(/\$\{[^}]*\}/g, "0")); return true;
});
check("REC_INJECT 주입 스크립트가 유효 JS", () => {
  const m = record.match(/const REC_INJECT = `([\s\S]*?)`;/); if (!m) return false;
  new Function(m[1].replace(/\$\{[^}]*\}/g, "0")); return true;
});
check("페이지 API 위장 주입을 되살리지 않는다", () => {
  return !/ANTI_DETECTION_SCRIPT/.test(read("native/electron/browser-hardening.cjs"))
    && !/antiDetectionScript/.test(read("native/electron/webview-lifecycle.cjs"));
});

// --check는 모듈이 *실행되는지*는 보지 않는다. MCP 서버가 TDZ 참조 하나로 기동 즉시 죽어도
// 문법 검사는 전부 통과했다(실제 사고). 그래서 진짜로 띄워서 물어본다.
const mcpBoot = (() => {
  const rpc = (o) => JSON.stringify(o) + "\n";
  const input = rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })
    + rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "bin/iris-mcp.mjs")], { input, timeout: 15000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const msgs = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { ok: true, init: msgs.find((m) => m.id === 1), list: msgs.find((m) => m.id === 2) };
  } catch (e) { return { ok: false, why: String(e.stderr || e.message || e).slice(0, 200) }; }
})();
check("iris-mcp 실제 기동 + initialize 응답", () => {
  if (!mcpBoot.ok) throw new Error(mcpBoot.why);
  return !!(mcpBoot.init && mcpBoot.init.result);
});
check("iris-mcp tools/list가 도구를 돌려줌", () => Array.isArray(mcpBoot.list?.result?.tools) && mcpBoot.list.result.tools.length > 20);
check("browser_login이 노출됨", () => (mcpBoot.list?.result?.tools || []).some((t) => t.name === "browser_login"));
check("모든 도구 스키마가 properties 맵 형식", () => {
  const t = mcpBoot.list?.result?.tools || []; if (!t.length) return false;
  // schema에 전체 JSON Schema를 넣으면 type/properties/required가 properties 안으로 들어간다.
  // 단 "type"은 인자 이름으로도 쓸 수 있다(앱 요소 유형). 잘못 넣었을 때만 값이 문자열이므로
  // 값의 타입으로 구분한다. 이름만 보고 막으면 정상 인자가 걸린다.
  const bad = (v) => typeof v === "string";
  return !t.some((x) => { const p = x.inputSchema?.properties || {}; return bad(p.type) || bad(p.properties) || bad(p.required); });
});
check("조작 도구는 tab 인자를 받음", () => {
  const t = mcpBoot.list?.result?.tools || []; if (!t.length) return false;
  const noTab = t.filter((x) => !x.inputSchema?.properties?.tab).map((x) => x.name);
  // 탭이 없는 도구만 예외다. 목록·새 탭·보고서·기록·고른 요소(브라우저를 거치지 않는다),
  // 그리고 앱 도구 전부(시뮬레이터엔 탭이라는 개념이 없다).
  const exempt = ["browser_tabs", "browser_new_tab", "browser_report", "browser_trace", "browser_picks"];
  const app = t.filter((x) => x.name.startsWith("app_")).map((x) => x.name);
  return exempt.every((n) => noTab.includes(n)) && app.every((n) => noTab.includes(n))
    && noTab.length === exempt.length + app.length;
});
check("tab 핸들은 문자열로 전달(Number 변환 금지)", () => /tab: String\(a\.tab\)/.test(read("bin/iris-mcp.mjs")) && !/tab: Number\(a\.tab\)/.test(read("bin/iris-mcp.mjs")));


// 분리한 모듈이 이전 모듈의 이름을 부르는지 확인한다. 이 검사가 없으면 잡을 방법이 거의 없다.
// node --check 는 구문만 보고, 소스 모양 검사는 모두 통과하며, 문제는 그 줄이 실제로
// 실행될 때 ReferenceError 로 나온다. 보고서를 분리할 때 buildReport 가 다른 구역의
// readMarks 를 쓰고 있었고, 모양 검사 열 몇 개가 모두 통과한 채로 지나갔다.
// 앱 표면은 시뮬레이터가 있어야 도구가 동작하므로 실행으로는 확인되지 않는다.
//
// 완전한 스코프 분석이 아니다. 부르는 이름이 그 파일 안에 선언됐거나·import 됐거나·
// 인자이거나·알려진 전역인지만 본다. 모호하면 통과시킨다.
check("떼어낸 MCP 모듈은 자기 안에 없는 이름을 부르지 않는다", () => {
  const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await",
    "async", "function", "of", "in", "new", "delete", "void", "yield", "do", "else", "throw"]);
  const GLOBALS = new Set(["String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date",
    "RegExp", "Buffer", "Map", "Set", "Error", "Promise", "Symbol", "BigInt", "parseInt", "parseFloat",
    "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "require", "console", "process",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "structuredClone", "fetch", "URL"]);
  const bad = [];
  for (const rel of filesUnder("bin/mcp", (f) => f.endsWith(".mjs"))) {
    const raw = read(rel);
    // 템플릿 리터럴 안은 브라우저 쪽 코드이므로 여기서 판정할 대상이 아니다.
    const code = raw.replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``");
    const known = new Set([...GLOBALS, ...KEYWORDS]);
    for (const m of code.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    for (const m of code.matchAll(/^import\s+([A-Za-z_$][\w$]*)/gm)) known.add(m[1]);
    for (const m of code.matchAll(/\{([^{}]*)\}\s*(?:from|=)/g)) {
      for (const part of m[1].split(",")) {
        const name = part.split(":").pop().split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
      }
    }
    // 인자 이름. 화살표·함수 선언 양쪽을 훑고, 구조분해 안쪽 이름도 담는다.
    for (const m of code.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*)?\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].replace(/[{}[\]]/g, ",").split(",")) {
        const name = part.split(":").pop().split("=")[0].replace(/\.\.\./, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
      }
    }
    for (const m of code.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\s*\(/g)) {
      if (!known.has(m[1])) bad.push(`${rel}: ${m[1]}`);
    }
  }
  if (bad.length) throw new Error(`선언을 못 찾은 호출: ${[...new Set(bad)].join(", ")}`);
  return true;
});

}
