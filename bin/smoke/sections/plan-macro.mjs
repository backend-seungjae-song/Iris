// 소유 범위: 매크로. 아는 구간은 건너뛰되 판정은 유지하고, 빗나가면 강등하고 격리를 복원한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/plan-macro.mjs
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
console.log("[12b] 매크로 — 아는 구간은 지나가되 판정은 그대로");
{
  const runner = read("bin/qa-plan.mjs");
  check("매크로도 판정을 다 돌린다(생략하는 것은 해석이지 판정이 아니다)", () =>
    /runSteps\(macro\.steps, \{ \.\.\.ctx, macroName: step\.macro \}, \{ fast: true \}\)/.test(runner)
    && /생략하는 것은 중간 화면의 해석이지 판정이 아니다/.test(runner));
  check("로컬·비유출이 아니면 매크로를 안 쓴다", () =>
    /if \(!ctx\.local\) return "배선이 로컬·비유출로 확인되지 않았다"/.test(runner));
  check("사람·비밀 값이 낀 단계는 매크로에 안 들어간다", () =>
    /kind === "credential" \|\| kind === "human_only"/.test(runner));
  check("로컬 여부는 선언이 아니라 현재 주소를 봐서 정한다", () =>
    /localhost\|\\\[::1\\\]/.test(runner) && /const r = await post\("url"/.test(runner));
  check("빗나가면 중단이 아니라 강등이고, 먼저 격리를 되돌린다", () =>
    /kind: "macro_miss"/.test(runner)
    && /const r = await resetScenario\(ctx\.scenario, ctx\)/.test(runner));
  check("강등은 매크로 구간이 아니라 시나리오를 처음부터 다시 밟는다", () =>
    // 격리를 복원하면 앞 단계가 만든 상태도 사라진다. 매크로 구간만 다시 실행하면 선행 상태가
    // 없는 채로 진행된다(확인 결과: 장바구니가 빈 채로 결제가 실행돼 판정이 실패했다).
    /return \{ restart: step\.macro \}/.test(runner)
    && /if \(out\.restart\)/.test(runner)
    && /noMacro: true/.test(runner));
  check("빠른 경로와 차근한 경로가 실제로 다르다", () =>
    // 같으면 강등은 이름뿐이고 매크로가 아낀 시간도 없다.
    /SETTLE = \{ fast: \{ tries: 2, ms: 250 \}, careful: \{ tries: 6, ms: 500 \} \}/.test(runner)
    && /if \(ctx\.degraded && step\.action && res\.verdict === "PASS"\)/.test(runner));
  check("아직 안 그려진 것과 잘못된 대상을 가른다", () =>
    /아직 없는 것을 없다고 단정하지 않는 것이다/.test(runner)
    && /await post\("wait", \{ tab: ctx\.tab \}, ctx\.runId\)/.test(runner));
  check("회차를 닫는 시점은 부른 쪽이 정한다 — 다른 계측기가 합류할 자리", () =>
    /const ended = keepOpen \? \{ data: \{\} \}/.test(runner));
  check("다른 계측기 몫인 단계는 러너가 건너뛴다", () =>
    /if \(step\.external\) continue;/.test(runner)
    && /external인데 조작이 적혀 있다/.test(runner));
  check("되돌릴 수단이 없으면 강등하지 않고 멈춘다", () =>
    /중간 상태를 안고 다시 밟으면 무엇이 매크로 탓인지 갈리지 않는다/.test(runner));
  check("두 번 연속 빗나가면 stale로 두고 더 안 쓴다", () =>
    /if \(rec\.misses >= 2\) rec\.stale = true;/.test(runner));
  check("빗나간 자리를 기대·실제로 남긴다", () =>
    /expected_screen:/.test(runner) && /actual_screen:/.test(runner));
}

}
