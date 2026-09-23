// 소유 범위: bin/iris-mcp.mjs 가 그리는 보고서 페이지. 결론 위치·장면 배치·사진 없는 통과·인쇄 판정·색인.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/qa-report-page.mjs
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  httpHandler, main, mainJs, mcp, mcpReport, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";
// 회차 폴더 이름을 여기서 다시 적지 않는다. 생산자와 값이 갈리면 이 검사가 엉뚱한 위치를 본다.
import { artifactDir } from "../../../server/artifacts-home.cjs";

// 장부 회차는 기본 지면(비개발자용)과 옆의 -dev 지면으로 나뉜다. 확인 기록을 보는 검사는 -dev 를 읽는다.
const devOf = (p) => p.replace(/\.html$/, "-dev.html");

export default async function run() {
console.log("\n[10h2] 보고서 렌더 결과");
{
  const tmp = mkdtempSync(path.join(tmpdir(), "ac-smoke-report-"));
  process.env.IRIS_STATE_DIR = tmp;
  // 1x1 PNG. keepShot이 실제 파일을 찾아야 장면이 실린다.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const shot = (n) => { const p = path.join(tmp, n + ".png"); writeFileSync(p, png); return p; };
  const { buildReport, addReceipt, receiptsOfRun, coverGaps, pairProblems, unshotClaims,
    unverifiedOutsideLedger } =
    await import(path.join(ROOT, "bin/iris-mcp.mjs"));
  const rA = addReceipt({ expected: "탭 세 개", got: "탭 세 개", pass: true, shot: shot("a") });
  const rB = addReceipt({ expected: "주문번호", got: "빈 화면", pass: false, shot: shot("b") });
  const rC = addReceipt({ expected: "쿠폰 적용", got: "쿠폰 적용", pass: true, shot: null });
  const steps = [
    // after를 안 넘겼다. 영수증에 장면이 붙어 있으므로 보고서는 그것을 실어야 한다.
    // before가 있어 장면이 둘이므로 넘김 장치가 붙어야 한다.
    { name: "탭이 보인다", expected: "탭 세 개", receipt: rA.id, verdict: "pass", at: "10:00:01",
      before: shot("a0") },
    { name: "결제가 끝난다", expected: "주문번호", receipt: rB.id, verdict: "fail", at: "10:00:02" },
    { name: "쿠폰이 먹는다", expected: "쿠폰 적용", receipt: rC.id, verdict: "pass", at: "10:00:03" },
    { name: "폭을 좁혀 봤다", verdict: "info", at: "10:00:04" },
  ];
  const out = path.join(tmp, "r.html");
  const res = buildReport({ title: "표본", steps, out, runId: "smoke-report",
    run: { wiring: "로컬", unverified: [{ what: "카드 승인", why: "안 돌림" }] } });
  const h = readFileSync(out, "utf8");
  const card = (n) => { const i = h.indexOf(`<span class="num">${n}</span>`);
    return i < 0 ? "" : h.slice(h.lastIndexOf("<section", i), h.indexOf("</section>", i)); };

  // 첫 화면은 "어디를 보면 되는가" 하나다. 몇 가지 중 몇 가지라는 문장은 번호가 이미 말한다.
  check("결론이 맨 앞에 온다", () =>
    /class="pt bad">안 됨 <b>2번<\/b>/.test(h)
    && h.indexOf('class="verdict') < h.indexOf('class="req')
    && !/원한 것 \d+가지/.test(h));                     // 세는 문장은 사족이다
  // 사진 없는 통과를 됨에 섞으면 그 문장이 사실과 달라진다. 결론은 한 번만 적는다. 같은 수를
  // 알약으로 다시 표시하면 읽는 사람이 둘을 대조하게 되고, 결과는 같다.
  check("사진 없는 통과는 됨에 안 섞인다", () =>
    /<span class="pt bad">안 됨 <b>2번<\/b><\/span>/.test(h)      // 어느 것이 안 됐는지
    && /확인 못 함 <b>1건<\/b>/.test(h)
    && !/class="ticks"/.test(h));                                  // 같은 수를 두 번 세지 않는다
  // 안 된 것이 있으면 사진 없음은 그다음 문제다. 둘 다 표시하면 무엇부터 볼지 흐려진다.
  check("첫 화면은 급한 것부터 하나만 가리킨다", () =>
    /class="verdict bad"/.test(h) && !/사진 없음 <b>/.test(h));
  // 통과인데 화면이 없으면 확인이 아니라 글로 적은 주장이므로 다르게 표시한다.
  check("증거 없는 통과는 통과처럼 안 보인다", () => {
    const c = card(3);
    return /class="req case unproven/.test(c) && /chip unproven">사진 없음</.test(c)
      && c.includes("글로 적은 것")
      && (c.match(/사진 없음/g) || []).length === 1     // 태그가 말한 것을 문장이 또 말하지 않는다
      && !/<img /.test(c);
  });
  // 영수증에는 판정한 그 순간의 장면이 붙어 있다. 부르는 쪽이 after를 안 넘겼다고 안 그리면
  // 증거가 디스크에 있는데 "사진 없음"이 찍힌다.
  check("영수증 장면은 저절로 실린다", () => {
    const c = card(1);
    return /class="req case pass two/.test(c) && /<img src="data:image\/png;base64,/.test(c)
      && !c.includes("글로만 적힌 것이다");
  });
  // 참고는 요구가 아니므로 사진이 없어도 경고하지 않는다.
  check("참고 단계엔 사진 경고가 안 붙는다", () => !card(4).includes("글로만 적힌 것이다"));
  // 확인 못 한 것이 판정 바로 옆에 서야 "안 됨 0건"이 "다 확인됨"으로 안 읽힌다.
  check("확인 못 한 것이 요구보다 먼저 선다", () =>
    h.indexOf("확인 못 한 것 1") < h.indexOf('class="sec">하나씩') && h.includes("카드 승인"));
  // 연결·격리·시각 정보는 되짚어 보는 사람에게 필요한 항목이다. 앞에 두면 결론이 밀린다.
  check("되짚을 기록은 뒤에 있다", () =>
    h.indexOf('class="back"') > h.lastIndexOf('<span class="num">4</span>')
    && h.indexOf(">되짚을 기록<") > h.indexOf('class="sec">하나씩'));
  // 데스크탑 기준 배치다. 왼쪽이 증거, 오른쪽이 그 증거로 하는 주장이다.
  check("왼쪽이 사진, 오른쪽이 목록", () =>
    /class="req case pass two"/.test(h) && /\.req\.two\{display:grid/.test(h)
    && /\.req\.two \.proof\{grid-column:1;grid-row:2\}/.test(h)
    && /\.req\.two \.qalist\{grid-column:2;grid-row:2/.test(h));
  // 한 케이스가 한 화면을 차지하고 스크롤은 그 경계에서 멈춘다. 다만 높이는 최소값이고
  // 최대값이 아니다. height로 고정하면 "크게"로 사진을 키운 순간 내용이 상자를 넘어 다음
  // 케이스 위로 겹치고, 그 안의 "작게" 단추가 가려져 누를 수 없게 된다
  // (확인 결과: 상자 919px 유지 · 내용 5568px · 단추가 5513px로 밀림 · 스냅 간격 919px로 정지 불가).
  check("한 화면에 한 케이스 — 바닥이지 천장이 아니다", () =>
    /\.case\{min-height:100vh/.test(h)
    && !/\.case\{height:100vh/.test(h)
    && /function page\(dir\)/.test(h) && /e\.key === "PageDown"/.test(h));
  // 장면이 100장을 넘으면 원본 해상도 비트맵이 1GB를 넘겨 렌더러가 멈춘다(확인 결과: 28MB
  // 보고서에서 스크린샷이 25초 무응답, 콘솔 오류 0건이라 JS가 아니라 렌더링이 한계였다). 화면에
  // 보이는 케이스만 그리면 같은 파일이 즉시 열린다. 다만 인쇄에서는 그리지 않은 케이스가 빈
  // 페이지가 되므로 전부 되돌린다.
  check("화면 밖 케이스는 그리지 않되 종이에서는 되돌린다", () =>
    /\.case\{min-height:100vh;content-visibility:auto;contain-intrinsic-size:auto 100vh/.test(h)
    && /@media print\{[\s\S]*?\.case\{min-height:0;content-visibility:visible/.test(h));
  // 손 모양은 약속이다. 사진을 누르면 가운데 모달로 크게 보이므로 돋보기가 맞다(전에는
  // 누르면 다음 장면이라 돋보기가 거짓이었다). 확대용으로 남아 있던 .frame.big은 어디서도 붙지
  // 않는 죽은 규칙이었다.
  check("손 모양은 실제 동작과 같다", () =>
    /\.track \.frame\{cursor:zoom-in\}/.test(h)
    && !/\.frame\.big/.test(h)
    && !/\.track:not\(\.strip\) \.frame\{cursor:pointer\}/.test(h));
  // mandatory로 지정하면 마지막 케이스 아래(되짚을 기록)가 스냅 지점이 아니라 스크롤이 되튄다.
  // 확인 결과 문서 끝 884px에 도달하지 못했다. 케이스만 스냅 지점으로 두어도 같은 문제가 생긴다.
  check("케이스 뒤 구역까지 스크롤이 닿는다", () =>
    /html\{scroll-snap-type:y proximity/.test(h)
    && !/scroll-snap-type:y mandatory/.test(h)
    && !/scroll-snap-stop:always/.test(h)
    && /\.back\{scroll-snap-align:start\}/.test(h)
    // 판정 블록을 스냅 지점으로 두면 맨 위에서 그리로 끌려가 제목이 화면 밖으로 밀린다
    && !/\.verdict[^{]*\{scroll-snap-align/.test(h));
  // 장이 여럿이면 넘길 수 있다는 것이 보여야 하고, 넘길 때 겹쳐야 비교가 된다.
  check("사진이 여럿이면 넘겨 볼 수 있다", () => {
    const c = card(2) || h;
    return /class="arw prev"/.test(h) && /class="count"><b>1<\/b>\/2/.test(h)
      && /\.fr\{[^}]*transition:opacity/.test(h) && /\.fr\.on\{opacity:1/.test(h);
  });
  // 넘기는 문서는 내 판정이 아니라 다른 사람이 따라 할 기준이다.
  check("안내서엔 판정도 넘김 장치도 없다", () => {
    const p = path.join(tmp, "hand.html");
    buildReport({ kind: "handoff", title: "안내", target: "http://x", runId: "smoke-hand",
      steps: [{ name: "연다", action: "이동", expected: "보인다", after: shot("c") }], out: p });
    const g = readFileSync(p, "utf8");
    return !/class="verdict/.test(g) && !/class="stage"/.test(g) && !/class="chip/.test(g)
      && /class="shots/.test(g) && /이렇게 보이면 정상/.test(g) && !/class="wrap rev"/.test(g);
  });
  // 실행 중 부른 판정이 보고서에서 조용히 빠지는 길을 막는다.
  check("보고서에 안 실린 확인은 스스로 실린다", () => {
    const rD = addReceipt({ expected: "몰래 확인", got: "…", pass: true, shot: null });
    const p = path.join(tmp, "miss.html");
    buildReport({ title: "표본2", steps, out: p, runId: "smoke-miss" });
    const g = readFileSync(p, "utf8");
    return g.includes("보고서에 안 실린 확인") && g.includes(rD.id);
  });
  // 찍어 놓고 싣지 않은 장면은 상태 폴더의 정리(60장·7일)로 삭제된다. 글줄만 남기면 증거가
  // 사라진 뒤 "확인했다"는 문장만 남는다.
  check("안 실린 확인도 그 장면을 회차 폴더에 데려간다", () => {
    const rz = addReceipt({ expected: "안 실린 것", got: "…", pass: false, shot: shot("z") });
    const p2 = path.join(tmp, "miss2.html");
    // 회차 폴더는 buildReport가 알려준다. 이 모듈은 앞선 구역에서 이미 로드돼 IRIS_HOME이
    // 여기 tmp가 아닐 수 있고, 추측한 경로로 계산하면 검사가 대상을 보지 못한다.
    const out2 = buildReport({ title: "표본4", runId: "smoke-misshot", out: p2, steps: [
      { name: "본 것", expected: "보인다", verdict: "info", after: shot("z2") },
    ] });
    const g = readFileSync(p2, "utf8");
    // 앞선 검사들이 만든 영수증도 함께 실리므로 rz의 순번은 계산하지 않고,
    // "그림으로 실렸는가"와 "회차 폴더로 옮겼는가"만 확인한다.
    const store = path.join(out2.store, "shots");
    const carried = readdirSync(store).filter((f) => /^miss\d+\.png$/.test(f));
    return g.includes(rz.id)
      && /<figure class="miss bad">/.test(g)              // 안 된 것은 테두리로 먼저 보인다
      && /class="misses">[\s\S]*?<img src="data:image\/png/.test(g)  // 글줄이 아니라 그림
      && carried.length > 0;                              // 정리에 먹히지 않게 옮겼는가
  });

  // 합의 항목 하나에 주장 둘을 묶으면 단계 하나로 덮이고 나머지 절반이 페이지에서 빠진다.
  check("합의 항목과 단계를 잇지 못하면 잡힌다", () => {
    const st = [{ name: "R11 사유 안내" }, { name: "R05 문구" }];
    const g = (a) => coverGaps(a, st);
    return g([{ what: "R11 사유 안내" }]).length === 1                              // covers 없음
      // 문자로 주장 수를 계산하지 않는다. "+"는 연산자일 수 있고 "·"는 단어 구분일 수 있다.
      // 확인 결과 그렇게 계산했을 때 합의 9항목 중 7항목이 오탐이었다.
      && g([{ what: "벌점 + 조정이 다이얼로그를 거쳐 점수·원장에 반영", covers: ["R11 사유 안내"] }]).length === 0
      && g([{ what: "R11 유효기간", covers: ["R11 유효기간"] }]).length === 1        // 없는 단계
      && g([{ what: "R11 사유 안내", covers: ["R11"] }]).length === 0                // 앞부분 일치
      && g([{ what: "R05 문구", covers: [2] }]).length === 0;                        // 번호도 된다
  });

  // 전이 이웃의 후이면 그것은 이 조작의 직전 상태가 아니다.
  // 한 동작이 여러 화면을 지난다. 항목을 나누지 않고 한 곳에 순서대로 배치한다.
  check("거쳐간 화면은 전과 후 사이에 순서대로 선다", () => {
    const p2 = path.join(tmp, "via.html");
    buildReport({ title: "여정", runId: "smoke-via", out: p2,
      run: { agreed: [{ what: "해제", covers: ["판매 제한 해제"] }] },
      steps: [{ name: "판매 제한 해제", action: "해제를 눌렀다", expected: "제한 없음",
        verdict: "info", before: shot("v1"), via: [shot("v2"), shot("v3")], after: shot("v4") }] });
    const g = readFileSync(p2, "utf8");
    const order = [...g.matchAll(/<span class="lb">([^<]+)<\/span>/g)].map((m) => m[1].trim());
    return order.slice(0, 4).join(",") === "전,거쳐 1,거쳐 2,후";
  });
  // 싣지 않은 확인을 전부 삽입하면 페이지가 쓰기 어려울 만큼 무거워진다(확인 결과: 182건 31.7MB).
  // 페이지가 생성하는 문장도 보고서다. 한 곳만 서술형으로 돌아가도 페이지 전체의 어조가
  // 달라지고, 소스를 검색하는 검사로는 어느 문자열이 실제로 나가는지 알 수 없어 렌더해서 확인한다.
  check("지면이 내는 문장도 명사형으로 끝난다", () => {
    const out = path.join(tmp, "nominal.html");
    const r1 = addReceipt({ expected: "버튼이 보임", got: "보임", pass: true, shot: shot("n1") });
    const rr = buildReport({ title: "명사형", runId: "smoke-nominal", out,
      run: { agreed: [{ what: "본 것", covers: ["본 것"] }] },
      steps: [{ name: "본 것", action: "누름", expected: "버튼이 보임", basis: "code",
        verdict: "pass", receipt: r1.id, after: shot("n2") }] });
    if (!rr.ok) return false;
    // 원장 페이지는 줄 카드·결정 카드·조건 묶음으로 다른 문장을 낸다. 한쪽만 보면 절반만 검사한다.
    // 장부는 이미 고정된 상태 폴더 안에 쓴다. 새 폴더를 만들어 환경변수만 바꾸면 경로를 푸는
    // 시점에 따라 report 쪽이 그것을 읽지 않고, 그러면 원장 페이지가 그려지지 않은 채
    // 검사가 통과한다.
    const dir2 = path.join(artifactDir("qa", tmp), "lednominal");
    mkdirSync(path.join(dir2, "shots"), { recursive: true });
    const jf = path.join(dir2, "journal.jsonl");
    let sq = 0;
    const put2 = (e) => appendFileSync(jf, JSON.stringify({ ...e, run_id: "lednominal",
      seq: ++sq, t: Date.now() }) + "\n");
    put2({ kind: "row", act: "declare", row: "L1", what: "만료 초안이 목록에 섬",
      given: "매물 목록", basis: "plan", basisNote: "기획서 3장", paths: ["정상"] });
    put2({ kind: "run_begin", runKind: "proof" });
    put2({ kind: "row", act: "open", row: "L1", path: "정상" });
    put2({ kind: "row", act: "close", row: "L1", path: "정상", color: "blue",
      note: "만료 초안이 데이터에 없어 이 경로를 확인 못 함.",
      options: [{ pick: "하나 심음", then: "이 요구가 닫힘.", cost: "시드 손봐야 함" },
                { pick: "미룸", then: "다음 회차로 남음." }], lean: "가를 권함." });
    put2({ kind: "note", id: "n1", what: "판정할 원문이 없음.", decide: "어떻게 볼 것인가?",
      why: "볼 것이 없으면 버튼만 확인됨.",
      options: [{ pick: "다시 심음", then: "확인됨." }, { pick: "미룸", then: "남음." }] });
    put2({ kind: "run_end" });
    const out2 = path.join(tmp, "nominal-led.html");
    const rr2 = buildReport({ title: "원장 명사형", runId: "lednominal", out: out2, kind: "proof", steps: [] });
    if (!rr2.ok) return false;
    const led2 = readFileSync(devOf(out2), "utf8") + readFileSync(out2, "utf8");
    // 원장 페이지가 실제로 그려졌는지 먼저 확인한다. 그려지지 않으면 이 검사는 아무것도 보지 못한다.
    if (!/고칠 코드가 없는 발견/.test(led2) || !/무엇을 고를 것인가/.test(led2)) return false;
    // 회차 폴더는 이 검사가 쓴 폴더여야 한다. 페이지가 상태 폴더를 고정해 두면 다른 폴더를 읽고,
    // 그러면 이 검사는 빈 페이지를 검사하며 통과한다(확인 결과).
    if (!String(rr2.store).startsWith(tmp)) return false;
    const html = readFileSync(out, "utf8") + led2;
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, "\n").replace(/&[a-z]+;/g, " ");
    const bad = text.split(/\n+/).map((x) => x.trim()).filter(Boolean)
      .flatMap((line) => line.split(/(?<=[^0-9]\.|[?!])\s+/))
      .map((x) => x.trim()).filter(Boolean)
      .filter((x) => /[가-힣]/.test(x))
      .filter((x) => {
        if (/[?？]["\u201d\u2019)\]]*$/.test(x)) return false;
        return /(다|요)["\u201d\u2019)\]\s.。!]*$/.test(x);
      });
    if (bad.length) console.log("      서술형이 남음:", bad.slice(0, 4).join(" | "));
    return bad.length === 0;
  });

  // 장면은 모두 보존하되 페이지에는 안 된 것만 싣는다.
  check("안 실린 확인은 안 된 것만 굽고 나머지는 보존한다", () => {
    const rP = addReceipt({ expected: "통과한 것", got: "…", pass: true, shot: shot("mp") });
    const rF = addReceipt({ expected: "안 된 것", got: "…", pass: false, shot: shot("mf") });
    const p2 = path.join(tmp, "missw.html");
    const out2 = buildReport({ title: "무게", runId: "smoke-missw", out: p2,
      run: { agreed: [{ what: "본 것", covers: ["본 것"] }] },
      steps: [{ name: "본 것", expected: "보인다", verdict: "info", after: shot("mw") }] });
    const g = readFileSync(p2, "utf8");
    const files = readdirSync(path.join(out2.store, "shots")).filter((f) => /^miss\d+\.png$/.test(f));
    // 둘 다 회차 폴더에 있고, 페이지에는 안 된 것만 그림으로 실린다.
    return files.length >= 2 && g.includes(rP.id) && g.includes(rF.id)
      && /class="miss bad">\s*<img src="data:image/.test(g)
      && /class="miss">\s*<div class="gone">장면은 회차 폴더에 있음/.test(g)
      && /지면 무게 때문에 안 실림/.test(g);
  });
  // 이 배열은 MCP 프로세스가 실행되는 동안 계속 쌓인다. 회차 경계가 없으면 다른 회차의 증거가
  // 이 보고서의 "안 실린 확인"으로 실린다(확인 결과: 14단계 회차에 영수증 195건·38시간치).
  check("영수증은 자기 회차 것만 보고서에 실린다", () => {
  const a = addReceipt({ expected: "이번 회차", pass: true, shot: null }, null, "run-A");
  const b = addReceipt({ expected: "남의 회차", pass: true, shot: null }, null, "run-B");
  const c = addReceipt({ expected: "회차 모름", pass: true, shot: null });
  const ids = (rs) => new Set(rs.map((r) => r.id));
  const mine = ids(receiptsOfRun(["run-A"]));
  return mine.has(a.id) && !mine.has(b.id)
    // 회차를 알 수 없는 항목은 버리지 않는다. 제외하면 증거가 기록 없이 사라진다.
    && mine.has(c.id)
    // 회차를 확인할 수 없으면 전부 대상으로 한다(기존 동작).
    && ids(receiptsOfRun([])).has(b.id);
  });
  // 위 검사는 함수만 본다. 호출부를 되돌려도 함수 검사는 통과하므로, 보고서가 실제로 그 함수로
  // 거르는지까지 확인한다.
  check("남의 회차 영수증은 지면에 안 실린다", () => {
    const own = addReceipt({ expected: "이번 것", pass: false, shot: null }, null, "smoke-own");
    const other = addReceipt({ expected: "남의 것", pass: false, shot: null }, null, "smoke-other");
    const p2 = path.join(tmp, "scoped.html");
    buildReport({ title: "회차", runId: "smoke-own", out: p2,
      run: { agreed: [{ what: "본 것", covers: ["본 것"] }] },
      steps: [{ name: "본 것", expected: "보인다", verdict: "info", after: shot("sc") }] });
    const g = readFileSync(p2, "utf8");
    return g.includes(">" + own.id + "<") && !g.includes(">" + other.id + "<");
  });
  // "크게"가 페이지 안에서 카드를 키우던 동작이다. 사진이 화면을 넘어가 오히려 보이지 않았다.
  // 사진을 누르면 가운데 모달에 그 항목의 장면이 한 장씩 서고, ←→로 넘기며, 닫기는 오른쪽 위
  // 단추와 Esc다. 되짚을 기록의 썸네일도 같은 모달을 연다. 제자리 확대 규칙과 단추는 남기지 않는다.
  check("크게 보기는 가운데 모달에서 한 장씩 넘긴다", () =>
    /<dialog id="lb"/.test(mcpReport) && /lb\.showModal\(\)/.test(mcpReport)
    && /dialog#lb\[open\]\{display:flex\}/.test(mcpReport)
    && /#lb \.frame img\{max-height:calc\(100vh - /.test(mcpReport)
    && /class="lbx" aria-label="닫기"/.test(mcpReport)
    && /e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"/.test(mcpReport)
    && /td\.sh\[data-q\] \.th/.test(mcpReport) && /<td class="sh" data-q="\$\{i \+ 1\}">/.test(mcpReport)
    && !/\.stage\.zoom/.test(mcpReport) && !/class="tab zoomer"/.test(mcpReport));
  // 장면이 없는 항목을 창 높이로 잡아 두면 글 몇 줄 밑이 통째로 빈다.
  check("장면 없는 항목은 내용만큼만 높다", () =>
    /\.case:not\(:has\(\.stage\)\)\{min-height:0;contain-intrinsic-size:auto\}/.test(mcpReport));
  // 페이지가 장부를 그대로 그리면 무엇을 실을지 고르는 단계가 없어진다. 사진 없는 단계, 전후
  // 불일치, 과분할, 싣지 않은 확인을 판정할 수 없는 형태가 된다.
  // 설명을 달아 직접 찍은 장면이 그 줄의 가장 좋은 증거인데, 페이지가 자동 기록된 프레임만
  // 집계하는 동안 그 장면이 빠져 여덟 줄 중 넷이 "장면 없다"로 나왔다(확인 결과).
  // 회차가 열려 있는 동안의 녹화분까지 모두 실으면 한 줄에 스물다섯 장이 실린다.
  check("일부러 찍은 장면은 다 서고, 흐르는 녹화는 접힌다", () => {
    const home = buildReport({ title: "자리", runId: "ledshot", out: path.join(tmp, "seed2.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "ledshot", ...o }) + "\n");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "U1", what: "탭으로 갈린다", given: "목록 화면",
      basis: "plan", paths: ["정상"] });
    put({ kind: "row", act: "open", row: "U1", path: "정상" });
    // 자동 녹화 여덟 장은 접어야 한다.
    for (let i = 0; i < 8; i++) {
      put({ kind: "frame", source: "browser", why: i % 2 ? "after" : "before",
        path: shot(`amb${i}`), row: "U1", path_: "정상" });
    }
    // 설명을 달아 직접 찍은 한 장은 접지 않는다.
    put({ kind: "artifact", source: "browser", path: shot("meant"),
      caption: "여기 탭이 없다", row: "U1", path_: "정상" });
    put({ kind: "assertion", source: "browser", id: "r1", row: "U1", path_: "정상",
      expected: "탭 없음", got: null, pass: true, shot: shot("verdict") });
    put({ kind: "row", act: "close", row: "U1", path: "정상", color: "red", note: "탭이 없다" });
    const out = path.join(tmp, "ledshot.html");
    buildReport({ title: "장면", runId: "ledshot", out, kind: "proof" });
    const html = readFileSync(devOf(out), "utf8");
    const verdict = /여기 탭이 없다/.test(html)          // 설명이 지면에 실린다
      && /녹화 \d+장 접음/.test(html)                    // 접은 것을 숨기지 않고 센다
      && !/>장면 없음</.test(html)             // 찍었는데 없다고 하지 않는다
      && /<span class="lb">찍음<\/span>/.test(html);     // 무엇인지로 라벨이 붙는다
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  // 기본 지면을 읽는 사람은 확인 기록 번호·선택자·주소로 검증할 수 없다. 흐름과 설명을 단
  // 장면만 싣고, 개발자가 되짚을 기록은 -dev 지면에 그대로 남아야 한다.
  // 기본 지면을 읽는 사람은 확인 기록 번호·선택자·주소로 검증할 수 없다. 대신 조건·기대 근거·
  // 확인마다 대상·기대·실제·맞음 여부와 모든 증거 장면(캐러셀)이 있어야 다시 판정할 수 있다.
  // 무효로 돌린 판정의 장면은 증거가 아니다. 개발자가 되짚을 기록은 -dev 지면에 그대로 남는다.
  check("장부 회차의 기본 지면은 판정 정보와 장면을 싣고 확인 기록은 -dev 에 둔다", () => {
    const home = buildReport({ title: "자리", runId: "ledplain", out: path.join(tmp, "seed-plain.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    // 읽을 수 있는 크기의 장면. 너무 작은 그림은 기본 지면이 빼므로 80x80 을 쓴다.
    const big = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAAABc2X6AAAAc0lEQVR4nO3PAQ0AIAzAsPvXhihcnGS0CrY5n5nXAdsM1xmuM1xnuM5wneE6w3WG6wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3WG6wzXGa4zXGe4znCd4TrDdRfRQMd2eVIu+QAAAABJRU5ErkJggg==", "base64");
    const bigShot = (n) => { const q = path.join(tmp, n + ".png"); writeFileSync(q, big); return q; };
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "ledplain", ...o }) + "\n");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "P1", what: "목록 화면 > 저장 버튼 클릭 > 새로고침 > 값 유지",
      given: "관리자 로그인", basis: "user", basisNote: "사용자 결정 저장 유지", paths: ["정상"] });
    put({ kind: "row", act: "open", row: "P1", path: "정상" });
    for (let k = 1; k <= 13; k++) {
      put({ kind: "artifact", source: "browser", path: bigShot(`plain-meant${k}`), url: "http://localhost:3002/list",
        caption: `장면 설명 ${k}`, row: "P1", path_: "정상" });
    }
    put({ kind: "assertion", source: "browser", id: "r7", row: "P1", path_: "정상", url: "http://localhost:3002/list",
      selector: "[data-testid=qty]", expected: "[data-testid=qty] = \"3\"", mode: "equals", want: "3", label: "수량 칸", got: "3", pass: true,
      shot: bigShot("plain-rc") });
    put({ kind: "assertion", source: "browser", id: "r8", row: "P1", path_: "정상",
      selector: "[data-testid=other]", mode: "exists", got: null, pass: false, shot: bigShot("plain-voided") });
    put({ kind: "void", receipt: "r8", why: "질문 오류", row: "P1", path_: "정상" });
    // 이름표 없이 부른 확인은 판정한 요소 이름이 대상으로 선다.
    put({ kind: "assertion", source: "browser", id: "r9", row: "P1", path_: "정상",
      selector: "#save", mode: "exists", element: "버튼 ‘저장’", got: "저장", pass: true });
    put({ kind: "row", act: "close", row: "P1", path: "정상", color: "green", note: "새로고침 뒤 값 3 유지\\n저장 알림 표시",
      options: [{ pick: "자동 저장", then: "입력 즉시 저장" }, { pick: "확인 후 저장", then: "버튼으로 저장" }] });
    const out = path.join(tmp, "ledplain.html");
    const res = buildReport({ title: "기본 지면", runId: "ledplain", out, kind: "proof",
      overview: { features: [
        { name: "수량 저장", need: ["수량을 저장하고 새로고침해도 유지"], understood: ["수량 칸 값 저장"], built: ["저장 버튼"], cases: ["P1"], gaps: ["음수 입력 거부"] },
        { name: "코드 구조", need: ["모듈 분리"], understood: ["구조 분리"], built: ["모듈 분리"], cases: [], why: "코드 구조 요구" }],
        diagrams: [{ lanes: ["운영자", "사용자"], steps: [{ id: "a", lane: "운영자", text: "수량 입력" },
          { id: "b", lane: "사용자", text: "값 확인", focal: true }], links: [{ from: "a", to: "b" }] }] } });
    const raw = readFileSync(out, "utf8");
    const plain = raw.replace(/src="data:[^"]*"/g, "");
    const dev = readFileSync(devOf(out), "utf8");
    const scenes = (raw.match(/<figure class="sc/g) || []).length;
    const ok = res.devPath === devOf(out)
      && /<li>목록 화면<\/li><li>저장 버튼 클릭<\/li>/.test(plain)   // 흐름이 단계로 나뉜다
      && /Case 1/.test(plain) && !/>P1</.test(plain)                   // 장부 번호 대신 순서 번호
      && /<h3>수량 저장<\/h3>/.test(plain) && /href="#w1">Case 1 통과/.test(plain) // 기능 → 케이스
      && /확인 빈 곳<br>음수 입력 거부/.test(plain)                    // 기능 안 빈 검증
      && /확인 케이스 없음/.test(plain) && /코드 구조 요구/.test(plain)       // 검증 없는 기능이 드러남
      && /href="#q1">수량 저장/.test(plain)                            // 케이스 → 기능
      && /<svg class="dia"[^>]*role="img"/.test(plain) && /lanes1-title/.test(plain) // 역할별 흐름도
      && plain.indexOf("기능과 구현") < plain.indexOf('class="sum"')   // 추적표가 케이스 표보다 먼저
      && /관리자 로그인/.test(plain) && /사용자 결정 저장 유지/.test(plain) // 조건·기대 근거
      && /<em>수량 칸<\/em>&#39;3&#39; 일치|<em>수량 칸<\/em>'3' 일치/.test(plain) // 대상·기대값
      && /장면 설명 13/.test(plain) && scenes === 14                  // 13장 + 판정 1장, 무효 장면 없음
      && /잘못 설정한 확인 제외 · 사유 질문 오류/.test(plain)   // 무효 사실과 사유는 남는다
      && /<em>버튼 ‘저장’<\/em>/.test(plain)                          // 이름표 없으면 요소 이름
      && /자동 저장/.test(plain) && /확인 후 저장/.test(plain)         // 경로에 남긴 선택지
      && /<li>저장 알림 표시<\/li>/.test(plain)                      // 문자 그대로 적힌 \n 도 줄로 나뉜다
      && /class="car"/.test(plain) && /class="arw next"/.test(plain) // 장면은 캐러셀로
      && !/\br7\b|\br8\b|data-testid|localhost/.test(plain)
      && /\br7\b/.test(dev) && /data-testid/.test(dev);
    if (!ok) console.log("      기본 지면 검사:", { scenes, flow: /<li>목록 화면<\/li><li>저장 버튼 클릭<\/li>/.test(plain),
      meta: /관리자 로그인/.test(plain) && /사용자 결정 저장 유지/.test(plain),
      check: (plain.match(/<em>[^<]*<\/em>[^<]*/) || [""])[0], voidNote: /잘못 설정한 확인 제외 · 사유 질문 오류/.test(plain),
      el: /<em>버튼 ‘저장’<\/em>/.test(plain), picks: /확인 후 저장/.test(plain),
      nl: /<li>저장 알림 표시<\/li>/.test(plain), s13: /장면 설명 13/.test(plain), car: /class="car"/.test(plain) && /class="arw next"/.test(plain), dev: /\br7\b/.test(dev) && /data-testid/.test(dev), dp: res.devPath === devOf(out), leak: (plain.match(/\br7\b|\br8\b|data-testid|localhost/) || [""])[0] });
    rmSync(home, { recursive: true, force: true });
    return ok;
  });
  // 흐름도는 한 장에 역할 5·단계 9를 넘기면 그리지 않고 나누라고 돌려준다.
  checkAsync("역할별 흐름도가 한도를 넘으면 보고서가 거절한다", async () => {
    const { checkLanes } = await import(path.join(ROOT, "bin/mcp/report-lanes.mjs"));
    const many = { lanes: ["a", "b", "c", "d", "e", "f"], steps: Array.from({ length: 10 }, (_, k) => ({ id: "s" + k, lane: "a", text: "x" })) };
    const bad = checkLanes(many, 1);
    const ok = checkLanes({ lanes: ["a"], steps: [{ id: "s", lane: "a", text: "x" }], links: [] }, 1);
    return bad.some((x) => /역할 6개/.test(x)) && bad.some((x) => /단계 10개/.test(x)) && ok.length === 0;
  });
  // 장부가 가리키는 파일이 나중에 다른 그림으로 덮이면 페이지는 그것을 증거로 싣는다.
  // 실제로 매물 관리 줄에 로그인 화면이 실린 사례가 있다.
  check("장부보다 한참 뒤에 쓰인 파일은 증거로 세우지 않는다", () => {
    const home = buildReport({ title: "자리", runId: "ledstale", out: path.join(tmp, "seed3.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const old = shot("overwritten");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "ledstale", ...o }) + "\n");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "U1", what: "무언가", given: "어떤 화면",
      basis: "plan", paths: ["정상"] });
    put({ kind: "row", act: "open", row: "U1", path: "정상" });
    // 장부에 적힌 시각은 한 시간 전인데 파일은 현재 것이므로 그때 찍힌 그림이 아니다.
    appendFileSync(J, JSON.stringify({ source: "browser", run_id: "ledstale", kind: "frame",
      why: "after", path: old, row: "U1", path_: "정상", t: Date.now() - 3600000 }) + "\n");
    put({ kind: "assertion", source: "browser", id: "r1", row: "U1", path_: "정상",
      expected: "무언가", got: "무언가", pass: true });
    put({ kind: "row", act: "close", row: "U1", path: "정상", color: "green", note: "됐다" });
    const out = path.join(tmp, "ledstale.html");
    buildReport({ title: "덮임", runId: "ledstale", out, kind: "proof" });
    const html = readFileSync(devOf(out), "utf8");
    const verdict = /장부 시각보다 뒤에/.test(html) && /촬영 시점 불일치/.test(html) && /증거 아님/.test(html)
      && /장면 파일 덮임/.test(html);
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  check("장부에 줄이 있으면 지면은 장부를 그린다", () => {
    // 이 모듈은 앞선 구역에서 이미 로드돼 IRIS_HOME이 고정돼 있다. 추측한 경로에 장부를 쓰면
    // 페이지가 그것을 읽지 못하므로, 회차 폴더는 buildReport가 알려주는 값을 쓴다.
    const home = buildReport({ title: "자리", runId: "ledrun", out: path.join(tmp, "seed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    // 이 폴더는 매번 비우고 시작한다. 앞 회차의 장부가 남아 있으면 여기서 넣는 한 줄에
    // 그것이 더해져, 수를 보는 검사가 첫 회차만 통과하고 이후에는 계속 실패한다.
    // 확인 결과 노트가 28개까지 쌓여 있었다. 그 폴더는 임시 폴더가 아니라 사용자가 쓰는
    // 상태 폴더였다(이 구역이 env를 바꾸기 전에 다른 구역이 이미 모듈을 로드한다).
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const fr = shot("led1"), fr2 = shot("led2");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "ledrun", ...o }) + "\n");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "U1", what: "완료가 비활성", given: "유효기간 미입력",
      basis: "spec", paths: ["정상", "실패"] });
    put({ kind: "row", act: "open", row: "U1", path: "실패" });
    put({ kind: "frame", source: "browser", why: "before", path: fr, row: "U1", path_: "실패" });
    put({ kind: "frame", source: "browser", why: "after", path: fr2, row: "U1", path_: "실패" });
    put({ kind: "assertion", source: "browser", id: "r1", row: "U1", path_: "실패",
      expected: "비활성", got: "활성", pass: false });
    put({ kind: "row", act: "close", row: "U1", path: "실패", color: "red", note: "완료가 눌린다" });
    put({ kind: "note", id: "n1", what: "문구가 다르다", decide: "어느 쪽으로 통일할지" });
    const out = path.join(tmp, "led.html");
    buildReport({ title: "장부", runId: "ledrun", out, kind: "proof" });
    const ok = readFileSync(devOf(out), "utf8");
    const verdict = /class="req case red row"/.test(ok)          // 줄의 색은 경로 중 가장 나쁜 것
      && /class="lane red"/.test(ok) && /class="lane open"/.test(ok)  // 실행하지 않은 경로가 남는다
      && /안 밟음/.test(ok)
      && /흐름이 깨진 줄 1/.test(ok)                     // 첫 화면은 한 문장
      && /<h2 class="sec">조건 1가지/.test(ok)
      && /이 조건은 이 줄 하나뿐/.test(ok)               // 희소함을 그 자리에서 보게 한다
      && /<h2 class="sec">정해야 할 것 1/.test(ok)       // 설계 문제는 결함과 다른 곳에
      && /고칠 코드가 없는 발견/.test(ok)
      && /미충족 시 red 고정/.test(ok);
    // 검사가 쓴 것은 검사가 치운다. 이 구역이 env를 바꾸기 전에 다른 구역이 이미 모듈을
    // 로드하므로 이 회차 폴더는 임시 폴더가 아니라 사용자가 쓰는 상태 폴더 안에 생긴다.
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  // 목록이 여럿이어도 모두 표시하고, 확인하지 않은 항목은 수로 먼저 보여 준다. 항목이 스무 개면
  // "안 봤다" 표시 셋이 스크롤에 묻혀 다 본 목록과 구별되지 않는다.
  // 무효로 돌린 판정을 페이지에서 빼면 그 줄만 보는 사람은 판정이 있었다는 사실을 알 수 없다.
  // 사유를 요구하면서 그 사유를 어디에도 싣지 않는 것과 같다.
  check("무효로 돌린 판정이 그 줄에 사유와 함께 남는다", () => {
    const home = buildReport({ title: "자리", runId: "vdrun", out: path.join(tmp, "vdseed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "vdrun", ...o }) + "\n");
    const a = shot("vd1");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "R-36", what: "승인하면 판매 중", given: "검수중",
      basis: "spec", paths: ["정상"] });
    put({ kind: "row", act: "open", row: "R-36", path: "정상" });
    put({ kind: "frame", source: "browser", why: "before", path: a, row: "R-36", path_: "정상",
      url: "http://x/resale/listings" });
    put({ kind: "assertion", source: "browser", id: "r30", row: "R-36", path_: "정상",
      url: "http://x/resale/listings", expected: "판매 중", got: "판매 중", pass: true, shot: a });
    put({ kind: "assertion", source: "browser", id: "r31", row: "R-36", path_: "정상",
      url: "http://x/resale/listings", expected: "목록 반영", got: "목록 반영", pass: true, shot: a });
    // 이전 무효 기록에는 줄 정보가 없어 영수증에서 찾아야 한다.
    put({ kind: "void", receipt: "r30", why: "R-39 반려 사유를 못 본 채 판정했다" });
    put({ kind: "row", act: "close", row: "R-36", path: "정상", color: "green", note: "상태 바뀜" });
    const out = path.join(tmp, "vd.html");
    buildReport({ title: "무효", runId: "vdrun", out, kind: "proof" });
    const html = readFileSync(devOf(out), "utf8");
    const verdict = /무효로 돌린 판정 1건/.test(html)
      && /r30 · 판매 중 · 통과 판정/.test(html)
      && /사유: R-39 반려 사유를 못 본 채 판정했다/.test(html)
      // 무효 처리된 판정은 판정 목록에서 제외한다. 두 번 집계하면 안 된다.
      && /판정 1</.test(html);
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });

  // 무엇을 남길지는 판정 위치가 정한다. 접기는 처음 둘·끝 둘을 남기는데, 세션이 끊기면
  // 재로그인 화면이 레인 앞쪽에 와서 줄마다 로그인이 먼저 보인다(확인 결과:
  // 로그인 67장 전부 자동 녹화분). 제외하는 것이 아니라 고르는 순서를 바꾼다.
  check("남길 장면을 판정 자리가 먼저 고른다", () => {
    const home = buildReport({ title: "자리", runId: "dtrun", out: path.join(tmp, "dtseed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "dtrun", ...o }) + "\n");
    const L = [1, 2, 3, 4, 5, 6].map((n) => shot("lg" + n));   // 앞머리의 로그인 여섯 장
    const D = [1, 2, 3, 4, 5, 6].map((n) => shot("db" + n));   // 그 뒤 대시보드 여섯 장
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "row", act: "declare", row: "D1", what: "대시보드 숫자가 맞다", given: "매물 3건",
      basis: "spec", paths: ["정상"] });
    put({ kind: "row", act: "open", row: "D1", path: "정상" });
    L.forEach((p2, i) => put({ kind: "frame", source: "browser", why: i % 2 ? "after" : "before",
      path: p2, row: "D1", path_: "정상", url: `http://x/login?n=${i}` }));
    D.forEach((p2, i) => put({ kind: "frame", source: "browser", why: i % 2 ? "after" : "before",
      path: p2, row: "D1", path_: "정상", url: `http://x/resale/dashboard?n=${i}` }));
    // 판정을 대시보드에서 냈으므로 이 줄의 화면은 대시보드다.
    put({ kind: "assertion", source: "browser", id: "r1", row: "D1", path_: "정상",
      url: "http://x/resale/dashboard", expected: "3건", got: "3건", pass: true, shot: D[0] });
    put({ kind: "row", act: "close", row: "D1", path: "정상", color: "green", note: "숫자 일치" });
    const out = path.join(tmp, "dt.html");
    buildReport({ title: "고르는 순서", runId: "dtrun", out, kind: "proof" });
    const html = readFileSync(devOf(out), "utf8");
    const caps = (html.match(/<figcaption>[\s\S]*?<\/figcaption>/g) || []).join("");
    // 장면 밑 주소는 경로만 실린다. 남은 것이 대시보드뿐이어야 한다.
    const verdict = caps.includes("/resale/dashboard") && !caps.includes("/login")
      && /지나간 자리 6장/.test(html) && /x\/login 6장/.test(html)
      && /판정을 낸 자리: x\/resale/.test(html);
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  // 사유만 적으면 제한 없이 통과하는 경로가 있으면 그 경로로 전부 몰린다.
  // 기능이 아니라 우회만 막는다. 원장이 없는 회차에서는 그대로 받는다.
  check("원장이 있으면 못 밟은 것을 글로 옆에 못 적는다", () => {
    const un = { unverified: [{ what: "정산 완료 알림", why: "코드와 단위테스트로만 확인" },
      { what: "분쟁 접수 알림", why: "같음" }] };
    const blocked = unverifiedOutsideLedger(un, true);
    return typeof blocked === "string" && /unverified 2건/.test(blocked)
      && /정산 완료 알림/.test(blocked) && /gray/.test(blocked)
      && unverifiedOutsideLedger(un, false) === null          // 원장 없는 회차는 그대로
      && unverifiedOutsideLedger({ unverified: [] }, true) === null
      && unverifiedOutsideLedger({ unverified: [{ what: "  " }] }, true) === null;
  });
  check("목록마다 안 본 항목 수가 머리에 서고 어디서 떠 왔는지가 보인다", () => {
    const home = buildReport({ title: "자리", runId: "setrun", out: path.join(tmp, "setseed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "setrun", ...o }) + "\n");
    const fr = shot("set1"), fr2 = shot("set2");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "list", name: "알림 발생 자리", from: { source: "notifier.ts", pick: "async (\\w+)\\(" },
      items: [{ id: "listingApproved", text: "async listingApproved(x) {}", at: "notifier.ts:2" },
        { id: "listingRejected", text: "async listingRejected(x) {}", at: "notifier.ts:3" },
        { id: "tradeSettled", text: "async tradeSettled(x) {}", at: "notifier.ts:4" }] });
    put({ kind: "list", name: "앞 회차 지적", items: [{ id: "L1", text: "문구 통일" }] });
    put({ kind: "row", act: "declare", row: "N-2", what: "승인하면 알림 1건", given: "판매검수중",
      basis: "spec", paths: ["정상"], covers: ["listingApproved"] });
    put({ kind: "row", act: "open", row: "N-2", path: "정상" });
    put({ kind: "frame", source: "app", why: "before", path: fr, row: "N-2", path_: "정상" });
    put({ kind: "assertion", source: "app", id: "r1", row: "N-2", path_: "정상",
      expected: "알림 1건", got: "알림 1건", pass: true, shot: fr2 });
    put({ kind: "row", act: "close", row: "N-2", path: "정상", color: "green", note: "알림 1건 쌓임" });
    const out = path.join(tmp, "set.html");
    buildReport({ title: "목록", runId: "setrun", out, kind: "proof" });
    const html = readFileSync(devOf(out), "utf8");
    const verdict = /<h2 class="sec">알림 발생 자리<\/h2>/.test(html)
      && /<h2 class="sec">앞 회차 지적<\/h2>/.test(html)            // 목록 둘이 다 표시된다
      && /3가지 중 1가지를 봄 · 안 본 것 2가지: listingRejected · tradeSettled/.test(html)
      && /1가지를 다 봄|1가지 중 0가지를 봄/.test(html)
      && /notifier\.ts/.test(html) && /코드에 있는 자리가 곧 목록/.test(html)   // 어디서 떠 왔는가
      && /notifier\.ts:2/.test(html);                                // 항목마다 그 자리
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  // 보고서를 여는 이유는 "무엇부터 봐야 하는가"다. 카드가 한 화면씩이라 전체를 보려면 스크롤을
  // 끝까지 내려야 하고 그 사이 급한 줄이 보이지 않는다. 색 순서로 배치하고 눌러서 이동한다.
  check("첫 화면에서 줄 전부를 급한 순서로 훑는다", () => {
    const home = buildReport({ title: "자리", runId: "idxrun", out: path.join(tmp, "idxseed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "idxrun", ...o }) + "\n");
    const fr = shot("idx1");
    put({ kind: "run_begin", runKind: "proof" });
    for (const [id, what, color] of [["G1", "되는 것", "green"], ["R1", "깨진 것", "red"]]) {
      put({ kind: "row", act: "declare", row: id, what, given: "조건", basis: "spec", paths: ["정상"] });
      put({ kind: "row", act: "open", row: id, path: "정상" });
      put({ kind: "frame", source: "browser", why: "after", path: fr, row: id, path_: "정상" });
      put({ kind: "assertion", source: "browser", id: "r" + id, row: id, path_: "정상",
        expected: "e", got: "g", pass: color !== "red", shot: fr });
      put({ kind: "row", act: "close", row: id, path: "정상", color,
        note: "이 판정이 무엇을 뜻하는지 길게 적은 문장이다. ".repeat(4) });
    }
    const out = path.join(tmp, "idx.html");
    buildReport({ title: "훑기", runId: "idxrun", out, kind: "proof" });
    const h2 = readFileSync(devOf(out), "utf8");
    // 해당 영역 안에서만 확인한다. 페이지 전체를 보면 카드의 판정 문장이 같은 문자를 담고 있어
    // 여기서 잘라도 검사가 통과한다(확인 결과: 30자로 잘라도 검출되지 않았다).
    const idxFrom = h2.indexOf('class="qalist idx"');
    const idx = idxFrom < 0 ? "" : h2.slice(idxFrom, h2.indexOf("</dl>", idxFrom));
    const iRed = idx.indexOf('href="#q2"'), iGreen = idx.indexOf('href="#q1"');
    const verdict = /<h2 class="sec">줄 2<\/h2>/.test(h2)
      // 급한 것이 먼저다. 선언 순서가 아니라 색 순서로 배치한다.
      && iRed > -1 && iGreen > -1 && iRed < iGreen
      // 판정 한 줄이 같은 위치에 함께 온다. 문자로 자르지 않고 페이지에서 접는다.
      && /class="said"/.test(idx)
      && /\.idx dd\{display:-webkit-box;-webkit-line-clamp:2/.test(h2)
      && idx.includes("이 판정이 무엇을 뜻하는지 길게 적은 문장이다. ".repeat(4).trim())
      // 경고 표시를 재사용하면 모든 줄이 문제처럼 읽힌다.
      && !/class="said[^"]*mid/.test(h2)
      // 레인 제목이 경로 이름과 색 이름을 나란히 놓아 "정상 정상"으로 읽히지 않는다.
      && /class="lane-n">정상 경로</.test(h2);
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  // 원문을 안 읽어도 이 문서 하나로 검토할 수 있어야 한다. 근거 이름만
  // 적으면 읽는 사람이 명세를 찾아 열어야 하고, 보고서만으로는 검토할 수 없다.
  check("근거 원문과 따른 목록이 지면에 실린다", () => {
    const home = buildReport({ title: "자리", runId: "basisrun", out: path.join(tmp, "bseed.html"),
      steps: [{ name: "자리", verdict: "info" }] }).store;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const J = path.join(home, "journal.jsonl");
    const put = (o) => appendFileSync(J, JSON.stringify({ source: "server", run_id: "basisrun", ...o }) + "\n");
    const fr = shot("b1"), sp = shot("b2"), lp = shot("b3"), stray = shot("b4");
    put({ kind: "run_begin", runKind: "proof" });
    put({ kind: "list", name: "2차 수정 목록", source: "qa/지적.md", shot: lp,
      items: [{ id: "L1", text: "완료가 활성이다", was: "사유 안내가 없었다" },
        { id: "L2", text: "아무도 안 본 항목" }] });
    put({ kind: "row", act: "declare", row: "U1", what: "만료일을 다시 검사한다", given: "승인 직전",
      basis: "spec", basisNote: "기획서 10.1", covers: ["L1"], source: "design.md:339",
      quote: "승인 시 만료일을 서버에서 다시 검사한다.", sourceShot: sp, paths: ["정상"] });
    put({ kind: "row", act: "open", row: "U1", path: "정상" });
    put({ kind: "frame", source: "browser", why: "after", path: fr,
      url: "http://x/resale/listings", row: "U1", path_: "정상" });
    put({ kind: "frame", source: "browser", why: "after", path: stray,
      url: "http://x/login", row: "U1", path_: "정상" });
    put({ kind: "assertion", source: "browser", id: "r1", row: "U1", path_: "정상",
      expected: "e", got: "g", pass: true, shot: fr });
    put({ kind: "row", act: "close", row: "U1", path: "정상", color: "green", note: "된다" });
    const out = path.join(tmp, "basis.html");
    buildReport({ title: "근거", runId: "basisrun", out, kind: "proof" });
    const h2 = readFileSync(devOf(out), "utf8");
    // 주소는 장면마다 그 아래에 붙어야 한다. 경고 문구에도 같은 문자가 들어 있어서
    // 페이지 전체를 보면 장면 밑의 표시를 빼도 검사가 통과한다(확인 결과).
    const caps = (h2.match(/<figcaption>[\s\S]*?<\/figcaption>/g) || []).join("");
    const withStray = /주소 2가지/.test(h2) && /class="lane-warn"/.test(h2)
      && caps.includes("/resale/listings") && caps.includes("/login");
    // 곁가지로 떼어내면 그 장면은 증거에서 빠지고 사유가 남는다.
    put({ kind: "aside", row: "U1", path_: "정상", frames: [stray],
      why: "세션이 끊겨 다시 들어간 구간이다" });
    const out2 = path.join(tmp, "basis2.html");
    buildReport({ title: "근거", runId: "basisrun", out: out2, kind: "proof" });
    const h3 = readFileSync(devOf(out2), "utf8");
    const verdict = h2.includes("2차 수정 목록")
      && h2.indexOf("2차 수정 목록") < h2.indexOf('class="sec">줄 1')
      && /L1<\/dt>[\s\S]{0,500}?에서 봤다/.test(h2)
      && /L2<\/dt>[\s\S]{0,300}?이번 회차가 안 봤다/.test(h2)
      && h2.includes("그때: 사유 안내가 없었다")
      && h2.includes("근거 원문")
      && h2.includes("승인 시 만료일을 서버에서 다시 검사한다.")
      && h2.includes("design.md:339") && h2.includes("기획서 10.1")
      && withStray
      && !/주소 2가지/.test(h3) && h3.includes("증거 아님으로 표시한 장면 1장")
      && h3.includes("세션이 끊겨 다시 들어간 구간이다");
    rmSync(home, { recursive: true, force: true });
    return verdict;
  });
  check("전/후가 그 동작의 앞뒤가 아니면 잡힌다", () => {
    // 이 구역의 shot()은 이름과 무관하게 같은 1x1 바이트를 쓴다. 내용으로 비교하는 검사이므로
    // 서로 다른 그림이 필요하다.
    const A = shot("bb1"), B = path.join(tmp, "bb2.png");
    writeFileSync(B, Buffer.concat([readFileSync(A), Buffer.from("b")]));
    // 경로가 아니라 내용으로 비교한다. 복사본을 넘겨도 같은 그림이다.
    const Acopy = path.join(tmp, "bb1-copy.png");
    writeFileSync(Acopy, readFileSync(A));
    // 바로 앞 단계의 후가 이번 전이면 두 단계는 한 동작이므로 합치도록 안내한다.
    const adj = pairProblems([{ name: "1", after: A }, { name: "2", before: Acopy, after: B }]);
    // 건너뛴 단계의 후를 빌리면 그건 이 조작의 직전이 아니다.
    const D = path.join(tmp, "bb4.png");
    writeFileSync(D, Buffer.concat([readFileSync(A), Buffer.from("d")]));
    const far = pairProblems([{ name: "1", after: A }, { name: "2", after: B },
      { name: "3", before: Acopy, after: D }]);
    // 전과 후가 같은 그림이면 이 동작이 무엇을 바꿨는지 안 보인다.
    const same = pairProblems([{ name: "1", before: A, after: Acopy }]);
    const okd = pairProblems([{ name: "1", before: A, after: Acopy, unchanged: true }]);
    return adj.length === 1 && /바로 앞 1번의 후\n둘은 한 동작. 하나로 합칠 것/.test(adj[0])
      && far.length === 1 && /1번의 후와 같은 그림\n이 조작의 직전 아님/.test(far[0])
      && same.length === 1 && /전과 후가 같은 그림/.test(same[0])
      && okd.length === 0;
  });

  // 전 프레임은 지나간 뒤에 만들 수 없다. 거부하면 회차 전체를 다시 확인해야 하므로 수만 집계한다.
  check("누른 단계에 전이 없으면 지면이 수를 센다", () => {
    const p2 = path.join(tmp, "nobefore.html");
    buildReport({ title: "표본5", runId: "smoke-nobefore", out: p2,
      run: { agreed: [{ what: "하나", covers: ["누른다"] }] },
      steps: [{ name: "누른다", action: "눌렀다", expected: "보인다", verdict: "info", after: shot("nb") }] });
    const g = readFileSync(p2, "utf8");
    return /누른 단계 1개 중 1개에 "전"이 없다/.test(g) && /class="lede warn-line"/.test(g);
  });

  // 됐다는 판정도 화면으로 확인한다. 사진 없는 주장이 판정을 바꿔 빠져나가던 경로를 막는다.
  check("사진 없는 주장은 판정과 무관하게 잡힌다", () => {
    const A = shot("us1");
    const u = (st) => unshotClaims(st, false);
    return u([{ name: "a", expected: "보인다", verdict: "info" }]).length === 1
      && u([{ name: "a", expected: "보인다", verdict: "pass" }]).length === 1   // 판정으로 안 갈린다
      && u([{ name: "a", expected: "보인다", after: A }]).length === 0
      && u([{ name: "a", expected: "보인다", noShot: "못 찍었다" }]).length === 0
      && u([{ name: "a", expected: "보인다", from: "run-1" }]).length === 0     // 이어받음
      && u([{ name: "a", verdict: "info" }]).length === 0                       // 주장 없음
      && unshotClaims([{ name: "a", expected: "보인다" }], true).length === 0;  // 안내서 면제
  });
  check("사진 없는 주장은 보고서가 만들어지기 전에 막힌다", () => {
    // 확인 결과 회차 17개 349단계 중 사진 없는 44단계가 expected를 달고 있었고
    // 그중 26이 info였다. 표시가 pass에만 붙으니 주장이 전부 info로 몰렸다. 그래서
    // 판정이 아니라 "화면을 주장했는가"로 구분한다.
    const src = sliceBetween(mcpReport, "function unshotClaims", "// 몇 항목부터 조밀 지면으로",
      "사진 없는 주장 검사");
    return /String\(s\.expected \|\| ""\)\.trim\(\)/.test(src)   // 주장한 단계만 본다
      && /!s\.from/.test(src)                                       // 이어받은 것은 이번 것이 아니다
      && /String\(s\.noShot \|\| ""\)\.trim\(\)/.test(src)      // 사유를 적으면 통과
      && !/verdict/.test(src)                                       // 판정으로 가르지 않는다
      && /const unshot = unshotClaims\(steps, String\(a\.kind \|\| ""\) === "handoff"\)/.test(mcp)
      && /if \(unshot\.length\) return \{ ok: false/.test(mcp);
  });
  check("사진 없음 딱지는 판정으로 피할 수 없다", () => {
    const p2 = path.join(tmp, "unshot.html");
    // info로 내려도, 화면을 주장했으면 사진 없음이 붙는다.
    buildReport({ title: "표본3", runId: "smoke-unshot", out: p2, steps: [
      { name: "합계가 맞다", expected: "총 3건", verdict: "info", noShot: "앱이 응답하지 않았다" },
      { name: "그냥 메모", verdict: "info" },
    ] });
    const g = readFileSync(p2, "utf8");
    return /chip unproven">사진 없음/.test(g)
      && /사진 없이 적은 것/.test(g) && g.includes("앱이 응답하지 않았다")
      // 주장하지 않은 메모에는 경고하지 않는다. 표시는 하나만 붙는다.
      && (g.match(/사진 없음/g) || []).length === 1;
  });
  check("회차 결과가 사실을 그대로 센다", () =>
    res.checks === 3 && res.failed === 1 && res.unverified === 1 && res.steps === 4);

  // 앱 회차의 장면은 세로로 길다. 가로 화면과 같은 영역에 넣으면 한 장이 폭의 30%도 쓰지 못하고
  // 좌우가 빈다(확인 결과: 1112px 영역에 299px 사진, 양옆 406px씩). 폰 화면은 글자·버튼이
  // 화면 대비 커서 작게 놓아도 읽히므로, 여러 장이면 나란히 놓고 한 장이면 영역을 좁힌다.
  const tallPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAIAAADg0arLAAAAEklEQVR4nGM4cenOiUt3GPBQAK4UGJ1cr3PZAAAAAElFTkSuQmCC", "base64");
  const tshot = (n) => { const p = path.join(tmp, n + ".png"); writeFileSync(p, tallPng); return p; };
  const tA = addReceipt({ surface: "app", expected: "비어 있다", got: "비어 있다", pass: true, shot: tshot("t1") });
  const tB = addReceipt({ surface: "app", expected: "합계", got: "합계", pass: true, shot: tshot("t2") });
  const ap = path.join(tmp, "app.html");
  buildReport({ title: "앱", runId: "smoke-app", out: ap, steps: [
    { name: "한 장", expected: "비어 있다", receipt: tA.id, verdict: "pass", at: "1" },
    { name: "여러 장", expected: "합계", receipt: tB.id, verdict: "pass", at: "2",
      before: tshot("t3"), after: tshot("t4") },
    // 한 화면에서 두 곳을 확인한 경우다. 두 번째 확인도 자기 장면과 판정을 가져야 한다.
    { name: "두 곳 확인", expected: "합계", receipts: [tA.id, tB.id], verdict: "pass", at: "3",
      before: tshot("t5") },
  ] });
  const a = readFileSync(ap, "utf8");
  const acard = (n) => { const i = a.indexOf(`<span class="num">${n}</span>`);
    return a.slice(a.lastIndexOf("<section", i), a.indexOf("</section>", i)); };
  // 규모가 커지면 페이지 형태가 바뀌어야 한다. 소스에 규칙이 있는지가 아니라 렌더 결과가 실제로
  // 달라지는지 확인한다. 94항목 회차가 문서 95000px로 나온 뒤에도 소스 검사는 전부 통과였다.
  {
    const mk = (k) => Array.from({ length: k }, (_, i) => ({
      name: `항목 ${i + 1}`, expected: "무엇", got: "무엇",
      verdict: i === 3 ? "fail" : "pass", receipt: tA.id, at: String(i) }));
    const bigP = path.join(tmp, "dense.html"), smallP = path.join(tmp, "sparse.html");
    buildReport({ title: "많음", runId: "smoke-dense", out: bigP, steps: mk(45) });
    buildReport({ title: "적음", runId: "smoke-sparse", out: smallP, steps: mk(10) });
    const big = readFileSync(bigP, "utf8"), small = readFileSync(smallP, "utf8");
    check("항목이 많으면 조밀 지면으로 나온다", () =>
      /<div class="wrap rev dense">/.test(big)
      && /<nav id="qnav">/.test(big)
      && /<section id="q45"/.test(big)
      && /\.dense \.stage,\.dense \.stage\.wide\{--sh:340px\}/.test(big)
      && /\.dense \.case\{min-height:0;contain-intrinsic-size:auto 420px\}/.test(big));
    check("적은 회차는 지금 지면 그대로다", () =>
      /<div class="wrap rev">/.test(small) && !/<nav id="qnav">/.test(small));
    check("색인은 안 된 것을 먼저 세운다", () => {
      const nav = sliceBetween(big, "<nav id=\"qnav\">", "</nav>", "색인은 안 된 것을 먼저 세운다");
      return /<b>안 됨 1<\/b><a class="fail" href="#q4"/.test(nav)
        && /<b class="all">전체 45<\/b>/.test(nav);
    });
    check("눌러서 간 항목이 색인 뒤에 숨지 않는다", () =>
      // 색인 높이는 창 폭과 사진 로딩에 따라 바뀐다. 상수로 고정하면 그때마다 다시 가려진다.
      /\.dense section\[id\^="q"\]\{scroll-margin-top:calc\(var\(--navh, 140px\) \+ 12px\)\}/.test(big)
      && /nav\.offsetHeight \+ "px"/.test(big)
      && /addEventListener\("resize", set\)/.test(big)
      && /addEventListener\("load", set\)/.test(big));
  }
  check("세로 장면 여럿은 여정 줄로 늘어놓는다", () => {
    const c = acard(2);
    return /class="req case pass strip"/.test(c) && /class="track strip"/.test(c)
      && (c.match(/class="fr on"/g) || []).length === 2   // 둘 다 보인다. 넘길 것이 없다
      && !/class="arw/.test(c) && !/class="count"/.test(c)
      && /class="qalist band"/.test(c)                    // 원한 것은 제목 밑 한 줄 띠로
      && /\.track\.strip\{display:flex/.test(a) && /overflow-x:auto/.test(a);
  });
  check("세로 장면 한 장은 자리를 좁힌다", () => {
    const c = acard(1);
    return /class="req case pass two tall solo"/.test(c) && /class="track solo"/.test(c)
      && /style="--ar:0\.400"/.test(c)                    // 2x5 → 가로/세로 0.4
      && /\.track\.solo\{width:calc\(\(var\(--sh\) - 74px\) \* var\(--ar\)/.test(a);
  });
  // 판정을 한쪽에 모아 두면 어느 사진이 어느 주장의 근거인지 매번 다시 확인해야 한다.
  // 확인이 여럿이면 어느 장면이 어느 확인의 근거인지 배지가 갈라 준다. 확인이 하나뿐이면
  // 카드 머리의 태그가 이미 그 판정이므로 배지를 달지 않는다. 같은 내용을 두 번 표시하지 않는다.
  check("장면마다 자기 판정이 붙는다", () => {
    const c2 = acard(2), c3 = acard(3);
    return /<figcaption><span class="lb">후<\/span><\/figcaption>/.test(c2)
      && !/class="ck /.test(c2) && !/class="cw"/.test(c2)  // 확인 하나: 태그·목록이 이미 말했다
      && /<figcaption><span class="lb">확인 2<\/span><span class="ck ok">됨<\/span>/.test(c3)
      && /<figcaption><span class="lb">후<\/span><span class="ck ok">됨<\/span>/.test(c3)
      && /전<\/span><\/figcaption>/.test(c3)             // 조작 전 장면은 증명하는 것이 없다
      && /figcaption \.ck\.ok\{background:var\(--green-2\)/.test(a);
  });
  // 기대값과 실제값이 같으면 그 줄은 정보를 더하지 않는다. 같다는 사실은 됨 태그가 이미 표시한다.
  check("같은 값을 두 줄로 적지 않는다", () => {
    const ok = card(1), bad = card(2);
    return !/나온 것/.test(ok) && /나온 것<\/dt><dd>빈 화면/.test(bad);
  });
  // 가로로 넓은 장면은 기존 방식대로 한 영역에 겹쳐 놓고 넘겨 본다.
  check("가로 장면은 겹쳐 놓고 넘긴다", () => {
    const c = card(1);                                    // 전·후 두 장, 정사각 표본이라 tall이 아니다
    return /class="req case pass two"/.test(c) && !/tall/.test(c)
      && /class="arw prev"/.test(c) && /class="count"/.test(c)
      && (c.match(/class="fr on"/g) || []).length === 1;   // 한 번에 한 장만 보인다
  });
  rmSync(tmp, { recursive: true, force: true });
}

// [10i] QA 도구 다섯
// 보이지 않는 창은 크롬이 렌더링을 멈춘다. 합성 프레임을 기다리는 캡처는 25초를 대기한다.

  // 결정을 읽는 사람은 이 화면을 보지 않았다. 한 덩어리 산문이면 판단할 수 없으므로
  // 짧게 쓰기를 기대하지 않고 페이지가 문장을 나눈다. 함수를 분리해 실제로 실행한다.
  check("결정 글은 문장마다 줄이 나뉘고 숫자 마침표는 안 나뉜다", () => {
    const src = read("bin/mcp/report.mjs");
    const a1 = src.indexOf("function sentences(s)");
    if (a1 < 0) return false;
    const a2 = src.indexOf("\n}", a1) + 2;
    const sentences = new Function("return " + src.slice(a1, a2).replace(/^function sentences/, "function"))();
    const got = sentences("검수 화면이 하는 일은 원문을 보고 정하는 것이다. 그런데 볼 것이 없다. 버전 1.0.24 얘기가 아니다.");
    return got.length === 3
      && got[2] === "버전 1.0.24 얘기가 아니다."          // 숫자 사이 마침표는 문장 끝이 아니다
      && sentences("한 줄\n두 줄").length === 2            // 쓴 사람이 나눈 줄도 지킨다
      && sentences("").length === 0;
  });

  check("결정 카드는 근거·이유·갈래 순서로 선다", () => {
    const src = read("bin/mcp/report.mjs");
    const card = sliceBetween(src, "function noteCard(dir, nt)", "function ledgerCard", "결정 카드");
    const i1 = card.indexOf("무엇을 보았나"), i2 = card.indexOf("왜 정해야 하나"), i3 = card.indexOf("정해야 할 것");
    return i1 > 0 && i2 > i1 && i3 > i2                    // 근거보다 질문이 먼저 오면 안 된다
      && /o\.pick/.test(card) && /o\.then/.test(card) && /o\.cost/.test(card)
      && /nt\.lean/.test(card)
      && /간단한 결정/.test(card)                           // 빠진 것이 보인다
      // 300px 섬네일을 놓고 무엇을 보고 정하라는 것인지 알 수 없다
      && /\.nb \.proof \.frame img\{max-height:none/.test(src);
  });





// ── 장부에 있지만 페이지가 읽지 않던 값 ─────────────────────────
// 생성하는 코드가 있어도 호출하는 곳이 없으면 없는 기능과 같다. same 프레임은 136건이 장부에
// 적혀 있었지만 페이지에 그 수를 집계하는 코드가 없었다.
check("지면이 안 변한 장면을 센다", () =>
  /if \(e\.same\) for \(const \[rid, pth\] of lanesOf\(e, open\)\)/.test(mcpReport)
  && /ln\.same = \(ln\.same \|\| 0\) \+ 1;/.test(mcpReport)
  && /ln\.same \? ` · 안 변한 장면 \$\{ln\.same\}장` : ""/.test(mcpReport));

// 선택자가 여러 곳에 걸린 판정은 그중 하나만 보고 내려진다. 판정문 문자열에만 있으면 집계할 수 없다.
check("지면이 하나로 안 좁혀진 판정을 센다", () =>
  /Number\(x\.matched\) > 1/.test(mcpReport)
  && /하나로 안 좁혀진 판정 \$\{wide\.length\}건/.test(mcpReport)
  && /\$\{ledIndex\}\$\{wideBlock\}/.test(mcpReport));

}
