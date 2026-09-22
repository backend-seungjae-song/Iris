// 소유 범위: 판정·등급·권한·집계·측정의 계약. 영수증 없는 통과 차단, SHIP 미발급, 다섯 값이 같은 회차만 묶는다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/qa-contracts.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[14] 계약·도구 — 파생·등급·권한·집계·측정");
const homeTools = path.join(process.env.HOME, ".claude/.claude-system");
if (!existsSync(homeTools)) {
  console.log("  못 잼 (skipped: 홈 도구 없음) — 홈 QA 도구 계약 21건");
} else {
  const T = (p) => readFileSync(path.join(homeTools, p), "utf8");
  let derive, grade, authz, rollup, measure, val, planSchema;
  try {
    derive = T("tools/qa_derive.py"); grade = T("tools/qa_grade.py");
    authz = T("tools/qa_authorize.py"); rollup = T("tools/qa_rollup.py");
    measure = T("tools/qa_measure.py"); val = T("tools/qa_manifest_validate.py");
    planSchema = T("specs/contracts/qa-plan.schema.json");
  } catch { derive = grade = authz = rollup = measure = val = planSchema = ""; }

  check("파생은 계획에서 단계를 만든다 — 로그에서 만들면 미수행이 사라진다", () =>
    /반대 방향\(장부에서 단계를 만든다\)으로/.test(derive)
    && /not_run\.append/.test(derive));
  check("판정은 assertion에서만 나온다", () =>
    /`ok`는 명령이 실행됐다는 뜻이지 QA 판정이 아니다/.test(derive)
    && /verdict = "PASS" if last\.get\("pass"\) else "FAIL"/.test(derive));
  check("한 단계의 여러 시도는 마지막을 판정으로 삼는다", () =>
    // 합치면 매크로가 빗나간 뒤 재실행해 성공한 단계가 FAIL로 남는다.
    /attempts = len\(asserts\)/.test(derive) && /버려진 시도/.test(derive));
  check("조작만 한 단계는 판정 단계로 올리지 않는다", () =>
    // 올리면 영수증 없는 통과가 되고, 통과 건수만 늘어난다.
    /acted\.append/.test(derive) && /"acted_only"/.test(derive));
  check("단계 목록은 일어난 순서다", () =>
    /steps\.sort\(key=lambda x: x\.get\("at"\) or ""\)/.test(derive));
  check("의미 판단 자리는 비워 둔다", () =>
    /m\["transitions"\] = \[\]/.test(derive) && /비어 있는 것이/.test(derive));
  check("등급은 SHIP을 내지 않는다", () =>
    /"ship": None/.test(grade) && /SHIP은 기계가 내지 않는다/.test(grade));
  check("검사를 통과하지 않은 회차는 등급이 없다", () =>
    /"mechanical_gate": "UNGRADED"/.test(grade));
  check("영수증 없는 통과·미이행·열린 호출을 막는다", () =>
    /영수증 없는 통과/.test(grade) && /계획의 단계를 다 밟지 못했다/.test(grade)
    && /끝을 못 본 호출이 있다/.test(grade));
  check("권한은 붙어 봐서 상대 주소를 확인한다", () =>
    /s\.getpeername\(\)/.test(authz) && /is_loopback/.test(authz));
  check("나가지 않기로 한 것이 아니라 나가지 않았음을 본다", () =>
    /def probe_egress/.test(authz) && /"clean": not external/.test(authz));
  check("장부를 안 주면 발급하지 않는다", () =>
    /장부를 주지 않아 '나가지 않았음'을 재지 못했다/.test(authz));
  check("검사기가 규칙 권한의 전제를 실제로 본다", () =>
    /def check_authorization/.test(val)
    && /선언값으로 자기 자신을 허가한 것이다/.test(val)
    && /규칙의 전제는 '언제든 되돌릴 수 있다'인데 되돌린 증거가 없다/.test(val));
  check("쓰기는 생성만이 아니다 — 고치고 지운 것도 게이트를 지난다", () =>
    /WRITING_STORE_KINDS = \{"CREATED", "UPDATED", "ABSENT"\}/.test(val)
    && /def wrote_anything/.test(val));
  check("규칙 권한과 사용자 응답을 동시에 주장하면 걸린다", () =>
    /둘 중 하나는 사실이 아니다/.test(val));
  check("집계는 다섯 값이 같은 회차만 묶는다", () =>
    /def bucket_of/.test(rollup) && /wiring_fingerprint/.test(rollup)
    && /plan\.\.get\("digest"\)|\(m\.get\("plan"\) or \{\}\)\.get\("digest"\)/.test(rollup));
  check("끝나지 않았거나 검사를 통과하지 않은 회차는 묶음에서 뺀다", () =>
    /끝나지 않은 회차/.test(rollup) && /검사를 통과하지 않았다/.test(rollup));
  check("전체 나열보다 직전 대비 delta를 먼저 낸다", () =>
    /def delta/.test(rollup) && /new_fail/.test(rollup));
  check("측정은 화면 읽기·사람 호출·매크로 빗나감을 센다", () =>
    /"screen_reads"/.test(measure) && /"human_touches"/.test(measure)
    && /"macro_misses"/.test(measure) && /"ambiguous_targets"/.test(measure));
  check("무접촉이 안 되는 자리를 따로 남긴다", () =>
    /IRREDUCIBLE = \[/.test(measure) && /줄일 대상이 아니라 남겨야 하는 자리다/.test(measure));
  check("계획 계약이 locator 우선순위와 값 분류를 정의한다", () =>
    /우선순위는 testid → role\+name → 안정 속성 조합이다/.test(planSchema)
    && /cardinality가 정확히 1인지/.test(planSchema)
    // 형식(줄바꿈·들여쓰기)에 의존하지 않는다. 계약이 다시 저장되면서 한 줄이 여러 줄로 바뀔 수 있다.
    && ["generated", "plain", "credential", "human_only"].every((k) => planSchema.includes(`"${k}"`)));
}
}
