// 끝난 회차의 보고서가 도구 기록 방식 때문에 거부되던 사례(qa-92771d8c 보고서 거부)
import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkQaReport } from "../server/qa-report.js";

const charter = {
  question: "운영자가 CMS에서 만든 배너가 앱에 보이는가", scope: "CMS·앱 상점", exclusions: "없음",
  environment: "격리한 로컬 데이터", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "상점 기획서",
};
const sessionRecord = {
  work: "배너 확인", defects: "없음", curios: "없음", checked: "배너", unverified: { items: "없음", reason: "해당 없음" },
  blockers: "없음", outOfScope: "없음", risks: "없음", stopCriterion: "questions_answered", remainingQuestions: "없음",
};
const D = "76EDA0E3-F8CC-47FC-8267-EF94ED5F2811", B = "browser:t1", web = "http://localhost:3002/banners";
const lane = { rowId: "banner", path: "정상", lanes: [["banner", "정상"]] };
const expected = { effects: [{ type: "appear", text: "저장됨", oracle: "명세나 대화에서 정한 내용", id: "e1" }], within: 1200 };

// 조작 하나: 접수 → S1 → (결과 장면) → action → reaction → (실패 기록)
function act(events, { cmd = "click", surface = B, url = web, pass = true, scope = lane, failure, extra = {} } = {}) {
  const at = events.length + 1;
  events.push({ kind: "accepted", cmd, ...scope, surface, expected });
  events.push({ kind: "frame", claim: { kind: "S1" }, ...scope, acceptedSeq: at, shot: `shots/${at}-s1.png`, url, surface });
  if (pass) events.push({ kind: "frame", claim: { kind: "S2" }, ...scope, acceptedSeq: at, shot: `shots/${at}-s2.png`, url, surface });
  events.push({ kind: "action", cmd, ...scope, acceptedSeq: at, surface, pass, ...extra });
  const actionSeq = events.length;
  events.push({ kind: "reaction", cmd, ...scope, acceptedSeq: at, surface, pass });
  if (failure) events.push({ kind: "failure", ...scope, surface, claim: { kind: "S3" }, detail: { failureSeq: actionSeq, ...failure } });
}
const look = (events, surface = B, cmd = "snapshot") => events.push({ kind: "observation", cmd, surface, pass: true, ...lane });
function build(body, { color = "green" } = {}) {
  const events = [
    { kind: "run_begin", charter, plan: qaPlan({ entries: [web], surfaces: ["http://localhost:3002/"] }) },
    { kind: "row", action: "declare", rowId: "banner", rowData: { ...qaRowContract(), id: "banner", what: "배너 표시", given: "CMS 운영자", basis: "spec", basisNote: "상점 기획서", paths: ["정상"] } },
    { kind: "entry", surface: B, url: web },
    { kind: "accepted", cmd: "app_target" },
    { kind: "observation", cmd: "app_target", acceptedSeq: 4, url: "app://" + D, surface: D, pass: true },
    { kind: "observation", cmd: "app_snapshot", surface: D, pass: true },
    { kind: "observation", cmd: "snapshot", surface: B, pass: true },
    { kind: "row", action: "open", ...lane, rowData: {} },
  ];
  body(events);
  events.push({ kind: "row", action: "close", ...lane, rowData: { color, sceneJudgment: "화면 전체에 추가 이상이 보이지 않았다.", note: "배너 표시", frames: 2, receipts: 1, failed: color === "red" ? 1 : 0 } });
  events.push({ kind: "run_end", sessionRecord });
  return events.map((event, index) => ({ seq: index + 1, event: structuredClone(event) }));
}

test("판정을 무효 처리한 조작은 결과 장면이 없어도 받고, 무효 처리하지 않으면 거부한다", () => {
  // 9929·10683: 확인 창으로 탭이 멈춰 실패 장면 촬영이 시간 초과. 실패 판정은 도구 한계로 무효 처리
  const lost = { captureError: "timeout(10s)", observeError: "timeout(10s)" };
  const failed = voided => build(e => {
    act(e, { pass: false, failure: lost });
    if (voided) e.push({ kind: "row", action: "void", ...lane, rowData: { receipt: String(e.findLastIndex(x => x.kind === "reaction") + 1), why: "도구 한계: 확인 창으로 페이지가 멈춤" } });
    look(e); act(e); look(e);
  });
  assert.doesNotThrow(() => checkQaReport(failed(true)));
  assert.throws(() => checkQaReport(failed(false)), /\[P3\]/);
});

test("웹 탭과 기기를 번갈아 조작하면 그 화면의 다음 조작 전까지 그 화면 관찰을 센다", () => {
  // 10645: 웹 클릭 → 기기 끌기 → 웹 관찰
  const events = build(e => { act(e); act(e, { cmd: "app_tap", surface: D, url: "app://" + D }); look(e); });
  assert.doesNotThrow(() => checkQaReport(events));
  const unseen = build(e => { act(e); act(e, { cmd: "app_tap", surface: D, url: "app://" + D }); act(e); look(e); });
  assert.throws(() => checkQaReport(unseen), /\[L\]/);
});

test("조작으로 뜬 확인 창 기록은 조작 뒤 관찰이고, dialogBlocked 표시가 없는 이전 기록도 확인 창 답으로 본다", () => {
  // 10683·10688: 클릭 → 확인 창 기록 → qa_dialog(이전 기록에는 dialogBlocked 없음)
  const dialog = blocked => e => {
    act(e);
    const at = e.length + 1;
    e.push({ kind: "accepted", cmd: "dialog", ...lane, surface: B, expected });
    e.push({ kind: "observation", cmd: "dialog_open", ...lane, acceptedSeq: at, surface: B, pass: true, detail: { kind: "confirm", message: "버릴까요?" } });
    e.push({ kind: "action", cmd: "dialog", ...lane, acceptedSeq: at, surface: B, pass: true, ...(blocked ? { dialogBlocked: true } : {}), detail: { kind: "confirm", via: "intercepted" } });
    look(e);
    e.push({ kind: "assertion", ...lane, surface: B, url: web, pass: true, shot: `shots/${e.length + 1}-expect.png`, expected });
  };
  assert.doesNotThrow(() => checkQaReport(build(dialog(true))));
  assert.doesNotThrow(() => checkQaReport(build(dialog(false))));
});

test("전체 선택 키 뒤 같은 칸 입력과 이어지는 준비 입력은 마지막 입력 뒤 관찰로 확인한다", () => {
  // 19403·19496: qa_login 칸 채우기(전체 선택 → 입력)
  const target = { role: "textbox", name: "이메일" };
  const fill = (scope, otherTarget) => e => {
    act(e, { cmd: "key", scope, extra: { target, input: { kind: "key", key: "Meta+a" } } });
    act(e, { cmd: "type", scope, extra: { target: otherTarget || target, input: { kind: "type" } } });
    look(e);
  };
  assert.doesNotThrow(() => checkQaReport(build(fill(lane))));
  assert.throws(() => checkQaReport(build(fill(lane, { role: "textbox", name: "비밀번호" }))), /\[L\]/);
  const prep = { mode: "preparation", lanes: [] };
  const prepared = build(e => { act(e, { cmd: "key", scope: prep, extra: { target, input: { kind: "key", key: "Tab" } } }); act(e, { cmd: "type", scope: prep, extra: { target } }); look(e); act(e); look(e); });
  assert.doesNotThrow(() => checkQaReport(prepared));
});

test("보고서 거부 문구에 사유를 모두 담고 첫 사유를 앞에 둔다", () => {
  // qa-92771d8c: 첫 사유 하나만 보여 남은 28건을 장부에서 직접 세야 했음
  const twice = build(e => { act(e); act(e); act(e); look(e); });
  assert.throws(() => checkQaReport(twice), error => (error.message.match(/\[L\]/g) || []).length === 2 && /\(사유 2건\)$/.test(error.message));
});

test("사진 보고서는 표시 위치의 두 저장 형식을 받고, 사진 총량이 넘으면 파일 주소로 연결한다", async () => {
  // qa-92771d8c: {marks:[...]} 형식에서 회차 요약이 실패했고, 사진 7,684장을 모두 본문에 넣다 메모리가 부족했음
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { renderQaActionReport } = await import("../server/qa-action-report.js");
  const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-photos-"));
  const events = build(e => { act(e); look(e); act(e); look(e); });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB7sAAAAASUVORK5CYII=", "base64");
  for (const { event } of events) if (event.shot) { fs.mkdirSync(path.join(folder, path.dirname(event.shot)), { recursive: true }); fs.writeFileSync(path.join(folder, event.shot), png); }
  events.find(r => r.event.kind === "frame").event.marks = { marks: [{ label: "저장", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] };
  const html = renderQaActionReport(events, folder, { inlineBytes: png.length });
  assert.match(html, /위치 저장 \(가로 10%/);
  assert.equal((html.match(/src="data:image\/png;base64,/g) || []).length, 1);
  assert.ok((html.match(/src="file:\/\//g) || []).length >= 1);
});

test("준비 단계 조작의 판정을 무효 처리한 기록도 원본이 있는 무효로 받고, 없는 seq 를 가리키면 거부한다", () => {
  // qa-2ab6e345 seq 163: 자동으로 닫힌 직후 준비 단계로 기록된 판정 158 을 void 했는데 D1 이 원본을 찾지 못함
  const prep = { mode: "preparation" };
  const voided = receipt => build(e => {
    const at = e.length + 1;
    e.push({ kind: "accepted", cmd: "scroll", ...prep, surface: B, expected });
    e.push({ kind: "action", cmd: "scroll", ...prep, acceptedSeq: at, surface: B, pass: false });
    e.push({ kind: "reaction", cmd: "scroll", ...prep, acceptedSeq: at, surface: B, pass: false });
    e.push({ kind: "row", action: "void", rowId: "banner", rowData: { receipt: receipt ?? String(e.length), why: "스크롤 도구 확인용 조작" } });
    look(e); act(e); look(e);
  });
  assert.doesNotThrow(() => checkQaReport(voided()));
  assert.throws(() => checkQaReport(voided("999")), /\[D1\]/);
});
