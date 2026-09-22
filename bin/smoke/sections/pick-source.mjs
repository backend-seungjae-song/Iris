// 소유 범위: 요소 지목에서 소스 코드 위치까지 연결하는 경로와, AGENTS 세션 지목의 계약 검사.
// 제공 API: 러너가 한 번 부르는 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스 문자열.
// 유지 조건: 검사 이름·순서·문구와 full smoke 출력 형태.
// 영향 범위: server/pick-source.js · server/http-handler.js · web/js/browser/{pick,pick-host,pick-boot}.js
//   · web/css/25-pick-record.css.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/pick-source.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, b4Function, check, read } from "../core.mjs";
import { contextWords, exactnessOf, htmlAttrValues, scanRoot, sideline, signatures, sourceRootOf } from "../../../server/pick-source.js";
import { appPick, css, httpHandler, pick, pickBoot, pickHost, pickSource } from "../sources.mjs";

export default async function run() {

// 저장소의 함수를 그대로 가져와 실행한다. 사본을 만들면 사본만 통과한다.
const codeLinesFn = () => new Function(b4Function(pick, "codeLines").replace(/^export\s+/, "") + "\nreturn codeLines;")();

// ── 요소 지목 → 소스 자리 ──
// 지목 블록은 그대로 다른 세션·다른 모델에게 건네진다. 받은 쪽이 다시 grep 을 돌아야 하면 그 검색은
// 지목마다 한 번씩 다시 도는 셈이고, 틀리기도 한다. 로컬 코드는 정적이라 고른 쪽에서 한 번만 찾으면 된다.
check("지목한 요소의 코드 자리를 앱이 찾아서 싣는다", () =>
  /await pickSourceOf\(p\)/.test(pick)
  && /fetch\("\/pick-source"/.test(pick)
  && /export function codeLines\(p\)/.test(pick)
  && /`소스: \$\{one\}`/.test(pick)
  && /`스타일: \$\{one\}`/.test(pick)
  && /`동작: \$\{one\}`/.test(pick)
  && /\.\.\.codeLines\(p\),/.test(pick));

// 뿌리 한 줄이 없으면 나머지 상대 경로가 어느 폴더 기준인지 알 수 없어, 받은 쪽이 다시 찾아야 한다.
check("코드 자리는 기준 폴더 절대경로와 함께 나간다", () =>
  /out\.push\(`기준 폴더: \$\{c\.root\}\$\{where\}`/.test(pick)
  && /못 찾음/.test(pick));

// 찾다가 오래 걸리는 것이 지목을 막는 이유가 되면 안 된다. 사람은 클릭 뒤에 블록이 붙기를 기다린다.
check("소스를 못 찾아도 지목은 그대로 간다", () =>
  /Promise\.race\(\[req, new Promise\(\(res\) => setTimeout\(\(\) => res\(null\), 3000\)\)\]\)/.test(pick)
  && /if \(\/\^https\?:\/i\.test\(p\.url \|\| ""\)\) p\.code = await pickSourceOf\(p\)/.test(pick));

// 원격 주소의 소스는 이 기계에 없다. 그런데도 뿌리를 찾으려 들면 엉뚱한 폴더를 그 페이지의 소스라고 적는다.
check("로컬 주소가 아니면 파일을 열지 않는다", () =>
  /const isLocal = LOCAL_HOSTS\.has\(host\) \|\| LOCAL_TLD\.test\(host\);/.test(pickSource)
  && /if \(!isLocal\) return \{ root: null, local: false, why: "원격 주소/.test(pickSource)
  && /if \(u\.protocol !== "http:" && u\.protocol !== "https:"\)/.test(pickSource));

// 뿌리는 추정하지 않는다. 그 포트를 실제로 수신하는 프로세스의 작업 폴더가 정본이다.
// *.test 는 caddy 를 거치므로 포트를 먼저 복원해야 같은 경로를 사용할 수 있다.
check("기준 폴더는 포트를 듣는 프로세스에서 온다", () =>
  /lsof", \["-nP", `-iTCP:\$\{port\}`, "-sTCP:LISTEN", "-t"\]/.test(pickSource)
  && /lsof", \["-a", "-p", pid, "-d", "cwd", "-Fn"\]/.test(pickSource)
  && /localdev", "dashboard", "status\.json"/.test(pickSource));

// 빌드 산출물 안의 줄을 짚어 주면 고쳐도 다음 빌드에 지워지는 자리를 알려준 셈이 된다.
check("훑는 자리에서 산출물과 남의 코드는 뺀다", () =>
  /"node_modules", "dist", "build", "out", "\.next"/.test(pickSource)
  && /if \(name\.startsWith\("\."\)\) continue;/.test(pickSource));

// 사용자가 대기하는 경로다. 상한이 없으면 큰 저장소에서 지목 하나에 몇 초가 걸린다.
check("훑기에는 파일·크기·시간·건수 상한이 있다", () =>
  /MAX_FILES = \d+/.test(pickSource)
  && /MAX_BYTES = /.test(pickSource)
  && /WALK_MS = \d+/.test(pickSource)
  && /MAX_HITS = \d+/.test(pickSource)
  && /files >= MAX_FILES \|\| hits\.length >= MAX_HITS \|\| Date\.now\(\) - started > WALK_MS/.test(pickSource));

// 런타임이 생성한 id 는 소스에 없는 문자열이다. 그것부터 찾으면 항상 0건이 된다.
check("런타임이 지어낸 이름으로는 찾지 않는다", () =>
  /const generated = \(s\) => /.test(pickSource)
  && /radix\|headlessui/.test(pickSource)
  && /if \(rawId && !generated\(rawId\)\) push\("id", rawId\);/.test(pickSource));

// 짧은 클래스를 길이로 제외하면 그런 요소는 "뿌리만" 반환된다(확인 결과: .srow 가 그랬다).
// 흔한 이름인지는 길이가 아니라 검색 건수로 정해지고, 그 판정은 MAX_HITS 가 한다.
check("클래스는 길이로 거르지 않는다", () => {
  const kinds = (cls) => signatures({ cls }).map((x) => x.kind + "=" + x.v);
  return kinds(["kkori"]).includes("class=kkori")
    && kinds(["is-open"]).length === 0            // 상태 표시 클래스는 요소를 가리키는 이름이 아니다
    && kinds(["ab"]).length === 0;                // 두 글자는 글자대로 아무 데나 걸린다
});
// 요소 자신의 속성만 보면 검색어가 없는 요소가 있다. 클래스 하나뿐이고 그 이름이 흔하면 후보가
// 전부 비어 뿌리 폴더만 반환된다. 검색에 쓸 이름은 대개 안쪽 버튼에 있다.
// 픽스처에 실제 화면의 문구를 쓰지 않는다. 쓰면 사용자가 그 요소를 고를 때마다 이 검사 파일이
// 답에 포함된다. 같은 이유로 pick-source.js 의 주석에서도 문구를 제거했다.
check("안쪽 속성값까지 후보로 삼는다", () => {
  const html = `<div class="line"><button class="star" title="검사용 첫째 꼬리표">x</button>`
    + `<span aria-label="검사용 둘째 꼬리표"></span><button class="back" title="검사용 셋째 꼬리표">y</button></div>`;
  const vals = htmlAttrValues(html);
  const kinds = signatures({ cls: ["line"], html }).map((x) => x.kind);
  return vals.includes("검사용 첫째 꼬리표") && vals.includes("검사용 둘째 꼬리표") && vals.includes("검사용 셋째 꼬리표")
    && kinds.indexOf("attr") >= 0 && kinds.indexOf("attr") < kinds.indexOf("class");
});
// 속성값이 없으면 클래스로 대체한다. 새 후보가 기존 경로를 막지 않는다.
check("속성값이 없으면 클래스로 돌아간다", () =>
  signatures({ cls: ["kkori"], html: `<div class="kkori"></div>` }).some((x) => x.kind === "class" && x.v === "kkori"));
// 이름을 맨 부분문자열로 찾으면 `cap` 이 `capability`·`capture` 안쪽까지 걸려 2055건이 되고,
// 그 건수 때문에 너무 흔한 이름으로 판정돼 제외되고, 정작 그 클래스를 정의하는 규칙이 답에서 빠진다.
check("이름은 낱말 경계를 지켜 찾는다", () => {
  // 이름을 리터럴로 적지 않는다. 적으면 이 파일이 그 이름을 가진 유일한 위치가 되어
  // "없는 이름은 0건" 이 성립하지 않는다(확인 결과: 1건이 나왔다).
  const absent = ["kko", "ri", "cap"].join("");
  const one = scanRoot(ROOT, absent);               // 저장소에 없는 이름이므로 0건이어야 한다
  const bare = scanRoot(ROOT, "cap");
  // 단어 경계가 적용되면 `capability` 내부는 잡히지 않는다. 잡혔다면 이 규칙이 동작하지 않는 것이다.
  const inside = bare.hits.some((h) => /capabilit|capture/i.test(read(h.file).split("\n")[h.line - 1] || ""));
  return one.hits.length === 0 && !inside;
});
// 이름 후보는 그 이름을 정의하는 위치만 센다. 단순 언급까지 세면 흔한 이름이 상한을 넘는다.
check("이름 후보는 선언하는 자리만 센다", () => {
  const hits = scanRoot(ROOT, "cap").hits;
  return hits.length > 0 && hits.every((h) => h.exact >= 2);
});
// 주석에 이름이 나온다고 그 줄이 그 요소를 정의하는 위치는 아니다.
// 두 줄을 비교만 하면 이 조건을 놓친다. 감점을 0으로 만들어도 코드 줄이 더 높아서
// 통과한다(확인 결과). 검사해야 하는 것은 "주석이 코드보다 낮은가"가 아니라
// "주석이 아예 음수로 내려갔는가"다.
check("주석 줄은 뒤로 밀린다", () => {
  const mark = ["내", "말로"].join(" ");
  const comment = `  /* 순서가 뜻이다, 그대로는 재료, ${mark}가 이해 */`;
  const slash = `  // ${mark} 로 다시 쓰기`;
  const code = `  el('div', { class: 'x' }, '${mark}')`;
  return exactnessOf(comment, mark) < 0 && exactnessOf(slash, mark) < 0
    && exactnessOf(code, mark) > 0;
});
// 한 뿌리에 화면이 여럿이면 같은 이름이 여러 파일에 있다. 지금 보고 있는 주소의 폴더가 먼저다.
check("주소의 폴더가 순위를 가른다", () =>
  /function nearness\(file, segs\)/.test(pickSource)
  && /\|\| \(b\.exact \+ b\.near \+ 2 \* \(b\.ctx \|\| 0\)\) - \(a\.exact \+ a\.near \+ 2 \* \(a\.ctx \|\| 0\)\)/.test(pickSource));

// 같은 이름의 규칙이 여러 화면에 있으면 줄 번호가 앞선 쪽이 선택된다(확인 결과: `.ghead` 의
// 스타일 답으로 다른 화면(.guide)의 규칙이 나가고, 정작 그 요소에 적용되는 규칙(.grp)이 빠졌다).
// 어느 파일에 있고 어떤 선택자를 포함하는지가 우선순위를 정한다.
check("조상·자식 이름이 같은 이름 안에서 순위를 가른다", () => {
  const words = contextWords({
    cls: ["zqhead"],
    selector: "section > div.zqstudy:nth-child(6) > div.zqslot:nth-child(2) > div.zqgrp:nth-child(2) > div.zqhead:nth-child(1)",
    html: `<div class="zqhead"><span class="at">x</span><span class="zqdrop">y</span></div>`,
  });
  return words.includes("zqgrp") && words.includes("zqslot") && words.includes("zqstudy") && words.includes("zqdrop")
    && !words.includes("zqhead")           // 자기 이름은 맥락이 아니다
    && !words.includes("at")               // 두 글자는 아무 데나 걸린다
    && /2 \* \(b\.ctx \|\| 0\)/.test(pickSource);
});

// 화면을 만드는 코드가 .js·.css·.html 로만 오지 않는다. 파이썬·루비·템플릿이 HTML 을 생성하는 화면도
// 흔하다. 확인 결과: 한 화면의 요소가 "뿌리만" 반환됐고 그 요소는 .py 파일이 만들고
// 있었다. 그래서 검사할 확장자를 고르지 않고 제외할 것만 지정한다.
check("코드 파일을 확장자로 미리 고르지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pick-ext-"));
  try {
    fs.writeFileSync(path.join(dir, "board.py"), `x = '<h3 class="zqmark">hi</h3>'\n`);
    fs.writeFileSync(path.join(dir, "app.min.js"), `.zqmark{color:red}\n`);
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), `zqmark: 1\n`);
    fs.writeFileSync(path.join(dir, "shot.png"), `class="zqmark"\n`);
    const hits = scanRoot(dir, "zqmark").hits;
    const files = hits.map((h) => h.file);
    return files.includes("board.py") && !files.includes("app.min.js")
      && !files.includes("pnpm-lock.yaml") && !files.includes("shot.png")
      && hits.every((h) => !!h.bucket);          // 모르는 확장자도 칸을 받는다
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 해석기가 읽는 필드를 클라이언트가 보내지 않으면 그 필드의 기능이 동작하지 않는다. 오류도 없고
// 검사도 통과한다. 확인 결과: selector·html 이 본문에 없어 조상·자식 순위와 내부 속성값 후보가 실사용에서
// 한 번도 실행되지 않았고 `.ghead` 의 답으로 다른 화면의 규칙이 나갔다. 앞선 검사들은 함수만 확인했다.
// 필드 목록을 여기 적어 두지 않는다. 적어 두면 해석기가 필드를 늘릴 때 이 목록이 어긋난다.
check("해석기가 읽는 칸을 지목 몸통이 다 싣는다", () => {
  const zone = ["signatures", "contextWords", "resolvePickSource"].map((n) => b4Function(pickSource, n)).join("\n");
  const wants = [...new Set([...zone.matchAll(/\b(?:p|pick)\.([a-zA-Z_]\w*)/g)].map((m) => m[1]))];
  const body = /const body = JSON\.stringify\(\{ pick: \{([\s\S]*?)\} \}\);/.exec(pick);
  return wants.length >= 8 && !!body
    && wants.every((k) => new RegExp("\\b" + k + ":").test(body[1]));
});

// 생성기가 만든 화면은 CSS 를 한 줄에 담는다. 확인 결과: 그 줄이 7413자였고 그 화면의 모든
// 요소가 같은 줄 번호를 답으로 받았다. 파일을 열어도 그 줄 안에서 다시 찾아야 한다.
check("아주 긴 줄에는 칸 번호가 붙는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pick-col-"));
  try {
    fs.writeFileSync(path.join(dir, "gen.css"), ".pad{color:red}".repeat(20) + ".zqlong{color:red}\n");
    fs.writeFileSync(path.join(dir, "hand.css"), ".zqlong{color:blue}\n");
    const by = new Map(scanRoot(dir, "zqlong").hits.map((h) => [h.file, h]));
    return by.get("gen.css").col > 200 && !by.get("hand.css").col;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 검사 파일과 문서는 그 이름을 언급할 뿐 그 요소를 만들지 않는다. 확인 결과: 어느 요소의 동작
// 답으로 그것을 검사하는 파일 한 줄이 나가고, 정작 그것을 만드는 두 줄이 빠졌다. 제외하지는 않는다.
// 만드는 줄이 하나도 없으면 이 줄이 참고 위치를 알려 준다.
check("만드는 자리가 아닌 파일은 뒤로 간다", () =>
  sideline("bin/smoke/sections/pick-source.mjs") === "검사"
  && sideline("tests/board.py") === "검사"
  && sideline("web/js/app.test.js") === "검사"
  && sideline("docs/pane-send.md") === "글"
  && sideline("web/memolab/app.js") === null
  && sideline("server/pick-source.js") === null
  && /const byRank = \(a, b\) => \(a\.pen \|\| 0\) - \(b\.pen \|\| 0\)/.test(pickSource)
  && /h\.side = sideline\(h\.file\); h\.pen = h\.side \? 1 : 0;/.test(pickSource));

// 만드는 자리가 아닌 줄을 "동작" 으로 적으면 받은 쪽은 그 줄을 그 요소가 하는 일로 읽는다.
// 포함 여부가 아니라 어떤 이름으로 표시할지의 문제이므로, 이름을 붙여서 포함한다.
check("검사·글은 동작이 아니라 그 이름으로 실린다", () => {
  const ls = codeLinesFn()({ code: {
    root: "/r", local: true, host: "127.0.0.1", port: 8791,
    markup: [{ file: "board.py", line: 5431 }],
    style: [{ file: "board.py", line: 4111, col: 555 }],
    script: [{ file: "tests/t.py", line: 31, side: "검사" }, { file: "docs/x.md", line: 7, side: "글" }],
  } });
  return ls.includes("소스: board.py:5431")
    && ls.includes("스타일: board.py:4111:555")
    && ls.includes("검사: tests/t.py:31")
    && ls.includes("글: docs/x.md:7")
    && !ls.some((l) => l.startsWith("동작:"));
});

// 라벨은 사용자가 훑으면서 값과 대응시키는 요소다. 하나만 영어면 그 줄에서 읽기가 끊기고,
// 비유("뿌리")면 값이 무엇인지 라벨이 설명하지 못한다. 브라우저 지목·앱 지목·세션 지목 세 블록이
// 한 화면에 나란히 표시되므로 셋의 라벨이 같은 형식이어야 한다.
check("지목 블록의 이름표는 한글로 통일돼 있다", () => {
  const seen = [];
  for (const src of [pick, appPick, pickHost])
    for (const m of src.matchAll(/`([가-힣A-Za-z][가-힣A-Za-z0-9 ]{0,14}): /g)) seen.push(m[1]);
  return seen.length >= 25 && seen.every((l) => /^[가-힣][가-힣0-9 ]*$/.test(l));
});

// 설치된 앱·컨테이너·dist 는 소스를 복사해 실행한다. 그 폴더의 파일을 지목하면 받은 쪽이 사본을
// 고치게 되고 다음 설치에서 그 수정이 사라진다(확인 결과: 4271 지목이 app.asar.unpacked 를 가리켰다).
// 사본의 출처는 만든 쪽만 알 수 있으므로, 여기서는 만든 쪽이 남긴 한 줄만 읽고 추정하지 않는다.
check("사본은 자기가 어디서 왔는지 말한다", () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "pick-src-"));
  try {
    const copy = path.join(box, "copy");
    const real = path.join(box, "real");
    fs.mkdirSync(copy); fs.mkdirSync(real);
    const mark = (v) => fs.writeFileSync(path.join(copy, ".source-root"), v);
    mark(real + "\n");
    const found = sourceRootOf(copy) === real;
    mark("web/memolab");                       // 상대 경로는 어디 기준인지 알 수 없다
    const notRel = sourceRootOf(copy) === null;
    mark(path.join(box, "없는-폴더"));           // 없는 데를 가리키면 따라가지 않는다
    const notGone = sourceRootOf(copy) === null;
    mark(copy);                                // 자기를 가리키면 제자리다
    const notSelf = sourceRootOf(copy) === null;
    fs.rmSync(path.join(copy, ".source-root"));
    return found && notRel && notGone && notSelf && sourceRootOf(copy) === null;
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

// 출처도 서명 대상이다. 빌드가 남기고 설치는 서명된 bundle 그대로 옮긴다.
check("설치가 사본에 온 곳을 적어 둔다", () => {
  const sh = read("scripts/install-app.sh");
  const hook = read("scripts/after-pack.cjs");
  return /"afterPack": "scripts\/after-pack.cjs"/.test(read("package.json"))
    && /writeFileSync\(path.join\(resources, "\.source-root"\)/.test(hook)
    && !sh.includes('> "$APP/Contents/Resources/app.asar.unpacked/.source-root"');
});

// 위 경로는 소스이고 화면을 내주는 것은 사본이다. 이 줄이 없으면 받은 쪽이 소스를 고쳐 놓고
// 화면이 바뀌지 않는다고 판단한다. 사본은 다시 설치할 때까지 이전 코드를 제공한다.
check("사본에서 돌고 있으면 그 자리도 적는다", () => {
  const at = { root: "/repo", local: true, host: "127.0.0.1", port: 4271,
    markup: [{ file: "web/a.js", line: 1 }], style: [], script: [] };
  const on = codeLinesFn()({ code: { ...at, copy: "/Applications/X.app/불러온-사본" } });
  const off = codeLinesFn()({ code: { ...at, copy: null } });
  return on[on.length - 1] === "돌고 있는 사본: /Applications/X.app/불러온-사본"
    && on[on.length - 2] === "기준 폴더: /repo (127.0.0.1:4271)"
    && !off.some((l) => l.startsWith("돌고 있는 사본:"));
});

// 실행 출력과 같은 등급이다. 이 기계의 폴더 구조가 포함된다.
check("소스 자리 응답은 루프백에만 연다", () =>
  /pathname === "\/pick-source"/.test(httpHandler)
  && /if \(!\(ip === "127\.0\.0\.1" \|\| ip === "::1"\)\) \{ res\.writeHead\(403\)\.end\('\{"ok":false,"error":"local only \(AC5\)"\}'\); return; \}[\s\S]{0,600}resolvePickSource/.test(httpHandler));

// 위 검사들은 문자열 존재만 확인한다. 그 문자열이 실제로 어떤 줄을 만드는지는 함수를 실행해야 알 수 있다.
// 사용자와 다음 세션이 읽는 것은 이 줄들이지 정규식이 아니다.
check("코드 자리 줄이 실제로 그 모양으로 나온다", () => {
  const fn = codeLinesFn();
  const out = fn({
    code: {
      root: "/r/memo-lab", host: "localhost", port: 4390,
      markup: [{ file: "board/index.html", line: 35 }],
      style: [{ file: "board/style.css", line: 153 }, { file: "board/style.css", line: 158 }],
      script: [{ file: "board/app.js", line: 2201 }, { file: "board/app.js", line: 2295 }],
    },
  });
  return out.join("\n") === [
    "소스: board/index.html:35",
    "스타일: board/style.css:153, 158",
    "동작: board/app.js:2201, 2295",
    "기준 폴더: /r/memo-lab (localhost:4390)",
  ].join("\n");
});
// 못 찾았을 때 뿌리만 적으면, 받은 쪽은 "여기 어딘가에 있다"로 읽고 다시 grep 을 실행한다.
check("못 찾았으면 못 찾았다고 적는다", () => {
  const fn = codeLinesFn();
  const none = fn({ code: { root: "/r/x", host: "localhost", port: 5173, markup: [], style: [], script: [], why: "이 폴더에서 이 요소를 못 찾음" } });
  const remote = fn({ code: null });
  return none.length === 1 && none[0] === "기준 폴더: /r/x (localhost:5173) (이 폴더에서 이 요소를 못 찾음)"
    && remote.length === 0;
});
// 로컬인데 뿌리를 찾지 못하면 아무 줄도 반환되지 않아, 받은 쪽은 이 기능이 실행됐는지도 모른 채
// 직접 grep 을 실행하게 된다(확인 결과: 이미 종료된 포트의 페이지). 원격은 아무것도 출력하지 않는다.
check("로컬인데 못 잡았으면 그 사실을 적는다", () => {
  const fn = codeLinesFn();
  const dead = fn({ code: { root: null, local: true, host: "127.0.0.1", port: 8853, markup: [], style: [], script: [], why: "그 포트를 듣는 프로세스가 없음 (서버가 이미 끝났을 수 있음)" } });
  const remote = fn({ code: { root: null, local: false, host: null, port: null, markup: [], style: [], script: [], why: "원격 주소 — 이 기계에 소스가 없음" } });
  return dead.length === 1 && dead[0].startsWith("소스: 못 찾음 (127.0.0.1:8853) (")
    && remote.length === 0;
});
// 그 판정은 해석기가 로컬이었는지를 함께 반환해야 성립한다. 문구로 구분하면 언젠가 어긋난다.
check("해석기가 로컬 여부를 함께 돌려준다", () =>
  /local: false, why: "원격 주소/.test(pickSource)
  && /if \(!root\) return \{ root: null, local: true, port, host/.test(pickSource)
  && /return \{ root: from \|\| root, copy: from \? root : null, local: true, port, host, why: null \};/.test(pickSource));
// 프레임워크가 직접 제공한 위치는 검색 결과보다 정확하므로, 있으면 그것을 사용한다.
check("프레임워크가 짚어 준 자리가 검색보다 먼저다", () => {
  const fn = codeLinesFn();
  const out = fn({
    src: { file: "src/App.jsx", line: 12, component: "Board", framework: "react" },
    code: { root: "/r/app", host: "localhost", port: 5173, markup: [{ file: "other.html", line: 9 }], style: [], script: [] },
  });
  return out[0] === "소스: src/App.jsx:12 (react dev)"
    && out.includes("컴포넌트: <Board> (react)")
    && !out.some((l) => l.includes("other.html"));
});

// ── AGENTS 세션 지목 ──
// 세션을 지목할 수단이 없으면, 지시를 받은 쪽이 같은 스페이스의 모든 세션에 확인을 요청하게 된다.
// 그래서 포함해야 하는 것은 설명이 아니라 호출할 수 있는 주소다.
check("AGENTS 세션 줄도 지목 대상이다", () =>
  /const overAgent = under\?\.closest\?\.\("\.srow"\) \|\| null;/.test(pick)
  && /overAgent && overAgent\.dataset\.target \? overAgent/.test(pick)
  && /export function pickAgentAt\(target\)/.test(pickHost)
  && /const ag = pickAgentAt\(e\.target\);/.test(pickHost)
  && /!pickAgentAt\(e\.target\)/.test(pickHost)
  && /\.picking-tabs \.srow\.pick-hover/.test(css("25-pick-record")));

check("고른 세션은 부를 수 있는 주소로 나간다", () =>
  /`주소: herdr pane \$\{a\.paneId\}`/.test(pickHost)
  && /`읽기: herdr pane read \$\{a\.paneId\} --source recent --lines 50`/.test(pickHost)
  && /`보내기: herdr pane run \$\{a\.paneId\} "<명령>"`/.test(pickHost)
  && /a\.sessionUuid \? `세션: \$\{a\.sessionUuid\}` : null/.test(pickHost)
  && /a\.cwd \? `폴더: \$\{a\.cwd\}` : null/.test(pickHost));

// 기능이 앱 셸의 herdr 상태 파일을 직접 읽으면 기능을 끄고 켜는 경계가 깨진다.
check("세션 값은 import 가 아니라 주입으로 온다", () =>
  !/herdr\/state\.js/.test(pickHost)
  && /getLastAgents = deps\.getLastAgents \|\| \(\(\) => \[\]\);/.test(pickHost)
  && /getLastAgents, orderedSpaces,\s*\n\s*\} = ctx;/.test(pickBoot)
  && /initPickHost\(\{[^}]*getLastAgents, orderedSpaces \}\)/.test(pickBoot));

}
