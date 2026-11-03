#!/usr/bin/env node
// QA 전용 MCP: 서버가 소유한 회차에 허용된 명령만 전달한다.
import http from "node:http";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { port as irisPort } from "../server/env.cjs";
import { QA_COMMANDS, QA_COMMAND_SCHEMAS, validateQaCommand } from "../server/qa-protocol.js";
import { createSessionResolver } from "./iris-session.mjs";
import { qaView } from "./mcp/qa-view.mjs";

const resolveSession = createSessionResolver();
// 회차 없이 부르는 명령
const RUNLESS = ["run_begin", "summary", "catalog", "catalog_revise"];
const port = irisPort();
const title = {
  run_resume:"검증된 회차의 소유권과 활성 항목 복구", tabs:"회차 웹 탭 목록", tab:"회차 웹 탭 선택", close_tab:"회차 웹 탭 닫기. 항목 실행 중에는 거부. 회차가 끝나면 사용자가 볼 최종 산출물 탭만 남김",
  run_begin: "QA 회차 시작. plan.build.repo로 시작·종료 git 상태와 앱 반응 목록 조회. 소비 코드가 다른 저장소에도 있으면 plan.build.related에 그 저장소 절대 경로 목록. risks·listRationale 필수. charter.unattended는 묻지 않고 바로 무인 진행, approvals.logins/bulkFill은 미리 승인할 작업, investigationLimitMin 기본 10분", run_end: "QA 회차 종료. session.defects는 입력하지 않으며 qa_defect 기록으로 서버가 채움", report: "검증된 장부로 회차 보고서를 만들어 Iris 탭에 엶. overview.cases [{id, title, flow(화면 > 행동 > 결과), result, checks}]는 사람용 케이스. checks [{kind, text, pass, evidence:[{file, caption}]}]는 기기 효과로 남지 않는 확인(디자인 대조·화면 크기·접근성)과 증거 사진이고 kind는 기능·CMS → 앱 반영·디자인·화면 크기·접근성·수정 확인. scenes [{sha256, caption 또는 hide:true}]는 사진 설명 바꾸기·빼기. text [{from, to}]는 그 케이스 기록의 글 고치기, overview.text는 보고서 전체 글 고치기(커밋 해시·소스 경로 같은 개발 흔적 정리), overview.notes [{id, hide:true}]는 결정 카드 빼기. 적용되지 않은 규칙이 있으면 보고서를 만들지 않고 그 글이 있는 곳을 알림. overview가 크면 같은 내용의 JSON 파일 경로를 overviewFile로",
  row: "확인 항목 선언(declare)·시작(open)·종료(close)·결정 기록(note)·판정 무효(void). declare는 risk·oracle·dataChanging·mustNotChange 필수이고, 데이터를 바꾸면 consumers(file:line 또는 미확인+attempts)와 rerun{mode:setup·generated·human,reason}도 필수. retestOf {run,defect}는 수정 뒤 재확인 연결. close의 note·sceneJudgment와 void why는 사람용 보고서에 그대로 나가므로 화면에서 본 것만 씀(명령 이름·회차 번호·코드 이야기 제외). void는 receipt(조작·실패 장면·판정 seq)와 why로 잘못 기록된 판정 하나를 무효로 함. 진행할 수 없는 항목은 qa_review decisions로 넘김", expect: "화면 조건 판정. 실패 시 다음 입력 전에 화면과 오류 상태 자동 보존",
  play: "확인 항목 하나의 steps를 LLM 호출 없이 연속 실행. 단계마다 target(role+name 또는 text)을 그 순간 찾아 실제 입력하고 expect를 판정. 첫 실패나 모르는 가림에서 항목을 닫고 남은 단계는 실행하지 않음. 열린 항목이 없으면 row(경로가 여럿이면 path)를 열고 실행하고, 직전 실행이 막힘으로 닫은 항목은 row 없이 다시 엶. rerun.mode가 setup이면 시작 상태 단계에 setup:true, generated면 입력값과 기대에 {{unique}}. 첫 실행 전 qa_list_review 필수. 수정 뒤에는 retestOf:{run,defect}로 다시 실행",
  list_review: "첫 qa_play 전 QA 목록 검토. 인자 없이 부르면 위험별 항목·중복 후보·소비자 미확인·경로/근거 분포를 돌려줌. review에 row별 information, 중복별 merge/split·reason, distribution·missingRisks를 기록. duplicates.merge는 rows 첫 항목이 대표. 목록이 바뀌면 바뀐 row만 다시 검토",
  review: "decisions:[{row 또는 defect,reason}]로 해결 불가 항목을 사람 확인으로 넘김. remediation에서 수정 상태·재실행 목록 조회. 미판단 기대 밖 반응·배경 반응·모르는 가림을 사진 경로·요소·시각·스택 등 단서와 함께 일괄 조회. 도구 동작 뒤 사진과 제품 코드를 조사하여 qa_unexpected 판단",
  unexpected: "반응 ID를 연관 반응·무관 반응·방해 화면·배경 반응·문제로 분류. condition, source(file:line 또는 미확인+attempts), cause 필수. 연관 반응은 action+expect, 방해 화면은 handler+처리 뒤 expect 필수. 문제는 qa_defect 연결. 판단은 앱 목록에 저장하며 미판단이 남으면 run_end 거부",
  fix: "diagnosis:{source:file:line,reason} 필수. failureSeq는 빼면 결함 기록에서 채움. testReason·cleanupReason은 단언 변경·다른 파일 수정 이유. 시도 상한 2회. qa_defect 순번·수정 commit·summary 기록. 회차 저장소 또는 plan.build.related 저장소에서, 시작 때와 다른 현재 브랜치에 포함된 커밋만 허용. 수정 후 qa_row declare.retestOf {run,defect}로 재확인 연결",
  catalog: "repo 앱의 반응 목록(연관·무관·방해·배경 반응)과 삭제 기록 조회",
  catalog_revise: "사람이 요청한 반응 목록 수정. key 항목을 class·condition·action·expect로 고치거나 remove:true로 삭제. source·cause 필수. 사람 승인은 이 세션 대화에서 받고, 승인받으면 userApproved:true로 다시 부름. 무인 실행 중·같은 앱 회차 진행 중에는 거부",
  summary: "여러 회차(runIds)를 묶은 보고서를 엶. title을 주면 qa_report와 같은 사람용 보고서 한 장으로 만들고 같은 항목은 마지막 판정만 케이스로 보임. overview는 qa_report와 같고 cases[].id는 항목 ID 또는 \"회차ID:항목ID\". 다른 ID로 다시 선언한 항목은 replaces [{from, to, why}]로 앞 항목을 대신함. runJson(무인 실행기의 run.json)을 주면 verify.json도 함께 보고. 변조된 장부는 빼고 판정·고침은 사람 확인 전으로 표시. overview가 크면 overviewFile",
  defect: "결함 하나 기록. 단계·실패 장면·오류·환경은 서버 장부에서 첨부. reproducible을 빼면 같은 기대의 실패·통과 판정 수로 계산(재현됨은 실패 판정이 두 번 이상일 때만 허용). 연결할 실패 판정은 기본으로 같은 항목의 마지막 실패이며 failureSeq로 직접 고르거나, 관찰·비교로 찾아 실패 판정이 없으면 noFailure:true",
  note: "진행 중 세션 메모: 관찰·아이디어·막힘·질문. 결정 기록은 qa_row note 사용",
  charter: "진행 중 charter 변경. 변경 이유와 원래·수정 charter를 함께 보존", blocked: "진행 불가 사유 기록",
  route_save: "검증된 구간을 경로로 저장", route_list: "저장된 경로 조회", route_replay: "저장된 경로를 실제 입력으로 재생",
  open_entry: "계획에 적힌 진입 주소 열기", snapshot: "접근성 화면 읽기", screenshot: "현재 화면 촬영",
  text: "화면 본문 읽기", url: "현재 주소 읽기", observe: "화면과 오류 상태 관찰",
  click: "좌표 클릭", dblclick: "좌표 더블클릭", hover: "좌표 위에 포인터 놓기", drag: "두 좌표 사이 드래그",
  type: "포커스된 곳에 입력", key: "키 입력", scroll: "좌표에서 휠 스크롤", history: "뒤로·앞으로·새로고침",
  viewport: "화면 크기 지정", dialog: "확인 창에 답함", login: "허용된 계정으로 로그인. 원격 사이트의 허용 안 된 계정은 대화에서 사용자 승인을 받은 뒤 userApproved:true로 다시 부름", ask_user: "사람에게 할 일을 요청. 알림 없이 기록만 하고 결과의 note대로 이 세션 대화에서 물음. 무인 회차는 사람 필요를 기록하고 다음 항목으로 넘어감",
};

// 클라이언트에 보이는 스키마. 압축 때마다 도구 정의가 다시 들어가므로 효과 type처럼 한 칸 값으로 갈리는 anyOf는
// 한 객체로 합치고 minLength 1·빈 required는 뺌. 인자 검사는 서버가 정본 스키마로 함(qaArguments → validateQaCommand)
const tagOf = (option) => option?.type === "object" && Object.keys(option.properties || {}).find((key) => option.properties[key].enum?.length === 1);
export function clientSchema(schema) {
  if (Array.isArray(schema)) return schema.map(clientSchema);
  if (!schema || typeof schema !== "object") return schema;
  const tag = schema.anyOf?.length > 1 && tagOf(schema.anyOf[0]);
  if (tag && schema.anyOf.every((option) => tagOf(option) === tag)) {
    const properties = {};
    for (const option of schema.anyOf) for (const [key, p] of Object.entries(option.properties)) if (key !== tag) properties[key] ??= p;
    const common = schema.anyOf.map((option) => option.required || []).reduce((a, r) => a.filter((key) => r.includes(key)));
    const extra = schema.anyOf.map((option) => [option.properties[tag].enum[0], (option.required || []).filter((key) => !common.includes(key))])
      .filter(([, keys]) => keys.length).map(([value, keys]) => `${value}: ${keys.join("·")}`);
    return clientSchema({ type: "object", properties: { [tag]: { type: "string", enum: schema.anyOf.map((option) => option.properties[tag].enum[0]) }, ...properties },
      required: common, additionalProperties: false, ...(extra.length ? { description: `${tag}별 필수 ${extra.join(", ")}` } : {}) });
  }
  const drop = ([key, value]) => (key === "minLength" && value === 1) || (key === "required" && Array.isArray(value) && !value.length);
  return Object.fromEntries(Object.entries(schema).filter((entry) => !drop(entry)).map(([key, value]) => [key, clientSchema(value)]));
}

const toolOf = (cmd) => ({
  name: `qa_${cmd}`,
  description: (title[cmd] || ({handoff:"절차와 기준 이미지 안내서",diff:"장부의 두 장면 비교",shot_sizes:"화면 크기별 촬영",bulk_fill:"준비 화면 대량 기입",
    app_targets:"Iris 에뮬레이터 기기 목록",app_target:"기기 연결·선택",app_snapshot:"기기 화면 읽기",app_screenshot:"기기 화면 촬영",app_observe:"기기 화면과 오류 관찰",
    app_expect:"기기 화면 조건 판정",app_picks:"사람이 기기 화면에서 고른 요소 조회"})[cmd] || cmd)
    + (QA_COMMAND_SCHEMAS[cmd].required.includes("expect") ? ". expect(effects·oracle) 필수, 기대 밖 반응은 qa_unexpected로 판단" : ""),
  inputSchema: clientSchema(RUNLESS.includes(cmd) ? QA_COMMAND_SCHEMAS[cmd] : {
    ...QA_COMMAND_SCHEMAS[cmd],
    properties: { run: { type: "string", minLength: 1, description: "qa_run_begin이 반환한 회차 ID" }, ...QA_COMMAND_SCHEMAS[cmd].properties },
    required: ["run", ...QA_COMMAND_SCHEMAS[cmd].required],
  }),
});


// 조작 도구는 action 하나로 고르는 두 도구로 보임. 서버 명령과 인자 검사는 그대로(옛 이름 호출도 받음)
// 웹 조작 9개·앱 조작 4개가 같은 기대 스키마를 13번 실어 도구 정의 74.6KB 중 21KB를 차지하던 사례
export const QA_MERGED = Object.freeze({
  act: { click: ["click"], dblclick: ["dblclick"], hover: ["hover"], drag: ["drag"], type: ["type"], key: ["key"], scroll: ["scroll"],
    select: ["select"], back: ["history", "back"], forward: ["history", "forward"], reload: ["history", "reload"] },
  app_act: { tap: ["app_tap"], swipe: ["app_swipe"], type: ["app_type"], key: ["app_key"] },
});
// 목록에서 빼는 명령: 합친 조작과, snapshot 결과(url·title)로 대신하는 읽기
const HIDDEN = new Set([...Object.values(QA_MERGED).flatMap((actions) => Object.values(actions).map(([cmd]) => cmd)), "text", "url"]);
const mergedTool = (name, actions, summary) => {
  const properties = {}, needs = [];
  for (const [action, [cmd, fixed]] of Object.entries(actions)) {
    const schema = QA_COMMAND_SCHEMAS[cmd];
    for (const [key, value] of Object.entries(schema.properties)) if (!(fixed && key === "action")) properties[key] ??= value;
    const required = schema.required.filter((key) => key !== "expect" && !(fixed && key === "action"));
    if (required.length) needs.push(`${action}: ${required.join("·")}`);
  }
  return { name: `qa_${name}`, description: `${summary} hover 외에는 expect(effects·oracle 필수, within 기본 5000ms·최대 15000ms) 필수. 결과의 기대 밖 반응은 qa_unexpected로 판단. action별 필수: ${needs.join(", ")}`,
    inputSchema: clientSchema({ type: "object", additionalProperties: false,
      properties: { run: { type: "string", minLength: 1, description: "qa_run_begin이 반환한 회차 ID" }, action: { type: "string", enum: Object.keys(actions) }, ...properties },
      required: ["run", "action"] }) };
};
export const QA_TOOLS = Object.freeze([...QA_COMMANDS.filter((cmd) => !HIDDEN.has(cmd)).map(toolOf),
  mergedTool("act", QA_MERGED.act, "웹 화면 조작 하나. 진입이나 직전 조작 뒤 qa_snapshot으로 화면을 본 다음 부름."),
  mergedTool("app_act", QA_MERGED.app_act, "Iris 에뮬레이터 기기 조작 하나. device를 빼면 이 회차의 기기.")]);

// qa_act·qa_app_act 를 서버 명령으로 바꿈. 그 밖의 이름은 그대로
export function resolveQaCommand(name, input) {
  const merged = typeof name === "string" && QA_MERGED[name.slice(3)];
  if (!merged) return { name, input };
  const { action, ...rest } = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const target = merged[action];
  if (!target) throw new Error(`${name}의 action은 ${Object.keys(merged).join("·")} 중 하나입니다`);
  const [cmd, fixed] = target;
  return { name: `qa_${cmd}`, input: fixed ? { ...rest, action: fixed } : rest };
}

export function qaArguments(name, input) {
  ({ name, input } = resolveQaCommand(name, input));
  if (typeof name !== "string" || !name.startsWith("qa_")) throw new Error("허용되지 않은 도구");
  const cmd = name.slice(3);
  if (!QA_COMMANDS.includes(cmd)) throw new Error(`허용되지 않은 QA 명령: ${cmd}`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("인자 객체가 필요합니다");
  const { run, ...args } = input;
  if (RUNLESS.includes(cmd) && Object.hasOwn(input, "run")) throw new Error(`${cmd}에는 run을 넣지 않습니다`);
  if (!RUNLESS.includes(cmd) && (typeof run !== "string" || !run.trim())) throw new Error("run이 필요합니다");
  return { cmd, args: validateQaCommand(cmd, args), ...(RUNLESS.includes(cmd) ? {} : { run }) };
}

// 회차 열쇠: 이 도구 연결 메모리에만 보관하고 LLM 에게 보이는 결과에서는 뺌
const runKeys = new Map();
export async function callQa(name, input, { session = resolveSession, request = http.request, keys = runKeys } = {}) {
  const { cmd, args, run } = qaArguments(name, input);
  const owner = await session();
  if (!owner) return { ok: false, error: "현재 Iris 세션을 확인하지 못했습니다" };
  const key = run ? keys.get(run) : undefined;
  const payload = JSON.stringify({ cmd, args, session: owner, ...(run ? { run } : {}), ...(key ? { key } : {}) });
  const result = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/qa-cmd", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "", ended = false;
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        ended = true;
        try { resolve(JSON.parse(body)); }
        catch { resolve({ ok: false, error: "Iris 응답을 읽지 못했습니다" }); }
      });
      res.on("aborted", () => resolve({ ok: false, error: "Iris 연결이 끊겼습니다. 명령 처리 여부를 확인하세요" }));
      res.on("close", () => { if (!ended) resolve({ ok: false, error: "Iris 연결이 끊겼습니다. 명령 처리 여부를 확인하세요" }); });
    });
    req.on("error", (error) => resolve({ ok: false, error: `Iris에 연결하지 못했습니다: ${error.message}` }));
    req.end(payload);
  });
  // 이어받기로 새로 받은 열쇠도 같은 방식으로 보관
  if ((cmd === "run_begin" || cmd === "run_resume") && result?.ok && result.data?.runKey) {
    keys.set(result.data.runId, result.data.runKey);
    delete result.data.runKey;
  }
  return result;
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

export function startQaMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  let active = 0, closing = false;
  const finish = () => { if (closing && active === 0) process.stdout.write("", () => process.exit(0)); };
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (method === "initialize") return ok(id, { protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "iris-qa", version: "1.0.0" },
      instructions: "QA 회차는 qa_run_begin으로 열고, 반환된 run을 모든 후속 명령에 넣습니다. 계획에 등록한 주소는 qa_open_entry로만 엽니다. 판정과 보고서는 서버 장부에서 생성합니다. 회차가 끝나면 사용자가 볼 최종 산출물 탭만 남기고 중간에 쓴 탭은 qa_close_tab으로 닫습니다. 사람에게 물을 일은 이 세션 대화에서 묻습니다(브라우저·폰 알림 없음). 페이지 확인 창이 뜨면 명령 결과에 내용이 오니 qa_dialog로 답합니다." });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: QA_TOOLS });
    if (method === "tools/call") {
      active++;
      // 회차 시작 승인은 30분까지 기다림. 클라이언트의 무응답 끊김(stdio 기본 30분)을 진행 알림으로 피함
      const progressToken = params?._meta?.progressToken;
      let beat = 0;
      const ticker = progressToken === undefined ? null
        : setInterval(() => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++beat } }), 60000);
      try {
        const result = await callQa(params?.name, params?.arguments ?? {});
        const resolved = resolveQaCommand(params?.name, params?.arguments ?? {});
        ok(id, { content: [{ type: "text", text: JSON.stringify(qaView(result, resolved.input, String(resolved.name || "").slice(3))) }], ...(result.ok ? {} : { isError: true }) });
      } catch (error) { ok(id, { content: [{ type: "text", text: `오류: ${error.message}` }], isError: true }); }
      finally { clearInterval(ticker); active--; finish(); }
      return;
    }
    if (id !== undefined) err(id, -32601, `지원하지 않는 메서드: ${method}`);
  });
  rl.on("close", () => { closing = true; finish(); setTimeout(() => process.exit(0), 15000).unref(); });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) startQaMcp();
