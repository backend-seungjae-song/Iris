#!/usr/bin/env node
// iris-mcp: Iris 브라우저 제어를 MCP 도구로 노출한다(stdio).
// iris-browser CLI와 같은 표면·같은 경로(POST /browser-cmd)를 쓴다. 서버가 루프백 전용(AC5)이므로
// 이 프로세스도 같은 머신에서만 동작한다. 새 권한을 열지 않고 CLI로 할 수 있는 것만 할 수 있다.
//
// 공유 서버의 HERDR_PANE_ID는 다른 대화의 값일 수 있다. 현재 대화 ID와 프로세스 소유 관계는
// CLI와 같은 resolver에서 확인하며, 명시적 IRIS_SESSION은 현재 존재하는 pane만 허용한다.
//
// 등록: claude mcp add --scope user iris-mcp -- node <이 파일 경로>
// stdout은 JSON-RPC 전용이다. 로그는 반드시 stderr로.
import http from "node:http";
import { createSessionResolver, chooseHerdrPane } from "./iris-session.mjs";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateHome } from "../server/state-home.cjs";
import { createAppSurface } from "./mcp/app.mjs";

import { port as acPort } from "../server/env.cjs";
import crypto from "node:crypto";
import { bulkPolicy } from "../server/bulk-fill.js";

// 상태 폴더. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 사용 기록이 섞인다.
// 어디인지는 state-home.cjs 한 곳이 정한다.
const IRIS_HOME = stateHome();

const PORT = acPort();
const log = (...a) => process.stderr.write("[iris-mcp] " + a.join(" ") + "\n");
const resolveSession = createSessionResolver();
let discoveredSession = null;
async function currentSession() {
  discoveredSession = await resolveSession();
  return discoveredSession;
}

async function call(cmd, args = {}) {
  const session = await currentSession();
  return new Promise((resolve) => {
    // tab 이 undefined면 payload에 넣지 않는다(고정/스페이스 폴백을 그대로 쓰게).
    if (args.tab == null) delete args.tab;
    const payload = JSON.stringify({ cmd, args, session });
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/browser-cmd", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        let ended = false;
        const interrupted = (error) => resolve({ ok: false,
          error: "Iris 응답이 끝나기 전에 연결이 끊겼습니다. 명령이 처리됐을 수 있으니 상태를 확인하세요."
            + (error?.message ? ` ${error.message}` : "") });
        res.on("aborted", interrupted);
        res.on("error", interrupted);
        res.on("close", () => { if (!ended) interrupted(); });
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          ended = true;
          try { resolve(JSON.parse(body)); }
          catch { resolve({ ok: false, error: "응답 파싱 실패: " + body.slice(0, 200) }); }
        });
      });
    req.on("error", (e) => resolve({ ok: false, error: `Iris에 연결할 수 없습니다(127.0.0.1:${PORT}) — 앱이 실행 중인지 확인하세요. ${e.message}` }));
    req.end(payload);
  });
}

// 모바일 앱 표면(iOS·Android)은 bin/mcp/app.mjs 가 소유한다. 브라우저 표면과 바뀌는 이유가 다르고,
// 그쪽은 대상 기기(Iris 에뮬레이터 탭)만 서버에 묻고 조작은 idb·adb 를 직접 부른다.
const appSurface = createAppSurface({ currentSession, call });
function absorbMoments(result) {
  const moments = result?.data?.moments;
  if (!Array.isArray(moments) || !moments.length) return "";
  return "\n\n잠깐 뜬 알림:\n" + moments.map((m) => `· ${m.text || ""}${m.shot ? ` · 장면: ${m.shot}` : ""}`).join("\n");
}
const MAX_DEVICES = appSurface.MAX_DEVICES;
// 요소 지정은 snapshot ref(@e5)와 CSS 선택자를 모두 받는다. 둘 다 없으면 서버가 거부한다.
const TARGET = {
  ref: { type: "string", description: "browser_snapshot이 준 참조(@e5). 스냅샷을 뜬 직후에만 유효." },
  selector: { type: "string", description: "CSS 선택자. 스냅샷 없이 바로 쓸 수 있고 페이지가 바뀌어도 유효." },
};
const pickTarget = (a) => (a.ref ? { ref: String(a.ref) } : { sel: String(a.selector || "") });

const TOOLS = [
  { name: "notify",
    desc: "기다리지 않고 결과를 알린다. 같은 key는 기존 알림을 갱신하고, 짧은 시간에 많이 보내면 한 알림으로 합쳐진다. 사람이 확인할 보고서·화면을 탭에 띄워 두었으면 review:true와 그 tab을 준다. 그 알림은 사람이 닫을 때까지 남고, Iris가 뒤에 있으면 macOS 알림도 뜬다. 화면은 사람이 [그 탭으로]를 누를 때만 바뀐다. 이동하거나 닫은 것은 승인이 아니고 이 도구로 돌아오지도 않는다.",
    schema: {
      level: { type: "string", enum: ["ok", "info", "warn", "err"], description: "알림 수준" },
      title: { type: "string", maxLength: 60, description: "알림 제목(최대 60자)" },
      body: { type: "string", maxLength: 300, description: "알림 본문(최대 300자)" },
      detail: { type: "string", maxLength: 2000, description: "오류 원문 등 자세한 내용(최대 2000자)" },
      tab: { type: "string", description: "관련 탭" },
      device: { type: "string", description: "관련 기기" },
      key: { type: "string", maxLength: 100, description: "같은 알림을 갱신할 키" },
      review: { type: "boolean", description: "사람이 확인할 화면을 띄운 탭 알림. tab 필수" },
    }, req: ["level", "title"],
    run: async (a, C) => C("notify", { level: a.level, title: String(a.title), body: a.body, detail: a.detail, tab: a.tab,
      device: a.device ? (await appSurface.simTarget(a.device)) || a.device : a.device, key: a.key, review: a.review === true }) },
  { name: "progress",
    desc: "오래 걸리는 작업을 하나의 알림으로 시작·갱신·완료한다. 끝 신호가 없으면 ttl 뒤 응답 없음 경고로 남는다.",
    schema: {
      op: { type: "string", enum: ["start", "update", "end"], description: "작업 단계" },
      title: { type: "string", description: "start/update의 제목" },
      p: { type: "number", minimum: 0, maximum: 1, description: "진행률 0~1" },
      id: { type: "string", description: "start가 반환한 진행 알림 id" },
      result: { type: "string", enum: ["ok", "err"], description: "end 결과" },
      detail: { type: "string", description: "end의 자세한 내용" },
      tab: { type: "string", description: "관련 탭" },
      ttl: { type: "number", minimum: 1, description: "start 뒤 응답 없음으로 바꿀 초(기본 120)" },
    }, req: ["op"],
    run: (a, C) => C("progress", { op: a.op, title: a.title, p: a.p, id: a.id, result: a.result, detail: a.detail, tab: a.tab, ttl: a.ttl }) },
  { name: "browser_snapshot",
    desc: "현재 페이지의 접근성 스냅샷(요소 참조 @e1… 포함). 무엇이 있는지 모를 때 가장 먼저 쓴다. "
      + "큰 화면은 바이트 예산에서 끊기고 이어 볼 커서를 함께 준다 — 전체를 다시 받지 말고 커서로 잇거나 "
      + "role·name·region으로 좁혀라. 끊겨도 잘린 구간의 경고·상태·제목은 요약으로 따라온다.",
    schema: {
      role: { type: "string", description: "이 역할만(button·heading·alert·text input…). 부분 일치." },
      name: { type: "string", description: "이 이름을 포함하는 것만. 부분 일치." },
      region: { type: "string", description: "이 landmark 안쪽만(navigation·main·[장바구니]…)." },
      cursor: { type: "number", description: "지난 호출이 준 이어보기 위치." },
      budget: { type: "number", description: "직렬화 바이트 상한. 기본 20000." },
    },
    run: (a, C) => C("snapshot", {
      role: a.role, name: a.name, region: a.region,
      cursor: a.cursor != null ? Number(a.cursor) : undefined,
      budget: a.budget != null ? Number(a.budget) : undefined,
    }) },
  { name: "browser_click", desc: "요소를 클릭한다.", schema: TARGET, run: (a, C) => C("click", pickTarget(a)) },
  { name: "browser_dblclick", desc: "요소를 더블클릭한다.", schema: TARGET, run: (a, C) => C("dblclick", pickTarget(a)) },
  { name: "browser_hover", desc: "요소 위로 마우스를 올린다(hover 메뉴 펼치기).", schema: TARGET, run: (a, C) => C("hover", pickTarget(a)) },
  { name: "browser_fill", desc: "입력칸에 포커스하고 기존 내용을 지운 뒤 입력한다.",
    schema: { ...TARGET, text: { type: "string", description: "넣을 값" } },
    run: (a, C) => C("fill", { ...pickTarget(a), text: String(a.text ?? "") }) },
  // 대량 기입. 사람 경로로 한 칸씩 치는 것을 서버 안에서 반복할 뿐이지만, 되돌리기 어려운
  // 경우에 쓰이므로 두 단계로 나눈다. plan으로 무엇이 어디에 들어갈지 보고, 그 묶음
  // 그대로만 commit된다(값이 한 자라도 바뀌면 표가 달라지므로 토큰이 어긋난다).
  { name: "browser_bulk_fill",
    desc: "지금 커서 자리에서부터 값을 한 칸씩 연달아 넣는다. 시트 열처럼 같은 동작을 수십·수백 번 반복해야 할 때만 쓴다 — "
      + "그 외에는 browser_fill 을 쓴다. 먼저 커서를 넣을 첫 칸에 클릭으로 두고, action:\"plan\"으로 무엇이 들어갈지 확인한 뒤 "
      + "받은 token으로 action:\"commit\"한다. 로컬 주소는 그대로 들어가고, 원격 주소는 사람에게 보여 승인받은 뒤에만 들어간다.",
    schema: {
      action: { type: "string", enum: ["plan", "commit"], description: "기본 plan" },
      tab: { type: "string", description: "넣을 탭. 반드시 명시한다 — 물려받지 않는다." },
      values: { type: "array", items: { type: "string" }, description: "칸 하나에 하나씩, 순서대로." },
      advance: { type: "string", enum: ["Enter", "Tab", "ArrowDown", "ArrowRight"], description: "한 칸 친 뒤 이동할 방향키. 기본 Enter(아래)." },
      token: { type: "string", description: "commit에 필요. plan이 준 값 그대로." },
      allowFormula: { type: "boolean", description: "=·+·- 로 시작하는 값을 허용(시트가 계산식으로 읽는다). 기본 거부." },
      userApproved: { type: "boolean", description: "원격 화면 commit에서 이 세션 대화로 사용자 승인을 받았을 때만 true." },
      pauseMs: { type: "number", description: "칸 사이 간격(ms, 최대 200). 화면이 못 따라올 때만." },
    },
    req: ["tab", "values"],
    run: async (a, C) => {
      const tab = String(a.tab || "").trim();
      if (!tab) return { ok: false, error: "tab 을 명시하세요 — 대량 기입은 어느 탭인지 물려받지 않습니다." };
      const values = Array.isArray(a.values) ? a.values.map((v) => String(v ?? "")) : [];
      const advance = String(a.advance || "Enter");
      const where = "web:" + tab;
      const token = crypto.createHash("sha256")
        .update([tab, advance, String(!!a.allowFormula), ...values].join("\u0000")).digest("hex").slice(0, 16);

      const u = await C("url", { tab });
      const url = (u && u.data && (u.data.url || u.data.href)) || "";
      const surfaces = [];
      const pol = bulkPolicy({ url, values, where, surfaces, approved: false, allowFormula: !!a.allowFormula });
      if (pol.mode === "deny") return { ok: false, error: pol.reason };

      const head = values.slice(0, 3), tail = values.length > 6 ? values.slice(-3) : [];
      const preview = { 탭: tab, 주소: url, 칸수: values.length, 이동: advance,
        처음: head, ...(tail.length ? { 마지막: tail } : {}),
        판정: pol.mode === "free" ? "로컬 — 그대로 들어갑니다" : "원격 — commit 전에 이 세션 대화에서 사용자 승인을 받습니다" };

      if (String(a.action || "plan") !== "commit") {
        const shot = await C("screenshot", { tab });
        return { ok: true, data: { ...preview, token,
          before: (shot && shot.data && (shot.data.shot || shot.data.path)) || null,
          note: "커서가 첫 칸에 있는지 이 사진으로 확인하고, 같은 인자에 token을 실어 commit하세요." } };
      }

      if (String(a.token || "") !== token) {
        return { ok: false, error: "token이 인자와 맞지 않습니다 — plan 이후 값·탭·이동키가 바뀌었습니다. 다시 plan하세요.", token };
      }

      // 사람 승인은 이 세션 대화에서 받음. 승인받으면 같은 인자에 userApproved:true 로 다시 commit
      let approved = false;
      if (pol.mode === "confirm") {
        if (a.userApproved !== true) {
          const ask = await C("approve", { tab, title: "대량 기입 승인",
            summary: `${(() => { try { return new URL(url).host; } catch { return url; } })()} 에 ${values.length}칸을 연달아 넣습니다`,
            approve_label: "승인", deny_label: "취소" });
          return { ok: false, error: "사람 승인 전이라 아무것도 넣지 않았습니다. "
            + ((ask && ask.data && ask.data.note) || "이 세션 대화에서 사용자에게 승인을 물으세요.")
            + " 사용자가 승인하면 같은 인자에 userApproved:true를 넣어 다시 commit하세요." };
        }
        approved = true;
      }

      const r = await C("bulkfill", { tab, values, advance, where, approved,
        allowFormula: !!a.allowFormula, pauseMs: a.pauseMs });
      const after = await C("screenshot", { tab });
      const d = (r && r.data) || {};
      return { ...r, data: { ...d, 탭: tab, after: (after && after.data && (after.data.shot || after.data.path)) || null,
        ...(d.typed != null && d.typed !== values.length
          ? { 경고: `${values.length}칸 중 ${d.typed}칸만 들어갔습니다 — 표가 중간까지만 쓰여 있습니다. 화면을 보고 이어서 할지 되돌릴지 정하세요.` }
          : {}) } };
    } },
  { name: "browser_focus", desc: "요소에 포커스만 준다. 자동완성 목록·달력처럼 칸에 들어가야 열리는 것을 여는 데 쓴다 — browser_fill 은 글까지 넣어 버려 이 상태를 만들 수 없다.",
    schema: TARGET, run: (a, C) => C("focus", pickTarget(a)) },
  { name: "browser_clear", desc: "입력칸 내용만 비운다(새 값은 넣지 않는다). 지우고 그대로 두어야 할 때 쓴다.",
    schema: TARGET, run: (a, C) => C("clear", pickTarget(a)) },
  { name: "browser_check", desc: "체크박스·라디오를 원하는 상태로 맞춘다. 클릭과 달리 지금 상태를 읽고 필요할 때만 누르므로, 같은 명령을 두 번 돌려도 결과가 같다.",
    schema: { ...TARGET, on: { type: "boolean", description: "켤지 여부. 생략하면 켠다. 라디오는 끌 수 없다" } },
    run: (a, C) => C("check", { ...pickTarget(a), value: a.on === false ? false : true }) },
  { name: "browser_pdf", desc: "지금 페이지를 인쇄 레이아웃 그대로 PDF로 저장한다. 스크린샷과 다른 자리다 — 스크린샷은 화면에 보이는 픽셀이라 스크롤 밖이 잘리고 인쇄 전용 스타일이 안 걸린다. 여러 장짜리 표·주문서·영수증을 증거로 남길 때 쓴다.",
    schema: { path: { type: "string", description: "저장 경로. 생략하면 앱 폴더에 만든다" },
      landscape: { type: "boolean", description: "가로 방향" },
      background: { type: "boolean", description: "배경색·배경이미지 포함(기본 포함). 끄면 표 음영이 사라진다" },
      pages: { type: "string", description: "페이지 범위 — 예 \"1-3\"" },
      scale: { type: "number", description: "배율 0.1~2" } },
    run: (a, C) => C("pdf", { path: a.path, landscape: !!a.landscape,
      background: a.background !== false, pages: a.pages, scale: a.scale }) },
  { name: "browser_select", desc: "<select> 드롭다운에서 옵션을 고른다(표시 텍스트 또는 value).",
    schema: { ...TARGET, value: { type: "string", description: "옵션의 표시 텍스트 또는 value" } },
    run: (a, C) => C("select", { ...pickTarget(a), value: String(a.value ?? "") }) },
  { name: "browser_type", desc: "지금 포커스된 곳에 텍스트를 친다(요소 지정 없이).",
    schema: { text: { type: "string" } }, req: ["text"], run: (a, C) => C("type", { text: String(a.text) }) },
  { name: "browser_key",
    desc: "키를 누른다. 수식키는 앞에 붙여 한 문자열로 준다 — \"Enter\"·\"Tab\"·\"Escape\"·\"ArrowDown\"·\"Shift+Enter\"·\"Meta+K\"·\"Ctrl+Shift+P\"·\"a\". shift·ctrl·alt·meta(cmd)를 조합할 수 있고, 글자 키는 그대로 적는다. 별도 도구가 따로 있지 않다.",
    schema: { key: { type: "string", description: "예: Enter · Tab · Shift+Enter · Meta+K · Ctrl+Shift+P · a" } },
    req: ["key"], run: (a, C) => C("key", { key: String(a.key) }) },
  { name: "browser_goto",
    desc: "지정한 주소를 연다. 이 도구의 이동은 QA 근거에 포함되지 않는다.",
    schema: { url: { type: "string" } },
    req: ["url"],
    run: (a, C) => C("goto", { url: String(a.url) }) },
  { name: "browser_history", desc: "뒤로·앞으로·새로고침(리로드·refresh·F5·⌘R). 페이지를 그대로 다시 부를 때는 이것을 쓴다 — 같은 주소로 browser_goto 하거나 browser_new_tab을 다시 부르는 것은 새로고침이 아니다.",
    schema: { action: { type: "string", enum: ["back", "forward", "reload"] } }, req: ["action"],
    run: (a, C) => C(String(a.action)) },
  { name: "browser_scroll", desc: "스크롤한다. to를 주면 절대 위치, amount를 주면 상대 이동.",
    schema: { to: { type: "number", description: "절대 y 좌표" },
      amount: { type: "string", description: "down·up·top·bottom 또는 픽셀 수(상대 이동)" } },
    run: (a, C) => (a.to != null ? C("scrollto", { y: Number(a.to) }) : C("scroll", { amount: String(a.amount || "down") })) },
  { name: "browser_wait",
    desc: "기다린다. 기다릴 상태가 있으면 until 을 준다 — 조건이 맞는 순간 돌아오므로 고정 ms 를 여러 번 돌리지 않는다. "
      + "예: 응답 생성이 끝날 때까지 {gone: 'button[aria-label=\"응답 중단\"]', stable_ms: 2000}. "
      + "until 이 없으면 ms 만큼 고정 대기, 둘 다 없으면 readyState 완료까지(최대 10초).",
    schema: { ms: { type: "number" },
      until: { type: "object", description: "모두 맞을 때 돌아온다. selector=이 요소가 있다 · gone=이 요소가 없다 · text=본문에 이 글이 있다 · stable_ms=본문이 이 시간 동안 바뀌지 않았다.",
        properties: { selector: { type: "string" }, gone: { type: "string" }, text: { type: "string" }, stable_ms: { type: "number" } } },
      timeout_ms: { type: "number", description: "until 의 최대 대기(기본 30000, 최대 120000). 넘으면 마지막 상태와 함께 돌아온다." } },
    run: (a, C) => (a.until != null ? waitUntil(a.until, a.timeout_ms, C)
      : C("wait", a.ms != null ? { ms: Number(a.ms) } : {})) },
  { name: "browser_viewport", desc: "탭 화면 크기를 지정한다(반응형 확인). 뷰포트·배율·미디어쿼리가 모두 따라온다. clear를 주면 원래 크기로.",
    schema: { width: { type: "number" }, height: { type: "number" },
      dpr: { type: "number", description: "화면 배율(기본은 창 배율 그대로)" },
      clear: { type: "boolean", description: "지정을 해제하고 원래 크기로" } },
    run: (a, C) => (a.clear ? C("viewport", { clear: true })
      : C("viewport", { width: Number(a.width), height: Number(a.height), ...(a.dpr != null ? { dpr: Number(a.dpr) } : {}) })) },
  { name: "browser_text", desc: "본문 텍스트(innerText)를 가져온다.", schema: {}, run: (a, C) => C("text") },
  { name: "browser_url", desc: "현재 URL과 제목.", schema: {}, run: (a, C) => C("url") },
  { name: "browser_eval",
    desc: "페이지에서 JS를 실행하고 결과를 받는다. 이 결과는 QA 근거에 포함되지 않는다.",
    schema: { expression: { type: "string" } }, req: ["expression"],
    run: (a, C) => C("eval", { expression: String(a.expression) }) },
  { name: "browser_screenshot",
    desc: "화면을 PNG로 저장한다. mark로 볼 곳에 번호·테두리·설명을 얹을 수 있다. element면 해당 요소만, full이면 전체 페이지를 찍는다. 이 이미지는 QA 근거에 포함되지 않는다.",
    schema: {
      caption: { type: "string", description: "이 장면이 증명하는 것 한 줄(화면 아래 띠로 박힌다)" },
      mark: { type: "array", description: "표시할 곳들. 각 항목 {sel|ref, label?, color?} — ref는 snapshot의 그 ref 그대로",
        items: { type: "object", properties: { sel: { type: "string" }, ref: { type: "string" }, label: { type: "string" }, color: { type: "string" } } } },
      mask: { type: "array", description: "가릴 곳(비밀·개인정보). 선택자 문자열 배열", items: { type: "string" } },
      element: { type: "string", description: "이 선택자 영역만 잘라 찍는다" },
      full: { type: "boolean", description: "true면 스크롤 포함 페이지 전체" },
      dpr: { type: "number", description: "배율(2면 레티나 — 보고서에서 글자가 안 뭉갠다). zoom을 건드리지 말고 이것을 쓴다." },
      settle: { type: "number", description: "그리기가 끝나길 기다릴 상한 ms(기본 600). 재조회·애니메이션 중인 화면을 반쯤 찍지 않게." },
      path: { type: "string", description: "저장 경로(미지정이면 상태 폴더의 shots/)" },
      tab: { type: "string", description: "이 명령만 이 탭에서" } },
    run: (a, C) => C("screenshot", { caption: a.caption, mark: a.mark, mask: a.mask, element: a.element, full: a.full, dpr: a.dpr, settle: a.settle, path: a.path, tab: a.tab }) },
  // 스크린샷이 폴더에 흩어져 있으면 사람은 열어보지 않는다. 순서대로 묶어 한 장으로 만든다.
  { name: "browser_diff",
    desc: "스크린샷 두 장을 픽셀로 비교해 달라진 곳만 빨갛게 칠한 이미지를 만든다. 회귀 확인·전후 비교용.",
    schema: { before: { type: "string", description: "이전 PNG 경로" }, after: { type: "string", description: "이후 PNG 경로" },
      threshold: { type: "number", description: "무시할 색 차이(기본 24)" }, path: { type: "string" }, tab: { type: "string" } },
    req: ["before", "after"],
    run: (a, C) => C("diff", { before: String(a.before), after: String(a.after), threshold: a.threshold, path: a.path, tab: a.tab }) },
  // 반응형은 폭을 바꿔가며 같은 화면을 보는 일이다. 한 번에 실행하고 원래 크기로 되돌린다.
  { name: "browser_shot_sizes",
    desc: "모바일·패드·데스크톱(또는 1024x768 형식) 크기로 차례로 바꿔가며 각각 찍고 원래 크기로 되돌린다. 반응형 확인용.",
    schema: { sizes: { type: "array", items: { type: "string" }, description: "기본 [모바일, 패드, 데스크톱]" },
      caption: { type: "string" }, dpr: { type: "number" }, settle: { type: "number", description: "전환 후 대기 ms(기본 700)" },
      tab: { type: "string" } },
    run: (a, C) => C("shotsizes", { sizes: a.sizes, caption: a.caption, dpr: a.dpr, settle: a.settle, tab: a.tab }) },
  // 눈으로 확인되지 않는 결함. 이름 없는 버튼, alt 없는 이미지, 라벨 없는 입력칸, 옅은 글자.
  { name: "browser_a11y_check",
    desc: "접근성 결함을 찾는다 — 이름 없는 버튼·링크, alt 없는 이미지, 라벨 없는 입력칸, 대비 부족 글자. 위치(선택자 경로)까지 돌려준다.",
    schema: { tab: { type: "string" } }, run: (a, C) => C("a11y", { tab: a.tab }) },
  // 무엇을 했는지는 서버가 이미 기록한다. 보고서 단계를 다시 쓰지 않도록 그것을 그대로 받는다.
  { name: "browser_trace",
    desc: "이 세션이 지금까지 한 조작(클릭·입력·이동)의 기록. 보고서 단계로 그대로 옮겨 쓸 수 있다. clear를 주면 읽고 비운다.",
    schema: { clear: { type: "boolean" } }, run: (a, C) => C("trace", { clear: !!a.clear }) },
  { name: "browser_observe", desc: "닫힌 루프 QA: 스크린샷 + 콘솔 오류 + 예외 + 네트워크 실패 + 뜬 대화상자를 한 번에. 뭔가 안 될 때 원인을 찾는 첫 도구.",
    schema: { limit: { type: "number" }, level: { type: "string", enum: ["error", "warn", "all"] },
      screenshot: { type: "boolean", description: "false면 스크린샷 생략" } },
    run: (a, C) => C("observe", { limit: a.limit, level: a.level, screenshot: a.screenshot }) },
  { name: "browser_dialogs", desc: "alert·confirm 자동 응답을 무장/해제한다. 기본은 해제 — 사람이 보고 누른다. 'ok'·'cancel'은 이후 전부, 'ok,cancel'처럼 쉼표로 주면 뜨는 순서대로 답하고 다 쓰면 다시 사람에게 넘긴다.",
    schema: { plan: { type: "string", description: "off · ok · cancel · 쉼표로 이은 순서(예: ok,cancel,ok)" },
      promptText: { type: "string", description: "prompt 대화상자에 넣을 값" } },
    req: ["plan"], run: (a, C) => C("dialogs", { plan: String(a.plan), text: a.promptText }) },
  // 네이티브 창은 CDP 밖이다. 파일 선택·저장 패널은 뜨는 순간 사람이 누를 때까지 전부 멈춘다.
  { name: "browser_upload", desc: "페이지에 로컬 파일을 넣는다(네이티브 파일 선택 창을 띄우지 않는다). 파일 입력칸을 알면 ref/sel로 지목하고, 버튼이 숨은 입력을 여는 형태면 지목 없이 먼저 부른 뒤 그 버튼을 누른다.",
    schema: { paths: { type: "array", items: { type: "string" }, description: "올릴 파일 절대경로" }, ref: { type: "string" }, sel: { type: "string" }, timeout: { type: "number" } },
    req: ["paths"],
    run: (a, C) => C("upload", { paths: a.paths, ref: a.ref, sel: a.sel, timeout: a.timeout }) },
  { name: "browser_download", desc: "다운로드 저장 위치를 무장한다. 무장하면 네이티브 저장 창 없이 그 폴더에 저장된다. off면 사람이 고른다(기본).",
    schema: { dir: { type: "string", description: "절대경로 폴더, 또는 off" }, once: { type: "boolean", description: "다음 한 번만" } },
    run: (a, C) => C("download", { dir: a.dir, once: a.once }) },
  { name: "browser_native_windows", desc: "OS가 그린 창·시트를 본다(파일 패널·권한 시트·인쇄 창 등 CDP로는 안 보이는 층). 뭔가 멈춰 있는데 원인을 모를 때 확인한다.",
    schema: {}, run: (a, C) => C("nativewin") },
  { name: "browser_native_click", desc: "네이티브 창·시트의 버튼을 이름으로 누른다. 먼저 browser_native_windows로 버튼 이름을 확인한다.",
    schema: { button: { type: "string" } }, req: ["button"],
    run: (a, C) => C("nativeclick", { button: a.button }) },
  { name: "browser_dialog", desc: "지금 떠 있는 alert/confirm/prompt를 닫는다. 확인 창은 탭이 아니라 창에 붙어서, 뜬 채로 두면 그 창의 조작이 통째로 막힌다. 이 명령은 다른 명령이 그 창에 막혀 있어도 실행된다.",
    schema: { answer: { type: "string", enum: ["ok", "cancel"] }, text: { type: "string" } },
    run: (a, C) => C("dialog", { answer: a.answer || "cancel", ...(a.text != null ? { text: a.text } : {}) }) },
  { name: "browser_login", desc: "저장된 로그인으로 이 페이지의 아이디/비밀번호 칸을 채운다. 사용자가 앱의 [🔑 로그인]에서 허용한 (사이트, 아이디)만 가능하다. 허용된 계정이 여럿이면 목록을 돌려주니 하나를 골라 다시 부른다. 비밀번호 값은 돌아오지 않고 이 탭의 명령 결과에서도 가려진다. 채운 뒤 로그인 버튼은 직접 눌러야 한다. 저장된 계정이 없거나 허용되지 않았으면 사용자에게 알림이 가고 사람이 로그인한다.",
    schema: { username: { type: "string", description: "허용된 계정이 여럿일 때 고를 아이디" } },
    run: (a, C) => C("login", a.username != null ? { username: a.username } : {}) },
  { name: "browser_native_key", desc: "네이티브 창에 escape 또는 enter를 보낸다. 파일 열기·저장 패널은 버튼이 그룹 안에 중첩돼 이름으로 못 짚는 경우가 많은데 이 둘은 항상 통한다 — 뜬 창을 닫는 가장 확실한 길.",
    schema: { key: { type: "string", enum: ["escape", "enter"] } },
    run: (a, C) => C("nativekey", { key: a["key"] || "escape" }) },
  { name: "browser_new_tab", desc: "이 세션이 쓸 탭을 확보한다. 이미 쓰던 탭이 있으면 새로 만들지 않고 그 탭을 쓴다(주소를 주면 거기로 이동) — 탭이 늘수록 사람의 브라우저가 어지러워진다. 정말 새 탭이 필요한 경우는 두 페이지를 동시에 살려둬야 할 때와 다른 계정·프로필로 열어야 할 때뿐이고, 그때만 parallel을 준다. 탭은 백그라운드로 열려 사용자 화면을 가로채지 않고, 정체성에 묶여 있어 앱 재시작 뒤에도 같은 탭이다. "
      + "새로고침에는 쓰지 않는다 — 페이지를 그대로 다시 부르는 것은 browser_history {action:\"reload\"}다. 같은 흐름에서 다음 화면으로 넘어가는 것은 browser_goto이고, 이 도구는 '쓸 탭을 얻는' 자리에만 쓴다. "
      + "사람이 지목해 준 탭에 다른 사이트를 실으려 하면 덮지 않고 어느 길인지 알려 준다.",
    schema: { url: { type: "string", description: "열 주소(http/https). 생략하면 구글." },
      title: { type: "string", description: "탭에 붙일 이름 — 사용자가 어느 에이전트의 탭인지 알아보게." },
      parallel: { type: "boolean", description: "true면 쓰던 탭을 두고 하나 더 만든다. 두 화면이 동시에 살아 있어야 할 때만 — 예: 같은 사이트의 프론트와 어드민을 함께 보며 비교." },
      profile: { type: "string", description: "로그인 칸(프로필) 이름. 같은 사이트에 다른 계정으로 로그인해야 할 때 필수 — 칸을 안 가르면 쿠키가 하나라 한쪽이 로그아웃된다. 쓸 수 있는 이름은 browser_tabs의 profiles에 있다. 없는 계정용 칸은 사람이 앱에서 만들어 로그인해야 한다." } },
    run: (a, C) => C("newtab", { url: a.url, title: a.title, parallel: a.parallel, profile: a.profile }) },
  { name: "browser_close_tab", desc: "이 세션이 연 탭을 닫는다. 작업이 끝나면 사용자가 볼 최종 산출물 탭만 남기고 중간에 쓴 탭은 닫는다. 사용자가 지목해 준 탭과 다른 세션의 탭은 닫지 않는다. 닫은 탭은 사용자가 ⌘⇧T로 되살릴 수 있다.",
    schema: { tab: { type: ["string", "array"], items: { type: "string" }, maxItems: 4, description: "닫을 탭 핸들(browser_tabs의 handle). 여러 개면 배열(최대 4)." } },
    req: ["tab"],
    run: (a, C) => C("closetab", { tab: Array.isArray(a.tab) ? a.tab.join(",") : String(a.tab) }) },
  { name: "browser_ask_user", desc: "사람에게 물을 내용(선택, 결제·본인확인·캡차처럼 사람이 직접 할 일)을 정리해 돌려준다. 알림은 보내지 않는다. 결과의 note대로 지금 이 세션 대화에서 사용자에게 직접 묻고, 답을 받은 뒤 이어 간다.",
    schema: { message: { type: "string", maxLength: 300, description: "무엇을 해달라는지 한 줄. 예: 결제 수단을 선택하고 결제해 주세요." },
      choices: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4, description: "사람이 고를 답(2~4개). 첫 번째가 진행 답이다." } },
    req: ["message"],
    run: (a, C) => C("ask", { message: a.message, choices: Array.isArray(a.choices) ? a.choices : undefined }) },
  { name: "approve",
    desc: "되돌리기 어려운 작업의 승인 요청을 정리해 돌려준다. 알림은 보내지 않고 approved는 항상 false다. 결과의 note대로 지금 이 세션 대화에서 사용자에게 승인을 묻고, 승인받은 뒤에만 진행한다.",
    schema: {
      title: { type: "string", maxLength: 60, description: "승인 요청 제목(최대 60자)" },
      summary: { type: "string", maxLength: 300, description: "무엇을 어디에 할지 한 줄" },
      approve_label: { type: "string", description: "승인 답 글자" },
      deny_label: { type: "string", description: "거절 답 글자" },
    }, req: ["title", "summary"],
    run: (a, C) => C("approve", { title: a.title, summary: a.summary, approve_label: a.approve_label, deny_label: a.deny_label }) },
  { name: "browser_picks", desc: "사용자가 화면에서 직접 고른 요소들(최근 10개). 고르는 순간 그 탭은 이 세션이 만질 수 있게 열리지만(권한) 대상 탭이 바뀌지는 않는다 — 그 탭을 직접 다뤄야 할 때만 tab에 그 핸들을 넣어라. 터미널에 붙은 글은 사람이 읽는 형식이고, 이 도구는 선택자·대체 선택자·속성·소스 파일 같은 원본 필드를 준다.",
    schema: {}, run: (a, C) => C("picks") },
  // ── 모바일 앱(iOS·Android) ──
  ...appSurface.tools,
  { name: "browser_tabs", desc: "열린 브라우저 탭 목록(핸들·URL·제목)과 이 세션이 고정한 탭, 그리고 쓸 수 있는 로그인 칸(profiles).", schema: {}, run: (a, C) => C("tabs") },
  { name: "browser_target", desc: "이 세션이 조종할 탭을 고정한다. 여러 번 부르면 최대 4개까지 들고 있고, 지정 없는 명령은 그중 마지막으로 쓴 탭으로 간다(전부에 돌리려면 각 도구의 tab에 목록을 준다). tab 없이 부르면 지금 들고 있는 것을 조회하고, clear로 놓는다 — clear와 tab을 함께 주면 그 하나만 놓는다.",
    schema: { tab: { type: "string", description: "browser_tabs가 준 안정 핸들(예: claude-tab-a3f9k2). 여러 개를 들려면 하나씩 여러 번 부른다." }, clear: { type: "boolean" } },
    run: (a, C) => (a.clear ? C("untarget", a.tab != null ? { tab: String(a.tab) } : {})
                            : C("target", a.tab != null ? { tab: String(a.tab) } : {})) },
];

// 어느 탭에서 실행할지는 모든 조작 도구가 공통으로 받는다. 지목받은 탭이 여러 개일 때
// 고정을 계속 바꾸지 않고 한 세션이 여러 탭을 오가며 작업할 수 있어야 한다.
// 목록을 주면 그 탭들에 동시에 돈다(최대 4). 그룹으로 탭을 묶어두는 이유가 여럿을 함께 다루기
// 위해서라, 한 번에 하나만 받으면 그 묶음을 쓸 수 없다.
const TAB_PARAM = { tab: {
  type: ["string", "array"], items: { type: "string" }, maxItems: 4,
  description: "이 호출만 지정한 탭에서 실행. browser_tabs가 준 핸들(예: claude-tab-a3f9k2)을 쓴다 — 핸들은 앱을 재시작해도 같은 탭을 가리킨다. 여러 개를 주면(배열 또는 쉼표, 최대 4) 그 탭들에 같은 명령을 동시에 돌리고 결과를 대상별로 돌려준다. 생략하면 고정된 탭, 고정이 없으면 이 세션 그룹의 탭.",
} };
const NO_TAB = new Set(["browser_tabs", "browser_target", "browser_new_tab", "browser_close_tab", "browser_trace", "browser_picks", "app_picks"]);
// 행동 바로 뒤에 좁힌 snapshot 이나 읽기 eval 을 따로 부르는 일이 행동의 40%였다(30일 기록).
// 결과는 짧고 비용은 왕복 자체라서, 볼 것이 정해져 있으면 같은 호출에 붙인다.
const THEN_TOOLS = new Set(["browser_wait", "browser_click", "browser_dblclick", "browser_hover", "browser_fill", "browser_focus",
  "browser_clear", "browser_check", "browser_select", "browser_type", "browser_key", "browser_goto",
  "browser_history", "browser_scroll"]);
const THEN_BUDGET = 4000;
const THEN_PARAM = { then: {
  type: "object",
  description: "행동 뒤에 볼 것이 이미 정해져 있으면 여기 적어 같은 호출로 받는다. 따로 browser_snapshot·browser_eval 을 부르면 왕복이 하나 는다. "
    + "snapshot 은 role·name·region 중 하나 이상으로 좁힌다(budget 기본 4000). eval 은 browser_eval 과 같은 읽기 전용 식. "
    + "after_ms 는 관측 전 기다릴 시간(최대 5000). 행동이 실패하면 관측하지 않는다. 공식 QA 판정은 iris-qa에서 한다.",
  properties: {
    snapshot: { type: "object", properties: { role: { type: "string" }, name: { type: "string" },
      region: { type: "string" }, budget: { type: "number" } } },
    eval: { type: "string" },
    after_ms: { type: "number" },
  },
} };
// 행동을 보내기 전에 거절한다. 행동만 되고 관측이 거절되면 모델은 같은 행동을 다시 보낸다.
function thenFault(v) {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "then 은 {snapshot, eval, after_ms} 객체입니다.";
  const extra = Object.keys(v).filter((k) => !["snapshot", "eval", "after_ms"].includes(k));
  if (extra.length) return `then 이 받지 않는 이름입니다: ${extra.join(", ")} — 받는 이름: snapshot · eval · after_ms`;
  if (v.snapshot == null && v.eval == null) return "then 에 snapshot 이나 eval 중 하나는 있어야 합니다.";
  if (v.snapshot != null) {
    const s = v.snapshot;
    if (typeof s !== "object" || Array.isArray(s)) return "then.snapshot 은 {role, name, region, budget} 객체입니다.";
    const bad = Object.keys(s).filter((k) => !["role", "name", "region", "budget"].includes(k));
    if (bad.length) return `then.snapshot 이 받지 않는 이름입니다: ${bad.join(", ")}`;
    if (!s.role && !s.name && !s.region) return "then.snapshot 은 role·name·region 중 하나 이상으로 좁혀야 합니다. 전체가 필요하면 browser_snapshot 을 따로 부릅니다.";
  }
  if (v.eval != null && (typeof v.eval !== "string" || !v.eval.trim())) return "then.eval 은 비어 있지 않은 문자열입니다.";
  if (v.after_ms != null && !(Number(v.after_ms) >= 0 && Number(v.after_ms) <= 5000)) return "then.after_ms 는 0~5000 입니다.";
  return null;
}
// 행동 직후 좁힌 관측을 따로 부르면 then 을 한 번만 알려 준다. 매번 붙이면 토큰만 늘고 읽히지 않는다.
let lastWasBareAction = false, thenHinted = false;
function thenHint(name, a) {
  const follow = lastWasBareAction && (name === "browser_eval" || (name === "browser_snapshot" && (a.role || a.name || a.region)));
  lastWasBareAction = THEN_TOOLS.has(name) && a.then == null;
  if (!follow || thenHinted) return "";
  thenHinted = true;
  return "\n\n(방금 행동 뒤 이 관측을 따로 불렀다. 다음부터 볼 것이 정해져 있으면 행동 도구의 then 에 적어 같은 호출로 받는다.)";
}
// 대상을 못 찾으면 지금 화면에서 그 대상일 만한 요소를 같은 결과에 붙인다. 못 찾은 뒤 다음 호출이
// snapshot·eval 인 경우가 대부분이었다(30일 기록). 붙이기만 하고 누르지는 않는다.
const TARGET_TOOLS = new Set(["browser_click", "browser_dblclick", "browser_hover", "browser_fill", "browser_focus",
  "browser_clear", "browser_check", "browser_select"]);
const TARGET_MISS = /선택자에 맞는 요소가 없습니다|ref가 만료|ref 맵 없음|알 수 없는 ref/;
const MISS_KINDS = [["선택자에 맞는 요소가 없습니다", "selector"], ["ref가 만료", "stale_ref"],
  ["ref 맵 없음", "no_snapshot"], ["알 수 없는 ref", "unknown_ref"]];
// 후보 붙이기 판단의 판본. 기록에서 이전 판본 프로세스의 행과 구분하는 값
const MISS_VERSION = 2;
const REF_LINE = /\[@(e\d+)\]\s+(.+?)\s+"((?:[^"\\]|\\.)*)"/;
const refBook = new Map();   // 탭 지정값 → (ref → {role, name}). 마지막 snapshot 기준이다.
function noteRefs(tabKey, r) {
  const text = r && r.ok && r.data && r.data.snapshot;
  if (typeof text !== "string") return;
  const book = new Map();
  for (const line of text.split("\n")) {
    const m = REF_LINE.exec(line);
    if (m) book.set(m[1], { role: m[2], name: m[3] });
  }
  if (book.size) refBook.set(tabKey, book);
}
function missText(r) {
  if (!r || r.multi) return "";
  return String((!r.ok ? r.error : r.data && r.data.ok === false ? r.data.error : "") || "");
}
// 선택자에서 접근성 이름이 되는 문구만 추출. href·type·data-testid 같은 속성값으로 좁히면 후보가 비는 문제
const NAME_IN_SELECTOR = [
  /:(?:has-text|text-is|text)\(\s*(["'])(.{2,40}?)\1\s*\)/,
  /(?:^|[\s>])text=(["']?)([^"'\]]{2,40}?)\1\s*$/,
  /\[\s*(?:aria-label|title|alt|placeholder)\s*[*^$~|]?=\s*(["'])(.{2,40}?)\1/i,
  /\brole=[\w-]+\s*\[\s*name\s*[*^$~|]?=\s*(["'])(.{2,40}?)\1/,
];
function selectorName(selector) {
  const s = String(selector || "");
  for (const re of NAME_IN_SELECTOR) { const m = re.exec(s); if (m) return m[2].trim(); }
  return "";
}
function missKind(text) {
  const hit = MISS_KINDS.find(([s]) => text.includes(s));
  return hit ? hit[1] : "other";
}
async function attachCandidates(a, r, C) {
  const miss = missText(r);
  if (!TARGET_MISS.test(miss)) return null;
  const known = a.ref ? (refBook.get(String(a.tab ?? "")) || new Map()).get(String(a.ref).replace(/^@/, "")) : null;
  const name = known ? known.name : a.ref ? "" : selectorName(a.selector);
  let sr = name ? await C("snapshot", { name: name.slice(0, 40), budget: 2500 }) : null;
  let how = name ? `좁힌 이름: "${name.slice(0, 40)}"` : "";
  // refCount 는 이름 필터 전 화면 전체 수. 좁힌 결과가 비었는지는 반환된 ref 로 판단
  if (!sr || !sr.ok || !/\[@e\d+\]/.test(String((sr.data && sr.data.snapshot) || ""))) {
    sr = await C("snapshot", { budget: 2500 });
    how = name ? `좁힌 이름 "${name.slice(0, 40)}"에 맞는 요소가 없어 화면 앞부분` : "화면 앞부분";
  }
  noteRefs(String(a.tab ?? ""), sr);
  const text = render("browser_snapshot", sr).text;
  return { text: `\n\n── 대상을 못 찾아 지금 화면의 후보를 붙인다(${how}, 누르지 않았다) ──\n` + text,
    refs: [...text.matchAll(/\[@(e\d+)\]/g)].map((m) => m[1]).slice(0, 40), narrowed: !how.includes("앞부분"),
    kind: missKind(miss) };
}
// 조건 대기. 모델이 wait(ms)와 관측을 번갈아 부르던 순환(30일 204회, 1,462호출)을 한 호출로 줄인다.
// 판정은 읽기 전용 eval 한 번으로 하므로 서버의 eval 쓰기 차단을 그대로 거친다.
const UNTIL_KEYS = ["selector", "gone", "text", "stable_ms"];
async function waitUntil(u, timeoutMs, C) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return { ok: false, error: "until 은 {selector, gone, text, stable_ms} 객체입니다." };
  const extra = Object.keys(u).filter((k) => !UNTIL_KEYS.includes(k));
  if (extra.length) return { ok: false, error: `until 이 받지 않는 이름입니다: ${extra.join(", ")} — 받는 이름: ${UNTIL_KEYS.join(" · ")}` };
  if (!UNTIL_KEYS.some((k) => u[k] != null && u[k] !== "")) return { ok: false, error: "until 에 조건이 하나는 있어야 합니다." };
  const stable = Number(u.stable_ms) || 0;
  const limit = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
  const probe = `(() => { const q = (s) => { try { return document.querySelector(s); } catch (e) { return undefined; } };
    const t = document.body ? document.body.innerText : ""; let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    const sel = ${JSON.stringify(u.selector || null)}, gone = ${JSON.stringify(u.gone || null)}, txt = ${JSON.stringify(u.text || null)};
    return { has: sel ? (q(sel) === undefined ? "bad" : !!q(sel)) : null, gone: gone ? (q(gone) === undefined ? "bad" : !q(gone)) : null,
      text: txt ? t.includes(txt) : null, h: h, len: t.length }; })()`;
  const start = Date.now();
  let last = null, lastHash = null, sameSince = start, polls = 0;
  for (;;) {
    const r = await C("eval", { expression: probe });
    polls++;
    if (!r || r.multi) return { ok: false, error: "until 은 탭 하나에서만 기다린다." };
    if (!r.ok) return r;
    const v = r.data && r.data.value;
    if (!v || typeof v !== "object") return { ok: false, error: "페이지 상태를 읽지 못했습니다: " + JSON.stringify(r.data) };
    if (v.has === "bad" || v.gone === "bad") return { ok: false, error: "선택자를 읽을 수 없습니다: " + (v.has === "bad" ? u.selector : u.gone) };
    const now = Date.now();
    if (v.h !== lastHash) { lastHash = v.h; sameSince = now; }
    last = { selector: v.has, gone: v.gone, text: v.text, stable_for_ms: now - sameSince, text_length: v.len };
    const met = (v.has !== false) && (v.gone !== false) && (v.text !== false) && (!stable || now - sameSince >= stable);
    if (met) return { ok: true, data: { met: true, waited_ms: now - start, polls, state: last } };
    if (now - start >= limit) return { ok: true, data: { met: false, note: "시간 초과 — 조건이 맞지 않은 채 돌아왔다", waited_ms: now - start, polls, state: last } };
    await new Promise((res) => setTimeout(res, 700));
  }
}
// then·후보 첨부·until 이 실제로 쓰이는지와 남는 실패를 재는 기록. 두 주 뒤 판정 모델을 붙일지 이 기록으로
// 정한다(못 찾은 뒤 후보 안에 최종 대상이 있었는가, until 대신 고정 대기를 쓴 순환이 얼마나 남는가).
// 페이지 내용은 적지 않는다. 대상은 ref·선택자, 후보는 ref 만 남긴다.
const USE_LOG = path.join(IRIS_HOME, "mcp-use.jsonl");
const USE_LOG_MAX = 4 * 1024 * 1024;
function recordUse(t, a, r, extra) {
  if (!t.name.startsWith("browser_")) return;
  try {
    const d = (r && r.data) || {};
    const row = { ts: Date.now(), session: discoveredSession || null, tool: t.name,
      tab: a.tab == null ? null : String(a.tab), ok: !!(r && (r.multi ? r.okCount > 0 : r.ok && !(d.ok === false))),
      ...(a.ref ? { ref: String(a.ref) } : {}), ...(a.selector ? { selector: String(a.selector).slice(0, 200) } : {}),
      ...(a.then != null ? { then: Object.keys(a.then).sort() } : {}),
      ...(t.name === "browser_wait" ? { ms: a.ms ?? null, until: a.until ? Object.keys(a.until).sort() : null,
        met: d.met ?? null, waited_ms: d.waited_ms ?? null } : {}),
      ...extra };
    fs.mkdirSync(IRIS_HOME, { recursive: true });
    try { if (fs.statSync(USE_LOG).size > USE_LOG_MAX) fs.renameSync(USE_LOG, USE_LOG + ".1"); } catch {}
    fs.appendFileSync(USE_LOG, JSON.stringify(row) + "\n");
  } catch { /* 기록 실패가 도구 결과를 바꾸지 않는다 */ }
}
async function runThen(v, r, C, label = "행동") {
  // 전달은 됐어도 페이지에서 실패하면 결과 안쪽의 ok 가 false 다(예: 크기가 0인 요소).
  const failed = (x) => !x || !x.ok || (x.data && x.data.ok === false);
  const done = r.multi ? (r.targets || []).some((x) => !failed(x)) : !failed(r);
  if (!done) return "\n\n── 행동 뒤 관측: 행동이 실패해 관측하지 않았다 ──";
  const wait = Number(v.after_ms) || 0;
  if (wait) await C("wait", { ms: wait });
  const parts = [];
  if (v.snapshot) {
    const s = v.snapshot;
    const sr = await C("snapshot", { role: s.role, name: s.name, region: s.region,
      budget: s.budget != null ? Number(s.budget) : THEN_BUDGET });
    noteRefs(String(C.tabKey ?? ""), sr);
    parts.push(render("browser_snapshot", sr).text);
  }
  if (v.eval) parts.push("eval: " + render("browser_eval", await C("eval", { expression: String(v.eval) })).text);
  return `\n\n── ${label} 뒤 관측${wait ? ` (${wait}ms 뒤)` : ""} ──\n` + parts.join("\n\n");
}
// 앱 도구는 탭 대신 기기를 고른다. 기기를 여럿 켜 두고 동시성을 재현하는 일이 흔해서
// 탭과 같은 규칙으로 목록도 받는다. 하나면 그것만, 여럿이면 동시에 실행한다.
const DEVICE_PARAM = { device: {
  type: ["string", "array"], items: { type: "string" }, maxItems: 4,
  description: "이 호출만 지정한 기기에서 실행. app_targets가 준 udid·Android 시리얼(앞자리만 적어도 됨) 또는 기기 이름. 여러 개를 주면(배열 또는 쉼표, 최대 4) 그 기기들에 같은 명령을 동시에 돌리고 결과를 기기별로 돌려준다. 생략하면 켜져 있는 첫 기기.",
} };
const NO_DEVICE = new Set(["app_targets", "app_target", "app_picks"]);   // 목록·고정 자체는 대상을 받지 않는다
// 도구가 실제로 받는 인자표. 목록에 내는 것과 호출을 검사하는 것이 같은 표여야 한다.
// 둘로 나뉘면 "목록엔 있는데 검사는 모르는" 인자가 생긴다.
function schemaOf(t) {
  const s = t.app
    ? (NO_DEVICE.has(t.name) ? t.schema : { ...t.schema, ...DEVICE_PARAM })
    : (NO_TAB.has(t.name) ? t.schema : { ...t.schema, ...TAB_PARAM });
  return THEN_TOOLS.has(t.name) ? { ...s, ...THEN_PARAM } : s;
}
const toolList = TOOLS.map((t) => ({
  name: t.name, description: t.desc,
  inputSchema: { type: "object", properties: schemaOf(t), ...(t.req ? { required: t.req } : {}) },
}));

// 스키마 밖 인자와 값을 조용히 버리지 않는다.
//
// mode에 "count"를 주면 도구가 거절하지 않고 기본 모드로 바꿔 "null 포함" 판정을 내고,
// 기대 문자열을 value로 주면 text가 빈 채로 판정이 나간다(확인 결과: 한 회차에서
// 영수증 셋이 그렇게 만들어졌다). 물은 적 없는 질문의 답이 통과로 남으면 QA 판정은
// 화면과 무관해지고, 그 통과는 보고서에서 실제 통과와 구별되지 않는다.
//
// 거절은 다음에 할 일을 함께 준다. 이름이 비슷하면 짚어 주고, 아니면 받는 이름을 다 편다.
function argFault(t, a) {
  const s = schemaOf(t), names = Object.keys(s);
  for (const k of Object.keys(a)) {
    if (k.startsWith("_")) continue;            // 호출자가 붙이는 메타는 도구 인자가 아니다
    if (k in s) continue;
    const lk = k.toLowerCase();
    const near = names.filter((n) => {
      const ln = n.toLowerCase();
      return ln.includes(lk) || lk.includes(ln);
    });
    return `${t.name}이 받지 않는 인자입니다: ${k}\n`
      + (near.length ? `혹시 ${near.join(" · ")}입니까?\n` : "")
      + `받는 이름: ${names.join(" · ")}`;
  }
  for (const [k, v] of Object.entries(a)) {
    const e = s[k] && s[k].enum;
    if (e && v != null && !e.includes(v)) {
      return `${t.name}의 ${k}는 ${e.join(" · ")} 중 하나입니다(받은 값: ${JSON.stringify(v)}).`;
    }
  }
  return null;
}
const byName = new Map(TOOLS.map((t) => [t.name, t]));
// 기기 목록 파싱과 동시 실행. 브라우저 쪽은 서버(runBrowserCmd)가 나눠 실행하지만 앱 도구는
// 서버를 거치지 않고 여기서 idb를 부르므로, 같은 규칙을 이 층에 둔다.
function deviceList(device) {
  const arr = (Array.isArray(device) ? device : String(device).split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(arr)];   // 같은 기기를 두 번 적어도 두 번 돌리지 않는다
}
async function runOnDevices(t, a, devs, C) {
  if (!devs.length) return { ok: false, error: "대상 기기가 비어 있습니다." };
  if (devs.length > MAX_DEVICES) return { ok: false, error: `한 번에 최대 ${MAX_DEVICES}대까지 조작합니다(요청 ${devs.length}대).` };
  const rs = await Promise.all(devs.map((d) =>
    Promise.resolve().then(() => t.run({ ...a, device: d }, C))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))));
  const per = devs.map((d, i) => ({ device: d, ...(rs[i] || { ok: false, error: "결과 없음" }) }));
  const okCount = per.filter((r) => r.ok).length;
  return {
    ok: okCount === per.length,   // 절반만 된 것을 성공이라 부르지 않는다
    multi: true, count: per.length, okCount,
    error: okCount === per.length ? undefined
      : per.filter((r) => !r.ok).map((r) => `${r.device}: ${r.error || "실패"}`).join(" / "),
    targets: per,
  };
}

// 결과를 사람과 모델이 같이 읽는 텍스트로. 스냅샷·텍스트처럼 큰 것은 본문만, 나머지는 JSON.
function render(name, r) {
  // 여러 탭에 동시에 실행한 결과. 대상마다 따로 접어 보여준다. 하나로 합치면 어느 화면에서 무엇이
  // 나왔는지 사라지는데, 그것을 알려고 여럿에 실행한 것이다. 실패한 대상도 함께 보고한다.
  if (r.multi && Array.isArray(r.targets)) {
    const parts = r.targets.map((t) => {
      const one = render(name, t);
      return `── ${t.tab || t.device} ${t.ok ? "" : "(실패) "}──\n${one.text}`;
    });
    return { text: `대상 ${r.count}개 중 ${r.okCount}개 성공\n\n${parts.join("\n\n")}`, isError: r.okCount === 0 };
  }
  if (!r.ok) return { text: "오류: " + (r.error || "알 수 없음"), isError: true };
  const d = r.data || {};
  // 로그인 칸이 보이면 그 힌트를 본문 맨 앞에 둔다. 아래로 밀면 긴 스냅샷에 묻힌다.
  const lh = (d.humanHint ? d.humanHint + "\n\n" : "") + (d.loginHint ? d.loginHint + "\n\n" : "");
  if (name === "browser_snapshot") {
    const scope = d.query ? " · 좁힘 " + Object.entries(d.query).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const cut = d.truncated ? ` · ${d.shown}/${d.lines}줄만` : "";
    return { text: `${lh}URL: ${d.url || ""} · ${d.refCount || 0} refs${scope}${cut}\n\n${d.snapshot || "(빈 스냅샷)"}` };
  }
  if (name === "browser_text") return { text: d.text || "" };
  if (name === "app_snapshot") return { text: `앱 ${d.app || ""} · 요소 ${d.count}개 · 화면 ${d.screen ? d.screen.width + "x" + d.screen.height : "?"}\n\n${d.snapshot || "(빈 화면)"}` };
  if (name === "app_observe") return { text: `앱 ${d.app || ""} · 요소 ${d.elements}개${d.alerts && d.alerts.length ? " · 떠 있는 것: " + d.alerts.join(", ") : ""}\n장면: ${d.shot || "(못 찍음)"}\n\n${d.snapshot || ""}` };
  if (name === "browser_close_tab" && d.closed) return { text: `탭 @${d.closed} 닫음\n남은 탭: ${(d.remaining || []).map((h) => "@" + h).join(" ") || "(없음)"}` };
  if (name === "browser_new_tab") return { text: `탭 @${d.handle} 생성·고정 (스페이스 ${d.space})\n${d.url || ""}\n\n${d.note || ""}`.trim() };
  if (name === "browser_eval") return { text: typeof d.value === "string" ? d.value : JSON.stringify(d.value) };
  if (name === "browser_screenshot") {
    const miss = (d.missing || []).length ? `\n표시 못 찾음: ${(d.missing || []).join(", ")}` : "";
    return { text: `${d.path}\n${d.title || ""} · ${d.url || ""}${d.marked ? `\n표시 ${d.marked}곳` : ""}${d.caption ? `\n설명: ${d.caption}` : ""}${miss}` };
  }
  return { text: JSON.stringify(d, null, 2) };
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// stdin이 닫혀도 진행 중인 호출은 끝내고 응답한 뒤 종료한다. 바로 exit하면 마지막 도구 호출이
// 응답 없이 잘린다(클라이언트는 영영 기다리거나 타임아웃으로 실패한다).
let inFlight = 0, closing = false;
// stdout이 파이프면 쓰기가 비동기다. 그냥 exit하면 아직 나가지 않은 응답(도구 목록처럼 큰 것)이
// 통째로 버려진다. 빈 write의 콜백은 앞선 쓰기가 다 빠진 뒤에 불린다.
const maybeExit = () => { if (closing && inFlight === 0) process.stdout.write("", () => process.exit(0)); };

// 보고서 렌더러는 브라우저 없이도 검사할 수 있어야 한다. 그러지 못하면 "고쳤다"가 글로만
// 남는다. 직접 실행일 때만 stdio 루프를 연다. import하면 함수만 가져다 쓸 수 있다.
// 판정 함수는 내보낸다. 소스 모양으로만 검사하면 `false &&` 한 줄로 우회된다
// (변이 검사에서 확인했다).
export { chooseHerdrPane };
const RUN_AS_MAIN = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
const rl = RUN_AS_MAIN ? readline.createInterface({ input: process.stdin }) : { on() {} };
rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let m;
  try { m = JSON.parse(s); } catch { return; }
  const { id, method, params } = m;
  try {
    if (method === "initialize") {
      // 클라이언트가 부른 버전을 그대로 되돌려 준다. 버전 협상이 어긋나는 것을 막는다.
      const v = (params && params.protocolVersion) || "2025-06-18";
      return ok(id, { protocolVersion: v, capabilities: { tools: {} },
        serverInfo: { name: "iris-mcp", version: "1.0.0" },
        // 항상 붙는 글이라 짧게. 도구 설명에 이미 있는 것은 넣지 않고, 도구 목록만 봐서는 모르는
        // 사실 하나만 남긴다. 로그인 벽에서 사람에게 그냥 넘기는 일을 막기 위한 것이다.
        instructions: "사람이 쓰는 브라우저를 그대로 조종한다(로그인·쿠키 살아 있음). "
          + "로그인 벽에서 사람에게 넘기기 전에 browser_login을 먼저 불러라 — 사용자가 허용한 계정은 네가 채울 수 있다. "
          + "결제·본인확인처럼 사람이 해야만 하는 자리와 승인이 필요한 자리에서는 이 세션 대화에서 사용자에게 직접 묻는다. 이 도구들은 브라우저·폰 알림을 보내지 않는다. "
          + "페이지 확인 창(alert·confirm)이 뜨면 명령 결과에 그 내용이 오니 browser_dialog로 답한다. "
          + "작업이 끝나면 사용자가 볼 최종 산출물 탭만 남기고, 중간에 쓴 탭은 browser_close_tab으로 닫아라. "
          + "이 도구는 일반 사용을 위한 브라우저와 앱 조작 도구입니다. 공식 QA 회차·판정·보고서는 iris-qa로 진행합니다. "
          + "모바일 앱은 Iris 에뮬레이터 탭의 기기에서만 확인한다 — simctl·emulator·open -a Simulator로 기기를 따로 켜지 마라. iOS 기기에 idb ui tap·text·swipe·key·button을 직접 부르지 마라 — Xcode 27에서는 그 뒤로 사람의 Iris 탭 터치가 앱에 닿지 않는다. 입력은 app_* 도구로 한다. "
          + "사용자는 Iris 탭만 본다. app_* 도구가 이 세션에 할당된 기기가 없으면 다른 세션이 쓰지 않는 기기로 이 세션의 탭을 열고, 다른 기기가 필요하면 app_target이 그 탭을 바꾼다." });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return; // 알림은 응답 없음
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: toolList });
    if (method === "tools/call") {
      const t = byName.get(params && params.name);
      if (!t) return err(id, -32602, "알 수 없는 도구: " + (params && params.name));
      inFlight++;
      try {
        const a = (params && params.arguments) || {};
        const fault = argFault(t, a);
        if (fault) { ok(id, { content: [{ type: "text", text: "오류: " + fault }], isError: true }); return; }
        const thenBad = THEN_TOOLS.has(t.name) ? thenFault(a.then) : null;
        if (thenBad) { ok(id, { content: [{ type: "text", text: "오류: " + thenBad }], isError: true }); return; }
        // 도구마다 인자를 직접 조립하므로, tab은 요청 단위로 감싼 호출기가 얹는다.
        // 전역 상태로 두면 동시 호출이 서로의 대상을 덮어쓴다.
        const C = (cmd, args = {}) =>
          // 핸들은 문자열이다(claude-tab-a3f9k2). Number()로 바꾸면 NaN→null이 되어
          // 서버가 "탭 미지정"으로 읽고 고정 탭으로 간다. 목록은 쉼표로 이어 보낸다.
          // 갈라 태우는 것은 서버의 runBrowserCmd 한 곳에서만 한다.
          call(cmd, a.tab != null && !NO_TAB.has(t.name)
            ? { ...args, tab: Array.isArray(a.tab) ? a.tab.join(",") : String(a.tab) } : args);
        C.tabKey = String(a.tab ?? "");   // then 의 snapshot 이 ref 장부를 이 탭 기준으로 갱신한다
        // 앱 도구는 서버를 거치지 않고 여기서 idb를 부른다. 그래서 여러 기기에 도는 것도 여기서
        // 나눠 실행한다. 기기마다 같은 run을 한 번씩 실행하고 결과를 기기별로 묶는다.
        // 증거 도구면 여기서 회차가 열린다. 도구가 돌기 전이라 첫 장면부터 회차 폴더로 굳는다.
        const devs = t.app && !NO_DEVICE.has(t.name) && a.device != null ? deviceList(a.device) : null;
        const r = devs && devs.length !== 1
          ? await runOnDevices(t, a, devs, C)
          : await t.run(devs ? { ...a, device: devs[0] } : a, C);
        const out = render(t.name, r);
        const moment = await absorbMoments(r);      // 사라진 알림은 여기서 말해 주지 않으면 묻힌다
        if (t.name === "browser_snapshot") noteRefs(String(a.tab ?? ""), r);
        const seen = a.then != null && THEN_TOOLS.has(t.name) ? await runThen(a.then, r, C, t.name === "browser_wait" ? "대기" : "행동") : "";
        const near = TARGET_TOOLS.has(t.name) ? await attachCandidates(a, r, C) : null;
        const hint = thenHint(t.name, a);
        recordUse(t, a, r, { ...(near ? { miss: true, missKind: near.kind, candidates: near.refs, narrowed: near.narrowed,
          missVersion: MISS_VERSION } : {}),
          ...(hint ? { hinted: true } : {}) });
        ok(id, { content: [{ type: "text", text: out.text + moment + seen + (near ? near.text : "") + hint }], ...(out.isError ? { isError: true } : {}) });
      } finally { inFlight--; maybeExit(); }
      return;
    }
    if (id !== undefined) err(id, -32601, "지원하지 않는 메서드: " + method);
  } catch (e) {
    log("처리 실패", method, String(e && e.message || e));
    if (id !== undefined) err(id, -32603, String(e && e.message || e));
  }
});
rl.on("close", () => { closing = true; maybeExit(); setTimeout(() => process.exit(0), 15000).unref(); });
