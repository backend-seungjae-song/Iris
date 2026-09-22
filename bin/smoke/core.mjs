// 소유 범위: smoke의 유일한 성공·실패 계수와 공용 파일 탐색·읽기·실행 옵션·소스 슬라이서.
// 제공 API: check/checkAsync, summary, read/readAll, filesUnder/sourceFiles, fnBody/b4Function,
//   ROOT/LIVE/DOCX_ONLY/DOCX_CARD와 기존 bin/smoke.mjs 기준의 require_. 계수 원시 값은 내주지 않는다.
// 의존 대상: 저장소 루트 기준 상대경로와 Node ESM 실행, 정렬 가능한 디렉터리 열거.
// 유지 조건: 검사 이름·순서·문구, 한 검사당 한 번의 계수, sourceFiles 정렬,
//   require_의 상대경로 기준은 분할 전 bin/smoke.mjs와 같아야 한다.
// 영향 범위: 러너·모든 smoke 섹션·공유 소스가 양방향으로 이 계약에 기대므로 함께 본다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/smoke/core.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIVE = process.argv.includes("--live");
export const DOCX_ONLY = process.argv.includes("--docx-only");
export const DOCX_CARD = (process.argv.find((arg) => arg.startsWith("--docx-card=")) || "").slice("--docx-card=".length);
export const require_ = createRequire(new URL("../smoke.mjs", import.meta.url));

// 판정은 셋이다.
//
// 위반과 "못 잰 것"은 다른 사실이다. 위반은 코드를 고치라는 말이고, 못 잰 것은 이 검사가
// 아무 말도 안 했다는 말이다. 둘이 한 단어로 나가면 읽는 쪽이 직접 나눠야 하고, 직접
// 나누면 틀린다. 확인 결과: fail 목록을 "환경 탓"으로 분류하다 실제 위반 하나를
// 그 안에 섞어 넣었다(server/http-handler.js 가 환경변수 이름을 정본 밖에서 다시 읽는 건).
//
// 다만 던진 것을 곧바로 "못 잰 것"으로 삼으면 안 된다. 이 스위트에서 throw 는 단언
// 관용구다. 확인 결과: 섹션의 throw 803건 중 765건이 위반을 말한다("옛 이웃을
// 부른다", "개발 자리가 다르다"). 던진 것을 못 잰 것으로 돌리면 그 765건의 판정이
// 정확히 반대가 된다. 그래서 셋째 칸은 명시 선언으로만 간다. cannotMeasure 를
// 부른 곳만 해당한다. 기본값은 안전한 쪽에 남는다: 아무것도 선언하지 않으면 위반이다.
//
// 못 잰 것이 있으면 종료코드도 0이 아니다. 못 잰 것 8건에 위반 0건은 통과가 아니라 판정
// 없음이고, 하류(scripts/release-audit.mjs)는 문자열이 아니라 종료코드로 합격을 판정한다.
// 이 둘은 함께 유지한다. cannotMeasure 는 빠져나가는 통로가 아니라 더 강한 실패 신호이기
// 때문이다. 둘 중 종료코드 쪽을 나중에 완화하면 그때부터 이 표식이 우회로가 된다.
//
// 넷째 상태가 하나 더 있는데 여기서 잡지 못한다. 섹션이 import 단계에서 실패하는 경우다. 러너가
// 최상위 await import 로 섹션을 불러서 그때 실패하면 프로세스가 통째로 끝나고 이 요약 줄
// 자체가 나오지 않는다. 잘못된 통과는 아니다(종료코드가 0이 아니고 "결과:" 줄이 없다). 그래서
// bin/smoke/sources.mjs 의 최상위 IIFE 두 자리(renderer·screenMarkup)는 cannotMeasure 로
// 옮기지 않았다. 그 위치는 판정 층위에 올라오지 못한다.
export class Unmeasured extends Error {}
// 목록·집합을 돌려주는 함수에 최소값을 두고, 미달이면 이것을 부른다. 0개는 "없다"가
// 아니라 "못 쟀다"다. 거르는 검사는 전부 걸러내고도 통과한다. 술어는 이 규칙을 몰라도
// 그 목록을 부르기만 하면 적용받는다. 이 이름을 세면 스위트의 계측기 하한이 열거된다.
export const cannotMeasure = (why) => { throw new Unmeasured(String(why)); };

let pass = 0, fail = 0, blind = 0;
const ok = (n) => { pass++; console.log("  ok   " + n); };
const bad = (n, d) => { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); };
const blindly = (n, d) => { blind++; console.log("  못 잰 것 " + n + (d ? " — " + d : "")); };
const land = (name, v) => (v === false ? bad(name) : ok(name));
const caught = (name, e) => (e instanceof Unmeasured
  ? blindly(name, String(e.message || e).slice(0, 120))
  : bad(name, String(e.message || e).slice(0, 120)));
export function check(name, fn) { try { land(name, fn()); } catch (e) { caught(name, e); } }
export async function checkAsync(name, fn) { try { land(name, await fn()); } catch (e) { caught(name, e); } }
export function summary() {
  console.log(`\n결과: ${pass} ok / ${fail} 위반 / ${blind} 못 잰 것`);
  return fail || blind ? 1 : 0;
}

// 함수 하나를 통째로 떼어 낸다. 시작 위치에서 1800바이트를 자르면 그 안에 주석
// 몇 줄만 늘어도 찾던 줄이 범위 밖으로 밀려 검사가 아무것도 확인하지 못한다.
export function fnBody(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + "을 찾지 못했다");
  const nextMatch = /\n(?:export\s+)?function /.exec(src.slice(at + 1));
  const next = nextMatch ? at + 1 + nextMatch.index : -1;
  return src.slice(at, next < 0 ? src.length : next);
}

// 함수 하나의 본문만 정확히 자른다. b3FunctionSlices는 "다음 function 선언까지"를 본문으로 삼아
// 뒤따르는 최상위 코드까지 포함한다. 그러면 "이 함수 안에 X가 없다"류의 검사가 이웃 코드 때문에
// 실패하거나(확인 결과: pickCellAt 뒤의 pointerdown 리스너가 deliverPick을 부른다) 반대로 이웃 코드
// 덕분에 통과해, 검사가 자기가 검사한다고 적은 것을 실제로는 검사하지 못한다.
// web/index.html의 최상위 함수는 열림도 닫힘도 0열이므로 그 닫힘을 끝으로 삼는다.
export function b4Function(src, name) {
  const head = new RegExp("^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m").exec(src);
  if (!head) return "";
  const end = src.indexOf("\n}\n", head.index);
  return end < 0 ? src.slice(head.index) : src.slice(head.index, end + 2);
}

export const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
export function filesUnder(dir, accept, { includeSymlinks = false } = {}) {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(dir.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(rel, accept, { includeSymlinks }));
    else if ((entry.isFile() || (includeSymlinks && entry.isSymbolicLink())) && accept(rel)) out.push(rel);
  }
  return out;
}

const WEB_SHUTTLE_EXCLUDES = new Set([
  "web/memo-snapshot-state.js", // 별도 classic script이며 전용 smoke/test가 직접 read()한다.
  "web/scrollback-copy.js",     // 별도 classic script이며 전용 smoke/test가 직접 read()한다.
  // 메모랩은 앱 셸이 아니라 서버가 그대로 내주는 한 장짜리 화면이다. 렌더러 말뭉치에 섞으면
  // "이 모양이 어디에도 없어야 한다"는 음성 검사들이 다른 화면까지 검사하게 된다.
  // 대신 자기 검사를 갖는다. bin/smoke/sections/memolab.mjs 가 그것이다.
  "web/memolab/index.html",
  "web/memolab/app.js",
  "web/memolab/store.js",
  "web/memolab/style.css",
  "web/memolab/group.js",
  "web/memolab/terms.js",
  "web/memolab/words.js",
]);
export function sourceFiles(area) {
  if (area === "web") {
    // 브라우저 모듈은 .js만 허용한다. 정적 서버 MIME 표에 .mjs가 아직 없으므로, 새 .mjs는
    // 아래 web 전체 가드가 "셔틀 누락"으로 실패시켜 text/plain 배포를 조용히 허용하지 않는다.
    const modules = [
      ...filesUnder("web/js", (rel) => rel.endsWith(".js")),
      ...filesUnder("web/css", (rel) => rel.endsWith(".css")),
    ].sort();
    return ["web/index.html", ...modules];
  }
  if (area === "server") {
    // Node 런타임은 .mjs를 직접 적재하므로 서버 셔틀·문법 열거에는 포함한다.
    return filesUnder("server", (rel) => /\.(?:js|mjs|cjs)$/.test(rel)).sort();
  }
  if (area === "native") {
    return filesUnder("native/electron", (rel) => rel.endsWith(".cjs")).sort();
  }
  if (area === "smoke") {
    return filesUnder("bin/smoke", (rel) => rel.endsWith(".mjs")).sort();
  }
  throw new Error(`알 수 없는 소스 영역: ${area}`);
}
export const readAll = (area) => sourceFiles(area).map((rel, index) =>
  `${index ? `\n/* ===== ${rel.toUpperCase()} ===== */\n` : ""}${read(rel)}`).join("");

export { WEB_SHUTTLE_EXCLUDES };
