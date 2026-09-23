// 소유 범위: QA 회차·영수증·증거 도구, 잠깐 뜬 알림 포착, 사람에게 요청하는 지점, 보고서 기준.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/qa-evidence-tools.mjs
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
  httpHandler, main, mainJs, mcp, mcpApp, mcpReport, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("\n[10h] 스크린샷은 증거가 된다");
{
  const cdp = read("native/electron/cdp-control.cjs"), capture = cdpCmdCaptureSource,
        mcp = read("bin/iris-mcp.mjs"), cli = read("bin/iris-browser.mjs");
  check("표시를 그리고 찍은 뒤 지운다", () => /\(\$\{DRAW_MARKS\}\)/.test(capture)
    && /__ac_marks__/.test(capture) && /if\(n\)n\.remove\(\)/.test(capture));
  check("표시는 선택자와 snapshot ref 둘 다", () => /async function rectOf/.test(cdpCaptureToolsSource)
    && /if \(m\.ref\)/.test(cdpCaptureToolsSource) && /if \(!m\.sel\) return null/.test(cdpCaptureToolsSource));
  check("안 보이는 탭도 찍힌다", () => /cdp-capture-slow/.test(capture) && /wc\.capturePage\(/.test(capture));
  check("가림은 비밀용", () => /mask: true/.test(capture) && /masks\.map/.test(capture));
  check("가림 표식은 내용을 덮는다", () => /background:#111/.test(cdp));
  check("MCP에 표시·설명 인자", () => /name: "browser_screenshot"/.test(mcp) && /caption:/.test(mcp) && /mark:/.test(mcp));
  check("보고서 도구", () => /name: "browser_report"/.test(mcp) && /function buildReport/.test(mcpReport)
    && /data:image\/png;base64/.test(mcpReport));
  // 찍은 파일은 60장·7일 기준으로 정리된다. 회차가 열려 있지 않으면 장면이 회차 폴더에 저장되지
  // 않아 보고할 때 앞부분이 이미 삭제돼 있고, 게이트는 그것을 "안 찍었다"와 구별하지 못한다.
  // 실제로 회차를 여는 단계가 어느 절차에도 없어 browser_run 실호출이 0회인 채로
  // 2,481장을 찍고 62장만 남은 적이 있다. 그래서 회차는 메모리가 아니라 구조로 연다.
  check("증거 도구는 회차를 스스로 연다", () =>
    /const EVIDENCE_TOOLS = new Set\(/.test(mcp)
    && /async function ensureRun\(name\)/.test(mcp)
    && /await ensureRun\(t\.name\);/.test(mcp)                     // 도구가 돌기 전에 열린다
    && /if \(CURRENT_RUN \|\| !EVIDENCE_TOOLS\.has\(name\)\) return;/.test(mcp)  // 조회는 안 연다
    && ["browser_screenshot", "browser_expect", "browser_observe", "browser_diff",
        "app_screenshot", "app_expect", "app_observe"]
         .every((t) => new RegExp(`"${t}",`).test(sliceBetween(mcp, "const EVIDENCE_TOOLS", "async function ensureRun", "증거 도구는 회차를 스스로 연다"))));
  // 앱은 idb를 직접 부르므로 서버를 지나지 않는다. 장면을 장부에 직접 제출하지 않으면
  // 회차 폴더에 저장되지 않고, 저장되지 않은 장면은 정리에 밀려 보고서에서 사라진다.
  // QA는 기대와 실제를 대조하는 일인데 기대의 출처가 없으면 화면을 보고 만든 기대가
  // 구현을 그대로 통과시킨다. 잘못 만들어진 화면도 통과하므로 그 통과는 아무것도 보증하지 않는다.
  // 적는 것은 강제하되 무엇을 적을지는 열어 둔다(출처가 없으면 assumed). 그래야 없는 출처를
  // 지어내지 않는다.
  // 확인하기로 한 것이 없으면 빠뜨린 항목이 어디에도 남지 않는다. 목록에 없던 항목은 빠져도
  // 드러나지 않고, 읽는 사람은 그 사실을 알 수 없다. 그리고 회차에 종류가
  // 남지 않으면 지난 회차를 기계가 찾을 수 없어 회귀 비교의 전제가 없다.
  // 확인할 것을 전부 전이로 적으면 같은 화면에서 한꺼번에 볼 수 있는 항목이 서로 다른
  // 시나리오로 흩어져 같은 상태를 여러 번 다시 만든다. 확인할 항목 수는 그대로인데 도달
  // 횟수만 늘어난다. 둘을 나누고, 상태에 도달했을 때 그 상태의 관찰을 한 번에 소진한다.
  check("계획은 전이와 관찰을 가른다", () => {
    const plan = read("bin/qa-plan.mjs");
    return /"observations", "params"/.test(plan)                     // 계약 최상위에 관찰
      && /const OBS = new Set\(/.test(plan)                          // 관찰의 허용 필드
      && /observations를 쓰려면 from·to가 있어야 한다/.test(plan)     // 관찰이 매달릴 상태가 있어야
      && /전이가 만들지 않는 상태를 가리킨다/.test(plan)              // 없는 상태는 거부
      && /async function sweepObservations/.test(plan)                // 도착한 상태에서 한 번에 소진
      && /seen\.has\(o\.id\)/.test(plan)                             // 같은 관찰을 두 번 보지 않는다
      && /notObserved/.test(plan)                                     // 못 본 관찰이 곧 빠뜨린 확인
      // 도착 상태만 검사하면 어느 전이도 도달하지 않는 상태(대개 첫 화면)의 관찰이 계속
      // "못 봄"으로 남는다(확인 결과: 관찰 0/3 → 출발 상태까지 검사해 3/3).
      && /if \(from && from\.from\) results\.push\(\.\.\.await sweepObservations\(from\.from/.test(plan)
      && /if \(trans && trans\.to\) results\.push\(\.\.\.await sweepObservations\(trans\.to/.test(plan);
  });
  check("확인하기로 한 것과 회차 종류가 남는다", () =>
    /kind: \{ type: "string", enum: \["review", "proof", "regression", "handoff"\]/.test(mcp)
    && /agreed: \{ type: "array"/.test(mcp)
    && /enum: \["start", "mid"\]/.test(mcp)                     // 도중에 더한 것이 구별된다
    && /확인하기로 한 것이 없다\. run\.agreed/.test(mcp)          // 없으면 보고서가 안 나간다
    && /const agreedBlock = /.test(mcpReport)                          // 지면에 표시된다
    && /확인하기로 한 것 \$\{agreedList\.length\}/.test(mcpReport)
    && /kind: String\(kind \|\| "review"\), agreed: agreedList/.test(mcpReport));  // 회차에 남는다
  check("기대의 출처가 보고서에 실린다", () => {
    const src = sliceBetween(mcpReport, "const BASIS = {", "function buildReport", "기대의 출처가 보고서에 실린다");
    return /const BASIS = \{/.test(mcpReport)
      && ["spec", "plan", "code", "user", "assumed"].every((k) => new RegExp(`${k}: \\{ label:`).test(src))
      && /basis: \{ type: "string", enum: \["spec", "plan", "code", "user", "assumed"\]/.test(mcp)  // 스키마
      && /basisNote: \{ type: "string"/.test(mcp)
      && /기대가 어디서 왔는지 없다/.test(mcp)                       // 출처 없는 통과는 거부
      && /basisNote가 비었다/.test(mcp)                              // 출처만 고르고 비워둔 것도 거부
      && /const basisLine = basisMeta/.test(mcpReport)                     // 지면에 그린다
      && /const assumedBlock = basisKey === "assumed"/.test(mcpReport)     // 지어낸 것은 눈에 띈다
      && /\.assumed\{/.test(mcpReport);                                    // 그 블록의 스타일
  });
  check("앞 회차를 이어받고 그 사실이 지면에 남는다", () => {
    // 이어받는 방법이 없으면 조각 보고서를 따로 내거나 처음부터 다시 확인해야 한다.
    return /function resumeSteps/.test(mcpReport)
      && /st\.verdict === "pass" && !redo\.has/.test(mcpReport)                      // 통과분만, redo는 뺀다
      && /const allSteps = \[\.\.\.res\.carried, \.\.\.\(steps \|\| \[\]\)\]/.test(mcpReport)   // 앞에 놓인다
      && /const n = allSteps\.length/.test(mcpReport)                                // 집계도 함께 센다
      && /const reqs = allSteps\.map/.test(mcpReport)                                // 인덱스가 어긋나지 않는다
      && /이번 회차 미실행/.test(mcpReport)                                    // 단계마다 적힌다
      && /const resumeBlock/.test(mcpReport)                                         // 맨 앞 요약에도
      && /resumedFrom: res\.from \|\| null/.test(mcpReport);                         // 다음 회차가 또 이어받게
  });
  check("회차 기록에 단계별 결과가 남는다", () =>
    // 단계 '수'만 남으면 다음 회차가 무엇을 이어받을 수 있는지 알 방법이 없다.
    /const stepBook = allSteps\.map/.test(mcpReport)
    && /steps: stepBook/.test(mcpReport)
    && /verdict: handoff \? "info" : built\[i\]\.v/.test(mcpReport));
  check("아무것도 확인하지 않은 회차는 보고서가 되지 않는다", () => {
    // 공집합은 모든 규칙을 만족하므로 0단계 회차가 가장 문제 없는 보고서로 나온다.
    // 원장 회차만 예외다. 페이지가 장부를 그리므로 직접 쓸 단계가 없다. 그 예외는
    // "장부에 닫힌 줄이 있는가"에 걸려 있어야 아무것도 하지 않은 회차와 구별된다.
    return /if \(!steps\.length && !ledgerRows && !\(a\.resume && a\.resume\.from\) && String\(a\.kind \|\| ""\) !== "handoff"\)/.test(mcp)
      && /e\.kind === "row" && e\.act === "close"/.test(mcp)
      && /단계가 하나도 없다\. 확인한 것이 없으면 보고서가 아니다/.test(mcp)
      && /const nothingChecked = !reqs\.length/.test(mcpReport)                    // 결론도 거짓말하지 않는다
      && /확인한 것이 없음/.test(mcpReport);
  });
  // 원장 회차는 단계가 0이다. 그 수를 그대로 말하면 부르는 쪽이 "0단계 · 확인 0건"이라 적어,
  // 줄 셋이 있는 보고서가 아무것도 확인하지 않은 회차처럼 읽힌다.
  check("원장 회차는 단계가 아니라 줄로 센다", () =>
    /const ledTally = led && led\.rows\.length/.test(mcpReport)
    && /\.\.\.\(ledTally \? \{ ledger: ledTally \} : \{\}\)/.test(mcpReport)
    && /const led = r\.ledger \|\| d\.ledger/.test(mcp)
    && /줄 \$\{led\.rows\}개/.test(mcp));
  // 회차를 전달하도록 적어 놓고 그 인자를 받지 않으면 값이 버려지고 세션 기본값이 쓰인다.
  // 회차 둘이 겹치는 순간 다른 회차의 줄이 되며, 거절문에서 이 문제가 드러났다.
  check("회차를 다루는 도구는 runId를 다 받는다", () => {
    for (const name of ["browser_run", "browser_row", "browser_report"]) {
      const i = mcp.indexOf(`name: "${name}"`);
      if (i < 0) return false;
      const blk = mcp.slice(i, mcp.indexOf("\n  { name:", i + 10));
      if (!/\n\s*runId: \{ type: "string"/.test(blk)) return false;
    }
    // 받기만 하고 쓰지 않으면 같은 문제가 생긴다. 전달된 값이 세션 기본값보다 우선한다.
    return !/runId: CURRENT_RUN \|\| undefined/.test(mcp)
      && /runId: a\.runId \|\| CURRENT_RUN \|\| undefined/.test(mcp);
  });

  // 소스 모양만으로는 이 거절이 실제로 동작하는지 알 수 없어, 함수를 분리해 네 경우를 호출한다.
  // 한 회차에서 영수증 셋이 묻지 않은 질문의 답으로 만들어졌고, 그 셋은 페이지에서
  // 실제 통과와 구별되지 않았다.
  check("스키마 밖 인자와 값은 판정하지 않고 거절한다", () => {
    const a1 = mcp.indexOf("function argFault(t, a)");
    if (a1 < 0) return false;
    const a2 = mcp.indexOf("\n}", mcp.indexOf("return null;", a1)) + 2;
    const body = mcp.slice(a1, a2);
    if (!/schemaOf\(t\)/.test(body)) return false;        // 목록과 같은 표를 봐야 한다
    const g = { schemaOf: (t) => t.schema };
    const argFault = new Function("schemaOf", "return " + body.replace(/^function argFault/, "function"))(g.schemaOf);
    const t = { name: "browser_expect", schema: { selector: {}, text: {}, tab: {},
      mode: { enum: ["contains", "equals", "exists", "absent"] } } };
    const unknown = argFault(t, { selector: "x", value: "매물 승인" });
    const badMode = argFault(t, { selector: "x", mode: "count" });
    return typeof unknown === "string" && /value/.test(unknown) && /text/.test(unknown)   // 다음에 할 일을 준다
      && typeof badMode === "string" && /contains/.test(badMode) && /count/.test(badMode)
      && argFault(t, { selector: "x", mode: "absent", text: "중지", tab: "@a" }) === null  // 바른 호출은 통과
      && argFault(t, { selector: "x", _meta: 1 }) === null;                                // 호출자 메타는 인자가 아니다
  });
  check("거절 문은 도구가 돌기 전에 선다", () =>
    // 도구가 먼저 돌면 판정과 장면이 이미 만들어진 뒤라 거절이 아무것도 되돌리지 못한다.
    /const fault = argFault\(t, a\);\n\s*if \(fault\)/.test(mcp)
    && mcp.indexOf("const fault = argFault(t, a);") < mcp.indexOf("await ensureRun(t.name);"));
  check("버린 구간은 지면과 기록에 남는다", () =>
    // 뺀 사실이 안 보이면 게이트에서 그 구간의 위반이 지워졌다는 것을 읽는 사람이 모른다.
    /const discardList = \(Array\.isArray\(R\.discarded\)/.test(mcpReport)
    && /결과 근거에서 뺀 구간/.test(mcpReport)
    && /\$\{discardBlock\}/.test(mcpReport)
    && /discarded: discardList/.test(mcpReport)
    && /discarded: \{ type: "array"/.test(mcp));
  check("합의한 것과 판정한 단계 수를 맞대어 둔다", () =>
    /const agreedGap = \(!handoff && agreedList\.length && reqs\.length < agreedList\.length\)/.test(mcpReport)
    && /확인하기로 한 것은 \$\{agreedList\.length\}개인데 판정한 단계는 \$\{reqs\.length\}개다/.test(mcpReport));
  check("이어받기가 밟지 않은 것을 통과로 만들지 않는다", () => {
    // 둘 다 회차 없이 통과를 만드는 우회다.
    return /if \(a\.resume && a\.resume\.from && !steps\.length && !ledgerRows\)/.test(mcp)   // 이어받기만으론 회차가 아니다
      && /이어받기만으로는 회차가 되지 않는다/.test(mcp)
      && /String\(m\.kind \|\| ""\) === "handoff"/.test(mcpReport)                  // 넘기기는 이어받을 수 없다
      && /넘기기 문서는 판정이 아니라 절차다/.test(mcpReport);
  });
  check("페이드로 뜨는 알림도 잡는다", () => {
    // class가 바뀌는 시점에는 아직 투명하다. 그때만 측정하면 실제 토스트를 하나도 잡지 못한다.
    const c = cdpObservationSource;
    return /var pending = new Map\(\)/.test(c)
      && /if \(!pending\.has\(el\) && txt\(el\)\) pending\.set\(el, Date\.now\(\)\)/.test(c)
      && /pending\.forEach\(function\(t0, el\)/.test(c)
      && /if \(shown\(el\)\) born\(el\)/.test(c)
      // 문서가 생기기 전에도 이 스크립트가 실행된다. observe가 던진 예외를 바깥 try가 삼켜서
      // 관찰자가 붙지 않은 채 플래그만 설정돼 있었다(확인 결과: 즉시 보이는 알림도 0건).
      && /if \(\+\+tries < 100\) setTimeout\(attach, 30\)/.test(c)
      && /var root = document\.documentElement \|\| document\.body \|\| document/.test(c)
      && /attach\(\);/.test(c)                                                     // 실제로 부른다
      // 알림 하나를 같은 요소에 재사용하는 앱이 많다. 요소로만 집계하면 두 번째부터 누락된다.
      && /if \(!nowText \|\| nowText === was\.text\) return;/.test(c)
      // 이 도구가 그린 판정 표시가 "잠깐 뜬 알림"으로 보고서에 포함된 적이 있다(확인 결과).
      && /el\.closest\('\[id\^="__ac"\]'\)/.test(c)
      && /if \(!floating\(el\) \|\| mine\(el\)\) return;/.test(c);
  });
  check("잠깐 뜬 알림을 뜨는 그 순간에 찍는다", () => {
    // 조작하고 나서 찍으면 이미 없다. 그래서 관찰자를 탭에 상시 심고 페이지가 Node를 부른다.
    const c = cdpObservationSource, wiring = cdpSessionSource;
    return /const MOMENT_BINDING = "__irisMoment"/.test(c)
      && /Runtime\.addBinding", \{ name: MOMENT_BINDING \}/.test(c)              // 통로
      && /source: MOMENT_WATCH, runImmediately: true/.test(c)                   // 이동해도 다시 걸린다
      && /observation\.prime\(send\)/.test(wiring)
      && /observation\.momentPayload\(method, params\)/.test(wiring)
      && /async function noteMoment\(wcId, send, m\)/.test(c)
      && /observation\.noteMoment\(wc\.id, momentSend, moment\)/.test(wiring)
      && /Page\.captureScreenshot", \{ format: "png" \}/.test(c)                 // 그 자리에서 찍는다
      // 조작이 걸어 둔 hold를 함께 쓰면 애니메이션 없이 뜨는 알림은 hold가 풀린 뒤에 찍혀
      // 빈 그림이 남는다(확인 결과). 촬영은 자체 hold를 잡는다.
      && /held = await captureHold\(wcId, true\)/.test(c)
      && /finally \{ if \(held\) \{ try \{ await captureHold\(wcId, false\); \} catch \{\} \} \}/.test(c)
      && /rec\.shotError = "빈 그림이 왔다"/.test(c)                              // 못 찍은 것을 조용히 두지 않는다
      && /rec\.shotError = "찍는 데 3초가 넘었다"/.test(c)                         // 매달린 채 남지 않게
      && /moment-" \+ now\(\)/.test(c);
  });
  check("capture hold는 겹친 참조를 마지막 release까지 보존한다", () => {
    const holds = require_("../native/electron/capture-hold.cjs");
    const id = "smoke-nested";
    holds.clear(id);
    const outer = holds.update(id, true);
    if (!outer.edge || holds.count(id) !== 1) throw new Error("첫 hold를 기록하지 않는다");
    const inner = holds.update(id, true);
    if (inner.edge || holds.count(id) !== 2) throw new Error("겹친 hold를 따로 세지 않는다");
    const innerRelease = holds.update(id, false);
    if (innerRelease.edge || holds.count(id) !== 1) throw new Error("안쪽 release가 바깥 hold까지 푼다");
    const outerRelease = holds.update(id, false);
    if (!outerRelease.edge || holds.count(id) !== 0) throw new Error("마지막 hold가 풀리지 않는다");
    const unmatched = holds.update(id, false);
    if (unmatched.after !== 0 || holds.count(id) !== 0) throw new Error("짝 없는 release가 음수로 내려간다");
    holds.clear(id);
    return true;
  });
  check("사라진 알림은 어느 명령에서든 결과에 얹혀 나온다", () => {
    // 관찰자가 모아도 꺼내는 경로가 없으면 없는 기능과 같다.
    const c = cdpObservationSource, wiring = read("native/electron/cdp-control.cjs");
    return /function drainMoments/.test(c)
      && /out\.moments = ms\.list; ms\.commit\(\)/.test(wiring)                 // 모든 명령 결과에
      // 실은 뒤에만 전송 표시를 한다. 커서로 시각을 옮기면 결과가 객체가 아닌 명령(eval)이
      // 알림을 버린다. 촬영 중인 항목은 남겨 다음 결과에 싣는다. 지금 내면 "못 찍었다"로 기록된다.
      && /!m\.sent && \(m\.shot \|\| m\.shotError \|\| at - m\.ts > MOMENT_SETTLE_MS\)/.test(c)
      && /commit: \(\) => \{ for \(const m of fresh\) m\.sent = true; \}/.test(c)
      && /moments: buf\.moments\.slice\(-limit\)/.test(c)                        // observe에도
      && /moments: pick\(b\.moments\)/.test(c);                                  // logs에도
  });
  check("안 보이는 탭에서도 조작 뒤 화면이 실제로 그려진다", () => {
    // 배경 탭은 프레임을 만들지 않아 CSS 트랜지션이 시작 시각을 받지 못한다. 확인 결과
    // 토스트가 9.9초 동안 opacity 0으로 멈춰 있다가 캡처가 프레임을 강제한 순간 시작했고,
    // 그 전에 찍은 스크린샷에는 토스트가 없었다. Page.startScreencast로는 숨은
    // webview에서 프레임이 나오지 않는다(확인 결과). 캡처 경로와 같은 hold를 조작 뒤에도 건다.
    const c = cdpObservationSource, wiring = read("native/electron/cdp-control.cjs");
    return /const ANIMATES = new Set\(\["click", "dblclick"/.test(c)
      && /async function settleAnimations/.test(c)
      && /a\.playState !== "running"/.test(c)                                    // 도는 것이 없으면 곧바로 논다
      && /t\.iterations === Infinity/.test(c)                                    // 스피너를 세면 매번 상한을 태운다
      && /const wantsFrames = observation\.animates\(cmd\)/.test(wiring)          // 실제로 부른다
      && /if \(held && wantsFrames\) await observation\.settleAnimations\(send\)/.test(wiring)
      && /!wantsKeys && !wantsFrames/.test(wiring)                               // 키 붙잡기와 하나로 묶어 두 번 잡지 않는다
      && !/pulseFrames/.test(readAll("native"));                                // 안 되는 길은 native 어디에도 두지 않는다
  });
  check("처음 보는 알림만 판정을 요구한다", () => {
    // 완성된 제품의 모든 알림에 판정을 요구하면 비용이 과도하므로, 지문으로 새 알림만 구분한다.
    return /const NOTICE_BOOK = path\.join\(IRIS_HOME, "notices\.json"\)/.test(mcp)
      && /async function absorbMoments/.test(mcp)
      && /kind: "artifact", source: "moment", shot/.test(mcp)                   // 회차에 굳힌다
      && /처음 보는 알림/.test(mcp)
      && /const moment = await absorbMoments\(r\)/.test(mcp);                    // 실제로 부른다
  });
  check("사람을 부를 때 답을 부르는 쪽이 정한다", () => {
    // 서버가 정해 둔 "다 했어요/못 하겠어요"만으로는 상황마다 다른 답을 받을 수 없다.
    // 첫 번째가 진행을 뜻한다는 약속이 서버·도구 양쪽에 있어야 한다.
    const srv = read("server/browser-commands.js"), ui = readAll("web");
    return /choices: \{ type: "array"/.test(mcp)
      && /choices: Array\.isArray\(a\.choices\)/.test(mcp)
      && /done: answer === "다 했음" \|\| !!\(choices && choices\.length && answer === choices\[0\]\)/.test(srv)
      && /choices: choices && choices\.length \? choices : undefined/.test(srv)
      && /data-ans="\$\{esc\(c\)\}"/.test(ui)
      && /choices: m\.choices/.test(ui);
  });
  check("부를 자리가 앱이면 앱으로 데려간다", () => {
    const commands = read("server/browser-commands.js"), messages = read("server/browser-message-handlers.js"), ui = readAll("web");
    return /const askDevice = args && args\.device != null/.test(commands)
      && /where: askDevice \? "app" : "tab"/.test(commands)
      && /msg\.type === "focus-app"/.test(messages)
      && /execFileSync\("open", \["-a", "Simulator"\]/.test(messages)
      && /label: "그 앱으로"/.test(ui)
      && /device: \{ type: "string"/.test(mcp);
  });
  check("대량 기입 승인은 승인·취소로 묻는다", () =>
    /choices: \["승인", "취소"\]/.test(mcp));
  check("고른 답을 문장에 넣을 때 조사를 맞춘다", () => {
    // "승인를"이 나오면 그 문장을 쓴 쪽을 사람이 덜 믿는다.
    const srv = readAll("server");
    return /function 을를\(word\)/.test(srv)
      && /return \(c - 0xac00\) % 28 \? "을" : "를";/.test(srv)
      && /\$\{answer\}"\$\{을를\(answer\)\} 골랐습니다/.test(srv);
  });
  check("캡션 몫은 상수가 아니라 잰 값이다", () => {
    // 상수로 빼면 캡션이 길어질 때 그림+캡션이 트랙을 넘고, .fr이 수직 중앙정렬이라 넘친 양의
    // 절반이 아래로 밀려 캡션 마지막 줄이 잘린다(확인 결과: 장면 87장 중 16장이 12~21px
    // 초과였고, 창을 키우면 사라지는 창 크기 의존 증상이었다).
    return /max-height:calc\(var\(--sh\) - var\(--cap, 40px\)\)/.test(mcpReport)
      && /function fitCaptions\(\)/.test(mcpReport)
      && /stage\.style\.setProperty\("--cap"/.test(mcpReport)
      && /addEventListener\("resize", fitCaptions\)/.test(mcpReport)
      && !/max-height:calc\(var\(--sh\) - 40px\)/.test(mcpReport);
  });
  check("보고서 지면은 항상 라이트다 — 다크 정의를 두지 않는다", () => {
    // 보는 사람의 OS 설정에 따라 바탕이 뒤집히면 같은 판정이 다른 색으로 읽히고, 인쇄·공유된
    // 사본과도 달라진다. 정본은 report-profile references/report-page.md, 같은 것을
    // check-report.mjs가 본다. 여기서는 그 규칙이 실제로 지켜지는지 검사로 강제한다.
    const tpl = sliceFrom(mcpReport, "const html = `<!doctype html>", mcpReport.length, "보고서 지면은 항상 라이트다 — 다크 정의를 두지 않는다");
    return !/prefers-color-scheme/.test(tpl)
      && /:root\{color-scheme:light;/.test(tpl)
      && /--bg:#fff;--bg2:#fafafa;--fg:hsl\(0 0% 7%\);--card:#fff/.test(tpl);
  });
  check("보고서는 Iris 탭으로 열린다 — 크롬으로 보내지 않는다", () => {
    // 파일 경로만 건네면 OS 기본 브라우저가 연다. 그러면 사용자가 보는 화면이 이 앱 밖으로
    // 나가 세션·스페이스가 끊기고, 그 화면에서 바로 다시 확인할 수도 없다.
    return /async function openInIris/.test(mcp)
      && /call\("newtab", \{\s*\n?\s*url: "file:\/\/" \+ res\.path, parallel: true/.test(mcp)
      && /return await openInIris\(buildReport\(/.test(mcp)        // 실제로 부른다
      && /Iris 탭 \$\{tab\} 으로 열어 두었다/.test(mcp);            // 지면에 알린다
  });
  check("가로로 긴 장면은 폭으로 자리를 잡는다", () => {
    // 영역 높이를 창 높이로만 잡으면 가로로 긴 웹 캡처가 페이지 폭을 남긴 채 축소된다
    // (확인 결과: 1920폭 캡처가 1266px = 66%로, 페이지 1760px 중 494px이 비었다).
    return /const wide = sizes\.length === live\.length && sizes\.length > 0/.test(mcpReport)
      && /sizes\.every\(\(d\) => d\.w \/ d\.h >= 1\.2\)/.test(mcpReport)          // 가로형 판정
      && /wide \? Math\.min\(\.\.\.sizes\.map\(\(d\) => d\.w \/ d\.h\)\)/.test(mcpReport)  // 가장 높은 장면 기준
      && /stage\$\{wide \? " wide" : ""\}/.test(mcpReport)                          // 지면에 표시
      && /const ih = wide \? Math\.max\(\.\.\.sizes\.map\(\(d\) => d\.h\)\)/.test(mcpReport)  // 원본 높이도 넘긴다
      && /--ih:\$\{ih\}px/.test(mcpReport)
      && /\.stage\.wide\{--sh:min\(calc\(var\(--ih\) \* 0\.8 \+ 46px\)/.test(mcpReport)   // 배율을 못박는다
      && /calc\(\(100vw - 96px\) \/ var\(--ar\) \+ 46px\)/.test(mcpReport);                // 좁은 창은 폭이 이긴다
  });
  check("검토 지면은 창을 다 쓴다", () =>
    /\.wrap\.rev\{max-width:min\(2400px, calc\(100vw - 40px\)\)\}/.test(mcpReport));
  check("앱 장면도 회차 장부로 간다", () =>
    /kind: "artifact", source: "app", shot: p/.test(mcpApp)              // app_screenshot
    && /kind: "artifact", source: "app", shot, caption: "지금 상태"/.test(mcpApp));  // app_observe
  check("CLI도 같은 표면", () => /case "screenshot": \{/.test(cli) && /--mark/.test(cli) && /--caption/.test(cli));
  // 화면을 읽고 "됐다"고 적는 것은 판정이 아니라 인상이다. 통과는 도구가 요소를 찾아 값을 읽은
  // 사실(영수증)에서만 나오고, 근거 없는 통과·기록과 어긋나는 통과는 보고서가 거부한다.
  check("통과는 영수증에서만 나온다", () =>
    /const receipts = \[\]/.test(mcpReport) && /function receiptById/.test(mcpReport)
    && /r\.data\.receipt = rc\.id/.test(mcp)                       // expect가 영수증을 돌려준다
    && /통과 근거가 없다/.test(mcp) && /통과로 적을 수 없다/.test(mcp)
    && /return \{ ok: false, error: "통과는 도구가 확인한 사실에서만 나온다/.test(mcp));
  // 실행 중 부른 판정이 보고서에서 빠지는 경로를 막는다. 빠진 항목은 보고서가 직접 적는다.
  // 한 화면에서 볼 것이 여럿이면 하나만 찍고 나머지를 글로 적게 되지만 글은 확인이 아니다.
  // 확인마다 자기 영수증과 장면을 갖는다.
  check("한 화면에서 여러 곳을 확인한다", () =>
    /Array\.isArray\(s\.receipts\) \? s\.receipts : \(s\.receipt \? \[s\.receipt\] : \[\]\)/.test(mcpReport)
    && /rcs\.slice\(rc \? 1 : 0\)\.map/.test(mcpReport));                     // 나머지 확인도 자기 장면을 얻는다
  // 장면은 같은 영역에서 교체된다. 영역 높이를 한 곳(--sh)에서 정하고 사진을 그 안에 맞춰야
  // 한 장이 카드를 넘지 않고 여러 장이 서로 작아지지도 않는다.
  check("장면은 자리를 넘지 않는다", () =>
    /\.stage\{margin:0;--sh:max\(/.test(mcpReport)
    && /\.track\{position:relative;height:var\(--sh\)/.test(mcpReport)
    && /\.fr \.frame img\{max-height:calc\(var\(--sh\)/.test(mcpReport)
    && /#lb \.frame img\{max-height:calc\(100vh - /.test(mcpReport));   // 크게 보기도 창 안에 맞춘다
  // 이 보고서는 대개 PDF로 넘어간다. 종이에는 눌러 펼치기가 없으니 처음 보이는 크기가 곧 판정
  // 가능한 크기여야 하고, 가로 화면과 세로 화면은 페이지에서 배치 방법이 다르다.
  check("종이에서도 판정할 수 있다", () =>
    /@media print\{/.test(mcpReport)
    && /function pngSize/.test(mcpReport) && /d\.h \/ d\.w >= 1\.2/.test(mcpReport)      // 크기를 재서 갈라 놓는다
    && /\.shots\.pair\{grid-template-columns:1fr\}/.test(mcpReport)               // 가로는 한 줄에 하나
    && /\.shots\.pair\.tall\{grid-template-columns:repeat\(auto-fit/.test(mcpReport) // 세로만 나란히
    && /figure\{break-inside:avoid/.test(mcpReport)                               // 그림은 안 쪼갠다
    && /--bg:#fff/.test(mcpReport));                                              // 어두운 배경은 종이에서 잉크만 먹는다
  // 실행 순서대로만 배치하면 안 된 것을 찾으려고 전부 읽어야 한다. 읽는 순서는 다르다.
  // 이 회차를 믿을 만한가, 무엇이 안 됐나, 나머지 확인 순이며 배치가 그 순서를 따른다.
  // 통과한 단계는 한 줄로 표시한다. 지문(시각·다룬 데이터·붙은 곳)이 같은 세로 위치에 있어야
  // 훑는 것만으로 불일치가 보인다. 문장 속에 섞으면 읽어야 알 수 있어 확인되지 않는다.
  check("훑는 표는 지문을 세로로 세운다", () =>
    /<table class="walk">/.test(mcpReport)
    && /<th>시각<\/th><th>단계<\/th><th>다룬 데이터<\/th><th>붙은 곳<\/th>/.test(mcpReport)
    && /esc\(s\.at \|\| ""\)/.test(mcpReport) && /esc\(s\.entityId \|\| "—"\)/.test(mcpReport)
    && /esc\(s\.wiring \|\| ""\)/.test(mcpReport)
    && /\.walk td\.t,\.walk td\.id\{font-variant-numeric:tabular-nums/.test(mcpReport)  // 자리가 맞아야 대조된다
    && /\.walk tr\.fail td\{background/.test(mcpReport)
    && /\.walk tr\{break-inside:avoid/.test(mcpReport));                                // 종이에서 행이 안 쪼개진다
  check("미확인은 결과에도 실린다", () =>
    /const unverBlock =/.test(mcpReport) && /unverified: unver\.length/.test(mcpReport)
    && /미확인 \$\{r\.unverified \?\? d\.unverified\}건/.test(mcp));
  // 찍은 파일은 60장·7일 기준으로 정리된다. 보고서에 포함된 장면은 이름을 갖고 실행 폴더에 남아야
  // 다음 회귀의 '전' 장면이자 넘길 문서의 기준 이미지가 된다.
  check("실린 장면은 실행 폴더에 남는다", () =>
    /function runStore/.test(mcpReport) && /function keepShot/.test(mcpReport)
    && /"manifest\.json"/.test(mcpReport) && /artifactDir\("qa"\), runId/.test(mcpReport));
  // 남에게 넘기는 문서는 내 판정이 아니라 기준을 준다.
  // 같은 QA 방식을 앱에도 쓴다. 조건은 하나로, 접근성 트리가 있어 요소를 이름으로 찾아 값을
  // 읽을 수 있어야 한다. 그러면 앱에서도 판정이 인상이 아니라 사실이 된다.
  check("앱도 같은 방식으로 확인한다", () =>
    /name: "app_snapshot"/.test(mcpApp) && /name: "app_expect"/.test(mcpApp) && /name: "app_tap"/.test(mcpApp)
    && /addReceipt\(\{ surface: "app"/.test(mcpApp)                      // 같은 영수증 장부를 쓴다
    && /idb\(\["ui", "describe-all"/.test(mcpApp));
  // 이름은 겹칠 수 있다(한 화면에 "설정"이 둘). 아무거나 누르면 다른 요소를 누른 채 통과한다.
  check("겹치는 이름은 아무거나 누르지 않는다", () =>
    /개가 걸립니다 — type이나 nth로 좁히세요/.test(mcpApp));
  // 앱 스크린샷에는 그림을 그릴 도구가 없어, 표시는 별도 파일에 두고 보고서에서 겹쳐 그린다.
  check("앱 표시는 겹쳐 그린다", () =>
    /markSidecar/.test(mcpReport) && /class="box"/.test(mcpReport) && /function readMarks/.test(mcpReport)
    && /\.marks\.json", "\.caption\.txt"/.test(mcpReport));           // 장면을 옮길 때 표시도 같이
  // 앱에는 탭 개념이 없고, 있으면 모델이 잘못된 인자를 채운다.
  // 앱 도구에는 탭이 아니라 기기가 붙는다. 시뮬레이터를 여럿 켜 두고 동시성을 재현하는 경우가
  // 많아 탭과 같은 규칙으로 목록을 받는다.
  // 인자표는 한 곳(schemaOf)에서 나온다. 목록에 내는 표와 호출을 검사하는 표가 갈리면
  // "목록에는 있지만 검사는 모르는" 인자가 생겨 거절문이 정상 호출을 거부한다.
  check("앱 도구엔 탭이 아니라 기기 인자가 붙는다", () =>
    /function schemaOf\(t\) \{/.test(mcp)
    && /NO_DEVICE\.has\(t\.name\) \? t\.schema : \{ \.\.\.t\.schema, \.\.\.DEVICE_PARAM \}/.test(mcp)
    && /NO_TAB\.has\(t\.name\) \? t\.schema : \{ \.\.\.t\.schema, \.\.\.TAB_PARAM \}/.test(mcp)
    && /inputSchema: \{ type: "object", properties: schemaOf\(t\)/.test(mcp)   // 목록이 그 표를 쓴다
    && /const s = schemaOf\(t\), names = Object\.keys\(s\);/.test(mcp));     // 검사도 같은 표를 쓴다
  // 기기가 여럿이면 고정한 기기로만 간다. 고정한 기기의 탭이 닫히면 조용히 다른 기기로 갈아타지 않는다.
  check("에뮬레이터도 고정할 수 있다", () => {
    const mcp = read("bin/iris-mcp.mjs");
    return /name: "app_target"/.test(mcpApp)
      && /function pinnedDevice\(session\)/.test(mcpApp)
      && /function setPinnedDevice\(session, udid\)/.test(mcpApp)
      && /app-targets\.json/.test(mcpApp)                     // 프로세스가 다시 떠도 유지
      && /if \(list\.some\(\(t\) => t\.udid === pin\)\) return pin;/.test(mcpApp)
      && /\/\/ 고정한 기기의 탭이 닫혔다\. 조용히 다른 기기로 갈아타지 않는다/.test(mcpApp)
      && /async function simTargetError\(want\)/.test(mcpApp);     // 왜 없는지 구분해 말한다
  });
  check("기기도 최대 4대까지 동시에", () =>
    /const MAX_DEVICES = 4;/.test(mcpApp)
    && /async function runOnDevices/.test(mcp)
    && /ok: okCount === per\.length,/.test(mcp)          // 절반만 된 것을 성공이라 부르지 않는다
    && /const appRefsByDevice = new Map\(\)/.test(mcpApp)   // 참조표는 기기마다 따로
    && /name: "app_targets"/.test(mcpApp));
  check("넘기는 문서는 판정 없이 기준만", () =>
    /kind === "handoff"/.test(mcpReport) && /이렇게 보이면 정상/.test(mcpReport));
}

// [10h2] 보고서를 실제로 만들어 본다
// 문자열 포함만 보는 검사는 배치가 바뀌어도 통과한다. 실제로 사진이 있는데 "이미지 없음"이
// 찍혔고 검사는 전부 통과였다. 그래서 여기서는 실제로 렌더해 결과를 확인한다.
}
