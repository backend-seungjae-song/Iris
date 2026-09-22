// 소유 범위: 계획 러너. locator 우선순위, 하나로 좁혀질 때만 클릭, 실패의 전파 범위, 미수행 집계.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/plan-runner.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
console.log("[12] 계획 러너 — 대상은 하나로 좁혀질 때만 누른다");
{
  const cdp = cdpCmdInspectSource;
  const runner = read("bin/qa-plan.mjs");
  const srvP = readAll("server");

  check("locate가 몇 개 맞았는지 세고 판정까지 낸다", () =>
    /async locate\(send, _wc, args\)/.test(cdp)
    && /unique: reasons\.length === 0/.test(cdp)
    && /개가 맞는다 — 어느 것을 뜻하는지 정해지지 않았다/.test(cdp));
  check("보이지 않음·가려짐·비활성을 각각 본다", () =>
    /요소가 보이지 않는다/.test(cdp)
    && /다른 요소에 가려져 있다/.test(cdp)
    && /요소가 비활성이다/.test(cdp)
    && /out\.occluded = !!\(top && top !== el/.test(cdp));
  check("locate는 읽기라 재시도해도 안전한 목록에 있다", () =>
    /READONLY_CMDS = new Set\(\[[^\]]*"locate"/.test(srvP));
  check("우선순위는 testid → role\\+name → 선택자다", () =>
    /if \(spec\.testid\) \{[\s\S]{0,80}how = "testid"/.test(cdp)
    && /how = spec\.role && spec\.name \? "role\+name"/.test(cdp));
  check("이름이 조상까지 흐르면 가장 안쪽만 남긴다", () =>
    /matched = matched\.filter\(\(el\) => !matched\.some\(\(o\) => o !== el && el\.contains\(o\)\)\)/.test(cdp));

  check("확정에 실패하면 고치지 않고 그 시나리오를 멈춘다", () => {
    // 한 곳만 보면 다른 경로의 우회를 놓친다(확인 결과: 판정 경로만 고쳐도 검사가 통과했다).
    const guards = (runner.match(/if \(!c\.ok\) return \{ verdict: "BLOCKED", why: c\.why \};/g) || []).length;
    const calls = (runner.match(/await confirmTarget\(/g) || []).length;
    return guards === calls && calls >= 2 && /대상이 정해지지 않음/.test(runner);
  });
  check("한 시나리오의 실패는 그 후속만 막는다", () =>
    /const blockedBy = \(s\.needs \|\| \[\]\)\.filter\(\(n\) => done\.get\(n\) === false\)/.test(runner)
    && /선행이 실패했다/.test(runner));
  check("의존이 고리를 이루면 실행 전에 잡는다", () =>
    /시나리오 의존이 고리를 이룬다/.test(runner));
  check("계획은 실행 전에 통째로 본다 — 절반 실행을 남기지 않는다", () =>
    /const errs = checkPlan\(plan\);[\s\S]{0,200}실행하면 절반만 밟은 상태가 남는다/.test(runner));
  check("한 단계는 한 조작이다", () =>
    /한 단계는 한 조작이다 \(지금 \$\{verbs\.length\}개\)/.test(runner));
  check("격리를 셸로 되돌리는 계획은 러너가 실행하지 않는다", () =>
    /러너가 실행하지 않는다/.test(runner));
  check("계획 단계마다 회차 장부에 좌표가 실린다", () =>
    /step_id: a\.step_id \|\| undefined,\s*\n\s*scenario_id: a\.scenario_id \|\| undefined,/.test(srvP)
    && /const tag = \{ step_id: step\.id, scenario_id: ctx\.scenarioId \};/.test(runner));
  check("밟지 못한 계획 단계를 따로 센다", () =>
    /const notRun = planned\.filter\(\(p\) => !ran\.has\(p\)\)/.test(runner));
}

}
