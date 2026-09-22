// 소유 범위: 로그인 넘겨주기의 쿠키 회수. 거절된 쿠키를 복원하는 경로, 다른 로그인을
//   건드리지 않는 병합, "몇 개 들어갔는가"를 사실대로 집계하는 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구. 실제 SQLite 전이와 실패 복구는 격리 unit test가 측정한다.
// 유지 조건: raw cohort의 원자성·CAS·실제 반영 수 계약.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/cookie-harvest.mjs
import {
  cannotMeasure, check, read,
} from "../core.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2n3] 로그인 넘겨주기 — 쿠키가 실제로 들어가는가");

const imp = read("native/electron/cookie-import.cjs");
const cauth = read("native/electron/chrome-auth.cjs");
const handoff = read("web/js/browser/handoff.js");
const putBody = [sliceBetween(imp, "async function putCookies", "// 탭 전환·이동의 자동 점검", "putCookies")];
const stageBody = sliceBetween(imp, "async function stageScopedCookieCohort", "// 지정 프로필의 쿠키를 복호화", "scoped cookie staging");
// 부정 단언은 주석 때문에 잘못 판정된다. 없어져야 할 코드가 주석에 이름으로 남아 있으면 계속 실패한다.
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const cauthBare = bare(cauth);

// Electron 의 쿠키 jar 는 크고 까다로운 쿠키를 거절한다(AWS 콘솔의 aws-creds 같은 것). 복원하는
// 방법은 원본 DB 행을 대상 DB 에 직접 넣는 것뿐인데, 자동 회수 경로가 그 두 필드를 누락하면
// 그 방법 자체가 막혀 수동 불러오기만 되고 자동 회수는 동작하지 않는다.
check("자동 회수도 원본 행을 들고 간다", () => {
  const body = /function readDecryptedCookies\(profileEntry, hostFilter\) \{[\s\S]*?\n\}/.exec(imp);
  if (!body) throw new Error("readDecryptedCookies 를 못 찾음");
  const decrypt = sliceBetween(imp, "function decryptCookieRows", "function readSourceCookieRows", "쿠키 복호화");
  return /rawValue, sourceRow/.test(decrypt)
    && /const decoded = decryptCookieRows\(scoped, key\)/.test(body[0])
    && /return decoded\.list\.filter/.test(body[0]);
});

// 한 행이 거절됐을 때 성공 행만 live에 남기면 로그인 조각이 섞인다. live 전체를 rollback하고
// 원본 행 전체 cohort를 스테이징해야 다음 시작에서도 같은 사이트 범위의 한 벌로 적용된다.
check("거절된 쿠키를 스테이징에 남긴다", () =>
  /replaceCookieSnapshot/.test(putBody[0])
  && /applied\.rolledBack === true/.test(putBody[0])
  && /stageScopedCookieCohort\(sess, list, bases/.test(putBody[0])
  && /stageCookieRows\(targetPath, list, \{ preserveTargetBound: true, scopeBases: \[\.\.\.bases\] \}\)/.test(stageBody)
  && /registerPendingCookieImport\(targetPath, staging, "replace-scoped", \[\.\.\.bases\]\)/.test(stageBody)
  && /return \{ staged: list\.length, targetPath \}/.test(stageBody)
  && /staged = pending\.staged/.test(putBody[0]));

// 원본 행이 없으면 스테이징할 수 없다. 그 경우를 성공으로 집계하면 실제와 다른 수를 보고하게 된다.
check("스테이징할 수 없는 것은 성공으로 세지 않는다", () =>
  /list\.every\(c => c\.sourceRow && Buffer\.isBuffer\(c\.rawValue\)\)/.test(stageBody)
  && /skipped: list\.length - staged/.test(putBody[0])
  && /staged \? \{\} : \{ error:/.test(putBody[0]));

// 스테이징 뒤 Iris에서 새로 로그인하면 다음 시작의 오래된 raw cohort가 그 로그인을 되감아서는
// 안 된다. 신규 replacement manifest는 같은 target snapshot의 baseline을 갖고 transaction 안에서
// 현재 범위와 비교한 뒤에만 DELETE/INSERT 한다.
check("replacement 스테이징은 target 변경을 CAS로 거른다", () =>
  /CREATE TABLE .*COOKIE_CAS_TABLE.* AS SELECT/.test(imp)
  && /BEGIN IMMEDIATE/.test(imp)
  && /execFileSync\("\/usr\/bin\/sqlite3", \["-bail", target\]/.test(imp)
  && /NOT EXISTS \(\$\{target\} EXCEPT \$\{baseline\}\)/.test(imp)
  && /iris-cookie-cas=/.test(imp)
  && /mode === "replace" \|\| mode === "replace-scoped" \? \{ cas: true \}/.test(imp));

// 이 경로는 해당 사이트의 쿠키만 추가한다. 통째 가져오기처럼 비우면 다른 로그인이 함께 삭제된다.
check("자동 회수는 다른 로그인을 비우지 않는다", () =>
  !/clearStorageData/.test(putBody[0]));

// result.ok 는 존재하지 않는 필드라서, 읽으면 항상 "읽은 개수"로 떨어진다. 하나도 반영되지 않은
// 회차도 로그와 화면에는 성공으로 남는다(확인 결과 로그 49개, 디스크 0개).
check("세는 수는 읽은 개수가 아니라 들어간 개수다", () =>
  /const live = \(result && result\.live\) \|\| 0;/.test(cauth)
  && /const staged = \(result && result\.staged\) \|\| 0;/.test(cauth)
  && /const harvested = live \+ staged;/.test(cauth)
  && !/result\.ok/.test(cauthBare)
  && /imported: applied\.live, live: applied\.live/.test(putBody[0])
  && /imported: staged,[\s\S]{0,80}live: 0/.test(putBody[0]));

check("하나도 못 옮기면 성공으로 남기지 않는다", () =>
  /if \(!harvested\) \{[\s\S]{0,320}return \{ ok: false/.test(cauth));

// 합쳐서 "가져왔습니다"라고만 하면, 새로고침해도 여전히 로그아웃인 이유를 사용자가 알 수 없다.
check("지금 먹는 것과 다시 켜야 먹는 것을 갈라 말한다", () =>
  /const later = r\.staged \|\| 0;/.test(handoff)
  && /앱을 다시 켜면 들어옵니다/.test(handoff)
  && /if \(!later && handoffBarEl === bar\)/.test(handoff));

check("CAS 없는 옛 스테이징은 target에 적용하지 않고 폐기한다", () =>
  /if \(entry\.cas !== true\) return false/.test(imp)
  && /validPendingEntry\(entry\) \? valid : invalid/.test(imp)
  && /discardStagingDatabase\(entry\.staging\)/.test(imp)
  && /writePendingEntries\(valid\)/.test(imp));

// SECURITY.md 는 평문 스테이징을 오래 두지 않는다고 사용자에게 약속한다. 하루가 지나거나 세 번
// 실패하면 버린다는 뜻이고, 그 약속은 상수 두 개가 아니라 그 상수를 쓰는 판정에 있다. 상수를 눈으로
// 확인하는 검사는 판정이 뒤집혀도(`>` 가 `<` 가 되어도) 통과하므로, 소스에서 그 함수를
// 그대로 떼어 가짜 시계·가짜 fs 로 실행하고 무엇을 버렸는지 집계한다.
check("평문 스테이징은 하루가 지나거나 세 번 실패하면 버린다", () => {
  const src = /function applyPendingCookieImports\(\) \{\n([\s\S]*?)\n\}/.exec(imp);
  if (!src) cannotMeasure("applyPendingCookieImports 를 못 찾음 — 세는 방식이 깨졌다");
  const num = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(imp);
    if (!m) throw new Error(`${name} 를 못 찾음`);
    return Function(`return (${m[1]})`)();
  };
  const TTL = num("PENDING_TTL_MS"), MAX = num("PENDING_MAX_ATTEMPTS");
  const NOW = 1_700_000_000_000;

  const entries = [
    { id: "성공", staging: "s1", target: "t1", createdAt: NOW - 1000, attempts: 0 },
    { id: "하루지남", staging: "s2", target: "t2", createdAt: NOW - TTL - 1, attempts: 0 },
    { id: "세번째실패", staging: "s3", target: "t3", createdAt: NOW - 1000, attempts: MAX - 1 },
    { id: "첫실패", staging: "s4", target: "t4", createdAt: NOW - 1000, attempts: 0 },
  ];
  const discarded = [], replayed = [];
  let kept = null;
  Function(
    "readPendingEntries", "discardStagingDatabase", "replayStagedCookieDatabase",
    "writePendingEntries", "PENDING_TTL_MS", "PENDING_MAX_ATTEMPTS", "fs", "Date", src[1],
  )(
    () => entries.map((e) => ({ ...e })),
    (s) => discarded.push(s),
    (e) => { replayed.push(e.staging); if (e.id !== "성공") throw new Error("재생 실패"); },
    (list) => { kept = list; },
    TTL, MAX,
    { existsSync: () => true },
    { now: () => NOW },
  );

  // 하루가 지난 것은 재생하지 않고 버린다. 평문이 남는 시간을 늘리지 않기 위해서다.
  if (replayed.includes("s2")) throw new Error("하루 지난 스테이징을 그래도 재생했다");
  const want = ["s1", "s2", "s3"].join(",");
  if ([...discarded].sort().join(",") !== want) throw new Error(`버린 것이 ${discarded.join(",")}`);
  // 남는 것은 아직 예산이 남은 하나뿐이고, 실패 횟수가 실제로 올라가 있어야 다음에 끝난다.
  if (!kept || kept.length !== 1 || kept[0].staging !== "s4") throw new Error(`남긴 것이 ${JSON.stringify(kept)}`);
  if (kept[0].attempts !== 1) throw new Error(`실패 횟수가 ${kept[0].attempts} — 안 오르면 영원히 남는다`);
  return true;
});
check("자동 복구는 출처와 전체 스냅샷 정책을 사용한다", () =>
  /planCookieRefresh/.test(imp) && /replaceCookieSnapshot/.test(imp)
  && /stageScopedCookieCohort\(sess, cookies, \[base\]/.test(imp)
  && /changed: 0, refreshed: 0, live: 0, staged/.test(imp)
  && !/heldCookieKey/.test(imp));

// 다른 브라우저가 통과한 도전의 증표를 가져오면, 이 브라우저가 직접 통과한 결과를 덮어써서 다음
// 요청부터 다시 검사를 받는다. claude.com 이 사람 확인 페이지로 넘어가 체크박스가 계속
// 다시 뜨는 증상이 이렇게 발생한다.
//
// 이름으로 막는다. 값으로는 구분할 수 없고 도메인으로도 구분할 수 없다. 이 이름들은 Cloudflare
// 뒤에 있는 모든 사이트에서 같은 뜻이라 한 도메인의 사정이 아니다.
check("다른 브라우저에 묶인 도전 증표는 가져오지 않는다", () => {
  const want = ["cf_clearance", "__cf_bm", "__cfruid", "_cfuvid"];
  const seg = sliceBetween(imp, "const CLIENT_BOUND_COOKIE_NAMES", "function isClientBoundCookie",
    "다른 브라우저에 묶인 도전 증표는 가져오지 않는다");
  const missing = want.filter((n) => !seg.includes('"' + n + '"'));
  if (missing.length) throw new Error("목록에 없다: " + missing.join(", "));
  // 목록만 있고 거르는 코드가 없으면 아무것도 막지 못한다.
  const rows = sliceBetween(imp, "function decryptCookieRows(", "\n}\n",
    "다른 브라우저에 묶인 도전 증표는 가져오지 않는다");
  if (!/isClientBoundCookie\(name\)/.test(rows)) throw new Error("복호화 자리에서 안 거른다");
  return true;
});

// import 한 UA 는 소스 브라우저 버전이 아니라 실제 엔진(Electron Chromium) 버전을 써야 한다.
// 소스 152·엔진 150 처럼 일치하지 않으면 Cloudflare Turnstile 이 automation 으로 판정해 챌린지를
// 실패시킨다(확인 결과 격리 하네스에서 UA 152 강제 시 ahrefs 0행, 150 이면 20행). 그래서
// (1) 새로 만드는 UA 는 process.versions.chrome 를 쓰고 (2) 이미 저장된 UA 도 읽는 순간 정규화한다.
check("import UA 는 소스 버전이 아니라 실제 엔진 버전을 말한다", () => {
  const src = sliceBetween(imp, "function sourceBrowserUserAgent(", "\n}\n",
    "import UA 는 실제 엔진 버전");
  // 버전 자리에 소스에서 읽은 CFBundleShortVersionString 이 아니라 엔진 버전이 들어가야 한다.
  if (!/const version = process\.versions\.chrome/.test(src)) throw new Error("UA 버전이 엔진 버전이 아니다");
  if (/CFBundleShortVersionString/.test(src)) throw new Error("여전히 소스 브라우저 버전을 UA 에 쓴다");
  // 이미 저장된 UA 를 읽는 자리에서 엔진 버전으로 정규화한다.
  const rd = sliceBetween(imp, "function readPartitionUserAgents(", "\n}\n",
    "저장된 UA 정규화");
  if (!/pinEngineVersion\(/.test(rd)) throw new Error("저장된 UA 를 엔진 버전으로 정규화하지 않는다");
  const pin = sliceBetween(imp, "function pinEngineVersion(", "\n}\n", "pinEngineVersion 본문");
  if (!/Chrome\\\/\\d/.test(pin) || !/Edg\\\/\\d/.test(pin) || !/process\.versions\.chrome/.test(pin)) {
    throw new Error("pinEngineVersion 이 Chrome/Edg 버전을 엔진 버전으로 바꾸지 않는다");
  }
  return true;
});

}
