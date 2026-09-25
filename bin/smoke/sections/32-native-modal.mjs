// 소유 범위: [2p] 네이티브 모달·CDP 결과 안전·로그인 판단·브라우저 요소 선택 검사.
// 제공 API: 원래 [2p] 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스, Node 파일·경로·OS API.
// 유지 조건: 검사 이름·순서·문구, checkAsync의 비동기 판정, 임시 폴더 정리, full smoke 출력.
// 영향 범위: 러너가 동적 import로 이 run을 호출하며, 다음 앱 선택 섹션과 실행 순서가 이어진다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/32-native-modal.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_ } from "../core.mjs";
import {
  aiLoginPolicySource, aiState, allServer, allWebJs, autofillAllowlist, browserCommands,
  browserMessages, browserDialogs, browserRuntime, browserTabs, cdpCmdInspectSource, cdpCmdNativeSource,
  cdpHintsSource, cdpResultSafetySource, centerTabs, chromeImportRegistrySource, css, dock,
  herdrAgents, httpHandler, keynav, main, mainJs, mainWindowSource, memoAdmin, memoStorePanel,
  pick, pickBoot, pickHost, rail, textEditor, web, webview, webviewFactory, webviewLifecycleSource,
  xtermWiring,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2p] 네이티브 모달 — CDP 밖의 창");
// 확인 창(alert/confirm)은 탭이 아니라 창에 붙는다. 다른 탭의 대화상자가 지금 보고 있는 페이지
// 위에 떠서 창 전체를 막고, 제어로 닫을 수 없어 무한 대기가 된다.
// 그래도 대신 닫지 않는다. 무엇을 묻는지 읽고 네/아니오를 고르는 것이 요구사항이다.
check("확인 창의 내용과 소속 탭이 그대로 전해진다", () => {
  const si = read("server/browser-message-handlers.js");
  return /const visible = m \? tabIsShowing\(m\.space, tabIdOfWc\(wc\)\) : false/.test(si)
    && /broadcast\(\{ type: "browser-dialog", wc, open, visible, space/.test(si)
    && /message: String\(msg\.message \|\| ""\)/.test(si)
    && !/execOnWc\("dialog", \{ answer: "cancel" \}/.test(si)   // 임의로 닫지 않는다
    && /확인 창 떠 있음/.test(allServer);
});
// 시트를 제거하는 것이 아니라 위치를 옮기는 것이다. 질문은 그대로 보이고 답할 수 있어야 한다.
check("확인 창이 탭 안에서 뜨고 네/아니오를 고를 수 있다", () => {
  return /webPreferences\.disableDialogs = true/.test(mainWindowSource) // 창을 막는 네이티브 시트는 끈다
    && /id="wv-dialog"/.test(web)                            // 대신 그 탭 안에 뜬다
    && /function renderTabDialog/.test(webview)
    && /data-ans="ok">네</.test(webview) && /data-ans="cancel">아니오</.test(webview)
    && /browser-dialog-answer/.test(webview) && /browser-dialog-answer/.test(allServer)
    && /이 탭이 답을 기다립니다/.test(browserTabs);              // 어느 탭이 기다리는지 목록에서 보인다
});
check("떠 있는 확인 창을 제어로 닫을 수 있다", () =>
  /async dialog\(send, wc, args\)/.test(cdpCmdNativeSource) && /Page\.handleJavaScriptDialog/.test(cdpCmdNativeSource)
  && /"dialog"/.test(read("bin/iris-browser.mjs")) && /browser_dialog/.test(read("bin/iris-mcp.mjs")));
// 묻던 페이지가 사라지면 질문도 사라진다. 표시를 안 걷으면 그 탭은 영영 "답 기다리는 중"으로 남는다.
// 소스 모양이 아니라 실행해서 확인한다. 대화상자는 순수 상태라 실행할 수 있고, 그래야 계약
// 헤더가 약속한 동작이 지켜지는지 확인된다. 타임아웃 줄을 지워도 모양 검사는 모두 통과했다.
await checkAsync("아무도 답하지 않는 질문은 스스로 놓인다", async () => {
  const { createDialogs } = await import(new URL("../../../server/browser/dialogs.js", import.meta.url).href);
  const sent = [];
  const meta = { space: "s1" };
  let fired = null;
  const d = createDialogs({
    metaOfWc: () => meta, broadcast: (m) => sent.push(m),
    setTimeoutFn: (fn) => { fired = fn; return 7; },
    clearTimeoutFn: (id) => { if (id === 7) fired = null; },
    timeoutMs: 180000,
  });

  let answered = null;
  const id = d.openDialogAsk(11, "confirm", "지울까요", (a, t) => { answered = [a, t]; });
  if (!meta.dialog || meta.dialog.kind !== "confirm") throw new Error("확인 창이 떠 있다고 안 적는다");
  if (!sent.some((m) => m.open === true && m.id === id)) throw new Error("떴다고 알리지 않는다");
  if (!fired) throw new Error("놓아 줄 시각을 걸지 않는다 — 영원히 멈춘다");

  fired();
  if (!answered || answered[0] !== "cancel") throw new Error("스스로 놓이지 않는다");
  if (meta.dialog) throw new Error("놓였는데 기다린다는 표시가 남는다");
  if (!sent.some((m) => m.open === false && m.id === id)) throw new Error("걷혔다고 알리지 않는다");

  // 이미 놓인 질문을 또 놓지 않는다. 걸었던 시각도 함께 걷힌다.
  if (d.closeDialogAsk(id)) throw new Error("없는 질문을 닫았다고 한다");
  const id2 = d.openDialogAsk(12, "prompt", "이름", () => {});
  d.closeDialogAsk(id2);
  if (fired) throw new Error("닫았는데 걸어 둔 시각이 남는다");

  // 사람이 답해도 걸어 둔 시각은 해제된다. 해제하지 않으면 이미 없는 질문을 3분 뒤에 다시 닫고,
  // 그 사이 같은 탭에 새 질문이 있으면 그것이 대신 취소된다.
  let second = null;
  const id3 = d.openDialogAsk(13, "confirm", "보낼까요", (a, t) => { second = [a, t]; });
  const got = d.answerDialogAsk(13, "ok", "네");
  if (!got || got.kind !== "confirm") throw new Error("무엇에 답했는지 안 돌려준다");
  if (!second || second[0] !== "ok" || second[1] !== "네") throw new Error("답이 전달되지 않는다");
  if (fired) throw new Error("사람이 답했는데 걸어 둔 시각이 남는다");
  if (d.answerDialogAsk(13, "ok", "네")) throw new Error("이미 답한 질문에 또 답한다");
  if (d.closeDialogAsk(id3)) throw new Error("이미 닫힌 질문을 또 닫는다");

  // 무장은 명시적으로 켤 때만이고, 풀면 사람 차례로 돌아간다.
  if (d.plannedAnswer(11) !== null) throw new Error("무장하지 않았는데 자동 응답이 있다");
  d.setDialogPlan(11, { mode: "ok", queue: ["cancel"] }, "홍길동");
  if (d.plannedAnswer(11) !== "cancel") throw new Error("줄 세운 답을 앞에서 꺼내지 않는다");
  if (d.plannedAnswer(11) !== "ok") throw new Error("줄이 비면 기본 모드로 안 간다");
  if (d.dialogPlanText(11) !== "홍길동") throw new Error("넣을 글을 잃는다");
  d.setDialogPlan(11, null);
  if (d.plannedAnswer(11) !== null) throw new Error("풀었는데 무장이 남는다");
  return true;
});
check("묻던 페이지가 사라지면 기다린다는 표시도 걷힌다", () => {
  const si = httpHandler;
  const seg = sliceFrom(si, 'req.on("close"', 400, "묻던 페이지가 사라지면 기다린다는 표시도 걷힌다");
  const owner = sliceBetween(browserDialogs, "function closeDialogAsk", "function answerDialogAsk", "묻던 페이지가 사라지면 기다린다는 표시도 걷힌다");
  return /closeDialogAsk\(id\)/.test(seg)
    && /dialogAsks\.delete\(id\)/.test(owner)
    && /setTabDialog\(ask\.wc, false\)/.test(owner)
    && /broadcast\(\{ type: "browser-dialog", wc: ask\.wc, open: false/.test(owner);
});
// 고정이 없으면 명령 대상이 "그 스페이스의 활성 탭"이 되어, 사용자가 탭을 옮길 때마다 지목한 적
// 없는 탭이 조작된다. 그래서 세션은 탭이 아니라 그룹을 소유한다.
check("세션은 그룹을 소유하고 그 밖으로 나가지 않는다", () => {
  const si = browserRuntime;
  return /function sessionGroupId\(session\) \{/.test(si)
    && /return "ai:" \+ String\(session\);/.test(si)       // 지목이 없으면 pane에서 결정론으로
    && /if \(ids\.length\)/.test(si)                       // 대상은 그룹 안에서만 고른다
    && !/return \{ wc: activeWcBySpace\.get\(mine\) \|\| null, pinned: false, space: mine \}/.test(si) // 옛 폴백 제거
    && /needTab: true/.test(si)                            // 그룹이 비면 자기 탭을 만든다
    && /function absorbIntoSessionGroup/.test(si);         // 지정한 탭은 그룹이 감싼다
});
check("남의 그룹 탭은 이 세션이 못 만진다", () => {
  const si = browserRuntime;
  const seg = sliceBetween(si, "function tabAllowed", "// 표시되는 것만 조작할 수 있다", "남의 그룹 탭은 이 세션이 못 만진다");
  // 허용은 "내 그룹이거나 지목받은 그룹"일 때만. 그 밖은 그룹이 없어도(=스페이스에 그냥 떠 있어도) 거절.
  return /const g = controlOwnerOf\(mine, tabId\), mineG = sessionGroupId\(session\)/.test(seg)
    && /if \(g === mineG \|\| groupGranted\(session, mine, g\)\) return \{ ok: true \}/.test(seg)
    && /return \{ ok: false, why: "이 세션이 쓸 수 있는 탭이 아닙니다/.test(seg);
});
check("어느 세션이 어느 탭을 쥐고 있는지 창에 알린다", () => {
  const si = readAll("server");
  return /function aiTargetsSnapshot/.test(si) && /type: "ai-targets"/.test(si)
    && /"ai-targets": dispatchWs\(handleAiTargetsMessage\)/.test(mainJs) && /export function aiBusyLabels/.test(aiState)
    && /class="cai"/.test(centerTabs);
});
// 활성 표시는 ::after 윗선, 그룹 소속 띠는 box-shadow 다. 둘이 같은 속성을 쓰면 나중 규칙이 앞 규칙을
// 덮어 그룹 안 탭에서 활성 표시가 사라지므로, 활성 표시가 box-shadow 를 쓰지 않는지도 본다.
check("그룹 안에서도 활성 탭 표시가 남는다", () =>
  /\.ctab\.active::after \{[^}]*background:var\(--accent\)/.test(css("11-center-tabs"))
  && /\.ctab\.in-group \{ box-shadow:inset 2px 0 0 var\(--focus\)/.test(css("18-browser"))
  && !/\.ctab(\.[\w-]+)*\.active(\.[\w-]+)* \{[^}]*box-shadow/.test(css("11-center-tabs") + css("18-browser")));
// 편의 기능: 볼 파일이 없는 도구까지 300px 패널 형태로 열려 사용이 불편했다.
check("편의 기능은 전체형·패널형 두 모드로 나뉜다", () =>
  // 목록은 계속 늘어나므로 개수를 고정하면 도구를 추가할 때마다 깨진다. 두 모드로 나뉘는지만 본다.
  // 배치는 표가 소유하고 rail.js 는 그것을 읽기만 한다.
  /layout: "full"/.test(read("web/js/core/rail-items.js"))
  && /const RAIL_FULL = new Set\(fullIds\(\)\);/.test(rail)
  && /classList\.toggle\("util-full", RAIL_FULL\.has\(view\)\)/.test(rail)
  && /body\.util-full \.center \{ display:none/.test(css("03-feature-modes"))
  && /body\.util-full \.rail-panel\.is-open \{ width:auto; flex:1 1 auto/.test(css("03-feature-modes")));
check("지금 어느 편의 기능에 있는지 rail에 보인다", () =>
  /class="rl">작업</.test(web) && /class="rl">로그인</.test(web)
  && /\.rail-ico\.active \{[^}]*background:var\(--select\)/.test(css("02-rail"))
  && /\.rail-ico\.active \.rl \{ color:var\(--ai\); font-weight:600/.test(css("02-rail")));
// AI 자동완성 로그인: 허용한 (사이트, 아이디)만 쓰고, 비밀번호는 AI가 볼 수 없다.
check("허용 목록에 오른 계정만 AI가 채운다", () => {
  return /function aiLoginAllowed\(origin, username\)/.test(aiLoginPolicySource)
    && /const allowed = saved\.filter\(\(l\) => aiLoginAllowed\(origin, l\.username\)\)/.test(aiLoginPolicySource)
    && /if \(!allowed\.length\)/.test(aiLoginPolicySource)
    && /wc\.send\("ac-ai-login"/.test(aiLoginPolicySource)
    && /ipcRenderer\.on\("ac-ai-login"/.test(read("native/electron/webview-preload.cjs"));
});
check("ai-login-policy가 main 조립부에 연결된다", () =>
  /const \{ createAiLoginPolicy \} = require\("\.\/ai-login-policy\.cjs"\);/.test(main)
  && /createAiLoginPolicy\(\{/.test(main)
  && /stateDir: IRIS_HOME,/.test(main)
  && /setLoginProvider,\n\s*ctlSend,/.test(main)
  // 자격증명은 프로필 partition 별로 저장된다. 요청 탭의 session 으로 partition 을 찾는 조회가 빠지면
  // 저장된 로그인을 못 찾거나(no-saved) 다른 프로필의 비밀번호를 고른다.
  && /partitionForSession: \(sess\) => profileSessionPolicy\.partitionForSession\(sess\),/.test(main));
await checkAsync("ai-login-policy는 정확한 허용 계정만 채우고 비번 없는 목록과 저장·삭제 왕복을 지킨다", async () => {
  const { createAiLoginPolicy } = require_("../native/electron/ai-login-policy.cjs");
  const fsMod = require_("node:fs");
  const pathMod = require_("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "iris-ai-login-policy-"));
  const origin = "https://login.example.test";
  const accounts = [
    { origin, username: "alice", password: "inventory-must-not-leak-a" },
    { origin, username: "bob", password: "inventory-must-not-leak-b" },
  ];
  const partition = "persist:acprof:p1";
  const credentialService = {
    listAccounts: () => accounts,
    listForOrigin: (part, wantOrigin) => part === partition ? accounts.filter((row) => row.origin === wantOrigin) : [],
    passwordFor: (part, wantOrigin, username) => part === partition && wantOrigin === origin ? `secret-${username}` : undefined,
    partitionCounts: () => [],
  };
  const boot = () => {
    const handles = new Map(), notes = [];
    let provider = null;
    createAiLoginPolicy({
      fs: fsMod, path: pathMod, stateDir: dir,
      ipcMain: { handle: (name, fn) => handles.set(name, fn) },
      isTrustedSender: () => true,
      credentialService,
      cookieImport: { listChromeProfiles: () => [] },
      chromeImportRegistry: { backfill() {}, has: () => false },
      chromeProfileCid: (row) => row.id,
      isProfilePartition: (partition) => /^persist:acprof:/.test(partition),
      setLoginProvider: (fn) => { provider = fn; },
      ctlSend: (message) => notes.push(message),
      partitionForSession: (sess) => (sess && sess.partition) || null,
    });
    return { handles, notes, provider: () => provider };
  };
  try {
    const first = boot();
    const sent = [];
    const wc = { id: 7, session: { partition }, getURL: () => origin + "/form", send: (_channel, payload) => sent.push(payload) };
    const blocked = await first.provider()(wc, { username: "bob" });
    if (blocked && blocked.ok || sent.length) throw new Error("목록에 없는 origin·username을 채웠다");
    const before = first.handles.get("ac-ai-login-list")({});
    if (before.some((row) => Object.prototype.hasOwnProperty.call(row, "password"))) throw new Error("목록 응답에 password가 실렸다");
    const enabled = first.handles.get("ac-ai-login-set")({}, { origin, username: "alice", allowed: true });
    if (!enabled.ok || !enabled.allowed) throw new Error("허용 추가 응답이 맞지 않는다");
    const stored = JSON.parse(readFileSync(path.join(dir, "ai-login.json"), "utf8"));
    if (stored.length !== 1 || stored[0].origin !== origin || stored[0].username !== "alice" || Object.prototype.hasOwnProperty.call(stored[0], "password")) {
      throw new Error("허용 저장 형태가 origin·username 한 쌍이 아니다");
    }
    const second = boot();
    const reloaded = second.handles.get("ac-ai-login-list")({});
    const alice = reloaded.find((row) => row.origin === origin && row.username === "alice");
    if (!alice || alice.allowed !== true || reloaded.some((row) => Object.prototype.hasOwnProperty.call(row, "password"))) {
      throw new Error("디스크에서 허용 목록을 비번 없이 복원하지 못했다");
    }
    const deniedBob = await second.provider()(wc, { username: "bob" });
    if (deniedBob && deniedBob.ok || sent.length) throw new Error("허용되지 않은 같은 origin의 다른 username을 채웠다");
    const filledAlice = await second.provider()(wc, { username: "alice" });
    if (!filledAlice || !filledAlice.ok || sent.length !== 1 || sent[0].username !== "alice" || sent[0].password !== "secret-alice") {
      throw new Error("허용된 정확한 계정을 채우지 못했다");
    }
    const disabled = second.handles.get("ac-ai-login-set")({}, { origin, username: "alice", allowed: false });
    if (!disabled.ok || disabled.allowed) throw new Error("허용 삭제 응답이 맞지 않는다");
    const removed = JSON.parse(readFileSync(path.join(dir, "ai-login.json"), "utf8"));
    if (removed.length !== 0) throw new Error("허용 삭제가 디스크 형태에 반영되지 않았다");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// 로컬 개발 계정까지 사람을 부르면 확인마다 사람이 붙는다. 대신 프로젝트가 심어 둔 계정을 쓰되,
// 그 경로는 로컬에서만 열려야 한다. 원격까지 열리면 프로젝트 파일 한 줄로 외부 사이트에
// 자격증명을 넣을 수 있다. 검사 둘(원점 판정·선언 판정)을 모두 제거한 사본에서 실제로 유출이
// 확인됐으므로, 이 검사는 그 둘이 유지되는지 본다.
await checkAsync("로컬은 프로젝트가 심어 둔 계정으로 넘고 원격에는 그 길이 없다", async () => {
  const { localLoginFor } = require_("../server/local-login.cjs");
  const dir = mkdtempSync(path.join(tmpdir(), "iris-local-login-"));
  const server = http.createServer((_q, res) => res.end("ok"));
  const cwd0 = process.cwd();
  try {
    process.chdir(dir);
    const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
    writeFileSync(path.join(dir, ".iris-local.json"), JSON.stringify({ logins: [
      { origin: `http://127.0.0.1:${port}`, username: "dev@example.test", password: "local-pw-must-not-leak" },
      { origin: `https://remote.example.com:${port}`, username: "remote", password: "remote-pw-must-not-leak" },
    ] }));
    const hit = localLoginFor(`http://127.0.0.1:${port}`);
    if (!hit || hit.username !== "dev@example.test") throw new Error("로컬 원점에서 심어 둔 계정을 못 찾았다");
    if (localLoginFor(`https://remote.example.com:${port}`)) throw new Error("원격 원점에 프로젝트 계정을 내줬다");
    // 저장된 로그인이 없어도 로컬이면 통과한다. 비밀번호는 채우는 경로와 secret 필드에만 있다.
    const sdir = mkdtempSync(path.join(tmpdir(), "iris-local-login-state-"));
    const sent = [];
    let provider = null;
    const { createAiLoginPolicy } = require_("../native/electron/ai-login-policy.cjs");
    createAiLoginPolicy({
      fs: require_("node:fs"), path: require_("node:path"), stateDir: sdir,
      ipcMain: { handle() {} }, isTrustedSender: () => true,
      credentialService: { listAccounts: () => [], listForOrigin: () => [], passwordFor: () => undefined, partitionCounts: () => [] },
      cookieImport: { listChromeProfiles: () => [] }, chromeImportRegistry: { backfill() {}, has: () => false },
      chromeProfileCid: (row) => row.id, isProfilePartition: () => false,
      setLoginProvider: (fn) => { provider = fn; }, ctlSend: () => {}, localLoginFor,
    });
    const wc = { id: 11, getURL: () => `http://127.0.0.1:${port}/login`, send: (_c, payload) => sent.push(payload) };
    const filled = await provider(wc, {});
    if (!filled || !filled.ok || filled.local !== true) throw new Error("로컬인데 저장된 로그인이 없다고 사람을 불렀다");
    if (sent.length !== 1 || sent[0].password !== "local-pw-must-not-leak") throw new Error("비번이 채우는 경로로 가지 않았다");
    if (JSON.stringify({ ...filled, secret: undefined }).includes("local-pw-must-not-leak")) throw new Error("비번이 결과에 실렸다");
    const wc2 = { id: 12, getURL: () => "https://remote.example.com/login", send: () => { throw new Error("원격을 채웠다"); } };
    const asked = await provider(wc2, {});
    if (!asked || asked.ok !== false || asked.needUser !== true) throw new Error("원격에서 사람을 부르지 않았다");
    rmSync(sdir, { recursive: true, force: true });
    return true;
  } finally {
    process.chdir(cwd0);
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
check("채운 비밀번호는 명령 결과에서 가려진다", () => {
  const c = read("native/electron/cdp-control.cjs");
  return /const filledSecrets = new Map\(\)/.test(cdpResultSafetySource)
    && /function redactSecrets/.test(cdpResultSafetySource)
    && /const guard = \(p\) => p\.then\(\(v\) => resultSafety\.redactSecrets\(key, v\)\)/.test(c)
    && /if \(r && r\.secret\) \{ resultSafety\.rememberSecret\(wc\.id, r\.secret\); delete r\.secret; \}/.test(cdpCmdNativeSource)
    && /forgetSecrets\(wc\.id\)/.test(webviewLifecycleSource);
});
check("로그인 실패는 사용자에게 알리고 그 탭으로 데려간다", () => {
  const si = read("server/browser-message-handlers.js");
  return /msg\.type === "ai-login-note"/.test(si) && /type: "ai-login-note"/.test(si)
    && /"ai-login-note": dispatchWs\(handleAiLoginNoteMessage\)/.test(mainJs)
    && /function showNotice/.test(web) && /function gotoTabById/.test(web)
    && /저장된 로그인이 없습니다/.test(web);
});
// 방송은 모든 창이 받으므로, 분리 브라우저 창까지 같은 알림을 띄우면 중복된다.
check("알림은 콘솔 본 창에서만 뜬다", () => {
  const i = web.indexOf("function showNotice");
  return /if \(BROWSER_MODE\) return;/.test(web.slice(i, i + 400));
});
// 항상 표시되는 버튼의 disabled만 토글하는 코드가 남아 있으면, 버튼을 제거한 뒤 첫 편집에서
// 버튼이 다시 나타나지 않는다. 요소를 추가·제거하는 코드여야 한다.
check("저장 버튼은 편집이 생기면 나타난다", () => {
  const i = textEditor.indexOf("function markFileDirty");
  const seg = textEditor.slice(i, i + 900);
  return /if \(d && !sv\)/.test(seg) && /bar\.insertBefore\(sv/.test(seg) && /else if \(!d && sv\) sv\.remove\(\)/.test(seg)
    && /markTabDirty\(t\.id, d\)/.test(seg);
});
check("안 저장된 탭은 앞에 동그라미", () =>
  /function markTabDirty/.test(textEditor)
  && /class="cdirty"/.test(centerTabs)
  && /\.ctab \.cdirty \{[^}]*border-radius:50%/.test(css("11-center-tabs"))
  && /if \(at\.id === getActiveTabId\(getCenterSpace\(\)\)\) markFileDirty\(at\)/.test(mainJs));
// 채팅이 남는 폭을 모두 차지하면, 왼쪽 도구를 바꿀 때마다 그 폭 차이가 채팅에 반영된다.
// 고정 폭은 채팅이 갖고, 남는 폭은 센터가 받는다. 배치 엔진의 계산을 실제로 돌려 본다.
const layoutTree = await import(new URL("../../../web/js/core/layout-tree.js", import.meta.url).href);
const layoutEngine = read("web/js/core/layout-engine.js");
const LAY_BOX = { x: 52, y: 30, w: 1600, h: 900 };
const layOf = (tree, hidden, toolKey = null) => layoutTree.computeLayout(tree, LAY_BOX, { visible: (id) => !hidden.includes(id), collapsedPx: () => null, toolKey }).rects;
check("채팅 폭은 도구를 바꿔도 그대로", () => {
  const tree = layoutTree.defaultTree({ toolW: { "sc-panel": 380 } });
  const plain = layOf(tree, ["tools"]), git = layOf(tree, [], "tools:sc-panel"), full = layOf(tree, ["center"], "tools:ml-panel");
  return plain.chat.w === 400 && git.chat.w === 400 && full.chat.w === 400 && git.center.w === plain.center.w - (380 - 272);
});
// 끌어 맞춘 폭은 인라인으로 들어간다. 접힘 규칙이 그보다 약하면 접기를 눌러도 폭이 남는다
// (확인 결과: 477px 로 끈 뒤 접기 → 클래스는 붙고 폭은 477 그대로). 엔진은 접힌 채팅을 자리에서 뺀다.
check("폭을 맞춘 뒤에도 채팅이 접힌다", () =>
  /case "chat": return \{ els: \(\) => \[\$\("#right"\)\], visible: \(\) => !\$\("#right"\)\.classList\.contains\("collapsed"\)/.test(layoutEngine)
  && /\.right\.collapsed \{ flex:0 0 0 !important; width:0 !important;/.test(css("19-terminal"))
  && layOf(layoutTree.defaultTree(), ["tools", "chat"]).chat === undefined);
check("왼쪽 도구는 도구별로 폭을 기억한다", () => {
  const tree = layoutTree.defaultTree({ sidebarW: 300, toolW: { "sc-panel": 380, "ld-panel": 440 } });
  return layOf(tree, [], "tools:sc-panel").tools.w === 380 && layOf(tree, [], "tools:ld-panel").tools.w === 440
    && layOf(tree, ["tools"]).explorer.w === 300
    && /toolKey: tool && realVisible\("tools"\) \? "tools:" \+ tool\.id : null/.test(layoutEngine)
    && /\/\^ac\\\.utilW\\\.\(\.\+\)\$\//.test(layoutEngine);   // 옛 도구별 폭을 첫 배치로 옮긴다
});
// 이름은 사용자가 붙인 것만. 페이지 제목은 계속 바뀌므로 이름이 아니다.
check("그룹 지목 목록은 사용자가 붙인 이름만 보여준다", () => {
  const si = read("server/browser-message-handlers.js");
  return /name: \(t && t\.name\) \|\| ""/.test(si)
    && !/t\.name \|\| t\.title/.test(si)
    && /\$\{t\.name \? "  " \+ t\.name : ""\}/.test(pickBoot);
});
// wc 번호는 앱을 재시작하면 무효라 전부 버린다. 사용자가 지목한 대상까지 wc로만 들고 있으면
// 재시작 한 번에 지목이 사라지고, 명령이 세션 그룹 탭으로 돌아간다.
check("사용자 지목은 앱 재시작을 견딘다", () => {
  return /const userGrantTabs = new Map\(\)/.test(browserRuntime)
    && /function grantedByTabId/.test(browserRuntime)
    && /if \(grantedByTabId\(session, tabId\)\) return \{ ok: true \}/.test(browserRuntime)       // 권한 판정
    && /if \(grantedByTabId\(session, t\.tabId\)\) return true/.test(browserRuntime)               // 목록
    && /addPin\(msg\.pane, pickedId\)/.test(browserMessages)                                // 지목도 정체성에 묶는다
    && !/userGrantTabs\.clear\(\)/.test(browserRuntime);                                            // 소켓 끊김에 안 버린다
});
// 지목은 사용자가 내린 결정이므로 앱뿐 아니라 서버를 재시작해도 남아야 한다. 확인 결과 서버를
// 함께 재시작하면 지목이 사라졌다. 정체성 값만 남기고 재발급되는 wc는 남기지 않는다.
check("지목은 서버 재시작도 견딘다", () => {
  return /const GRANT_PATH = path\.join\(IRIS_HOME, "grants\.json"\)/.test(browserRuntime)
    && /function persistGrants/.test(browserRuntime)
    && /for \(const \[pane, ids\] of \(g\.tabs \|\| \[\]\)\) userGrantTabs\.set/.test(browserRuntime)
    && /for \(const \[pane, keys\] of \(g\.groups \|\| \[\]\)\) groupGrants\.set/.test(browserRuntime)
    && !/out\.wc/.test(browserRuntime);
});
// 그룹 지목은 열람 허용이 아니라 "이 세션의 그룹이 그 그룹이 된다"는 뜻이다. 세션 그룹이 자동
// 생성된 ai:<pane>으로 남으면 지목 문구가 약속한 "지정 없이 이 그룹 안에서 실행"이 깨진다.
// 확인 결과 claude-group-9를 지목했는데 tabs는 claude-group-7을 자기 그룹으로 보고했다.
check("지목한 그룹이 세션의 그룹이 된다", () => {
  const si = readAll("server");
  return /function adoptGroup\(pane, space, gid\)/.test(si)
    && /adoptGroup\(msg\.pane, msg\.space, msg\.group\)/.test(si)
    && /const a = adoptedOf\(session\);/.test(si)
    && /if \(a && spaceKey\.sameStorageSpace\(a\.space, sessionSpace\(session\)\) && groupExists\(a\.space, a\.gid\)\) return a\.gid;/.test(si)
    && /for \(const \[pane, key\] of \(g\.adopted \|\| \[\]\)\) adoptedGroup\.set/.test(si)   // 재시작을 견딘다
    && /out\.adopted\.push/.test(si);
});
// 그룹을 지목했는데 그 안 탭 하나에 고정해 버리면 "그룹 안에서 자유롭게 여러 탭"이 안 된다.
check("그룹 지목은 탭 고정을 남기지 않는다", () => {
  const si = read("server/browser-message-handlers.js");
  const i = si.indexOf('msg.type === "browser-group-grant"');
  const seg = si.slice(i, i + 1400);
  return /dropPin\(msg\.pane, null\)/.test(seg) && !/addPin\(/.test(seg);
});
// 그룹 이름은 herdr에 실제로 붙은 이름이다. 지목받은 그룹에 세션 이름을 붙여 보고하면 사용자가
// 앱에서 보는 이름과 일치하지 않는다.
check("자기 그룹 이름은 실제 그룹 이름으로 보고", () => {
  const si = readAll("server");
  return /function sessionGroupName\(session\)/.test(si)
    && /groupName: mine && groupExists\(mine, sessionGroupId\(session\)\) \? sessionGroupName\(session\)/.test(si)
    && /자기 그룹 "\$\{sessionGroupName\(session\)\}"/.test(si);
});
// wc(Electron webContents id)는 우리가 짓는 이름이 아니라 그 순간의 webContents 객체 번호다. 같은
// 탭이라도 도킹 전환·프로필 변경·앱 재시작이면 새로 발급되고, 회수된 번호는 다른 탭에 다시 나간다.
// 그래서 오래 유지되는 값(고정·지목·활성·목록·응답)은 전부 정체성으로 표현하고, wc는 명령을 보내기
// 직전에만 조회해 사용한다. 재발급되는 번호 대신 고유 식별자를 쓴다.
check("오래 남는 것은 wc로 말하지 않는다", () => {
  return !/targetByPane/.test(browserRuntime)                        // 세션→wc 고정 자체가 없다
    && !/const userGrants = new Map/.test(browserRuntime)            // 지목의 wc 사본도 없다
    && !/activeWcBySpace/.test(browserRuntime)                       // 활성 표시도 정체성
    && /const wc = tg\.tabId \? wcOfTabId\(tg\.tabId\) : null;/.test(browserCommands) // 손잡이 변환은 명령 owner 한 곳
    && /pinned: session && primaryPin\(session\) \? handleFor/.test(browserCommands); // 응답도 핸들
});
// 디스크에 wc가 새면 재시작 뒤 그 번호가 남의 탭을 가리킨다.
check("디스크에 남기는 것에 wc가 없다", () => {
  // 실제로 쓰는 곳은 writeGrantsNow다(persistGrants는 그것을 지연 호출할 뿐).
  const si = browserRuntime;
  const i = si.indexOf("function writeGrantsNow");
  if (i < 0) return false;
  const seg = si.slice(i, si.indexOf("\n}", i));
  return /out\.tabs\.push\(\[pane, \[\.\.\.s\]\]\)/.test(seg) && !/\bwc\b/.test(seg);
});
// 그룹 핸들도 디스크에 남아야 한다. 아니면 서버가 뜰 때마다 번호가 새로 매겨져 어제 부르던
// 이름이 오늘 다른 그룹을 가리킨다. 확인 결과 claude-group-3이 재시작 뒤 7이 됐다.
check("그룹 핸들 번호는 재시작해도 그대로", () => {
  const si = readAll("server");
  return /groupRecs: \[\.\.\.groupRec\.entries\(\)\]/.test(si)
    && /for \(const \[k, r\] of \(saved\.groupRecs \|\| \[\]\)\)/.test(si)
    && /groupRec\.set\(key, r\); persistHandles\(\)/.test(si);
});
check("지목은 탭이 진짜 닫힐 때만 거둬진다", () => {
  const si = read("server/browser-message-handlers.js");
  const i = si.indexOf('m.op === "tab.close" && m.id');
  const seg = si.slice(i, i + 500);
  const gone = sliceFrom(si, 'msg.type === "browser-tab-gone"', 1000, "지목은 탭이 진짜 닫힐 때만 거둬진다");
  const closeOwner = sliceBetween(browserRuntime, "function removeClosedTab", "function unregisterGoneTab", "지목은 탭이 진짜 닫힐 때만 거둬진다");
  const goneOwner = sliceBetween(browserRuntime, "function unregisterGoneTab", "// 지목은 현재 대화에서 쓸 탭을 정하는 것이다", "지목은 탭이 진짜 닫힐 때만 거둬진다");
  return /removeClosedTab\(m\.id\)/.test(seg)
    && /for \(const grants of userGrantTabs\.values\(\)\) grants\.delete\(tabId\)/.test(closeOwner)
    // browserState의 close를 타지 않는 팝업만 gone을 진짜 종료로 본다. 일반 gone은 계속 보존한다.
    && /unregisterGoneTab\(tabId, msg\.wc\)/.test(gone)
    && /tabReg\.get\(tabId\)\?\.win === "popup"/.test(goneOwner)
    && /if \(popupClosed\) \{[\s\S]{0,300}?userGrantTabs/.test(goneOwner);
});
// 하루치 안에서 "보관한 순간"의 경계가 `## 13:40` 같은 평범한 제목이면 사용자가 메모에 쓴 제목과
// 구별되지 않아 잡음이 된다. 경계는 전용 표시로 넣고, 삭제도 그 표시를 기준으로 한다.
check("보관 블록은 우리 표시로 구분되고 하나만 지울 수 있다", () => {
  const si = read("server/memo-service.js");
  return /const BLOCK_MARK = "<!-- ac:block "/.test(si)
    && /function newBlockId/.test(si)
    && /msg\.type === "memo\.archive\.block\.delete"/.test(si)
    && /cur\.blocks = cur\.blocks\.filter\(\(b\) => b\.id !== id\)/.test(si)
    && /function ensureBlocks/.test(si)                       // 옛 보관본도 한 덩어리로 다룬다
    && /data-mm="bdel"/.test(memoAdmin) && /이 기록만 삭제/.test(memoAdmin);
});
// 북마크는 이동할 곳의 지목이므로, 주소를 옮겨 적는 대신 눌러서 이동한다.
check("북마크도 요소 선택으로 지목된다", () => {
  return /function pickBmkAt/.test(pickHost)
    && /const bm = pickBmkAt\(e\.target\);/.test(pickHost)
    && /\[사이트 지목 · 이 주소를 기억하고 활용하세요\]/.test(pickHost)
    && !/여기로 이동하세요/.test(pickHost)     // 지목은 "지금 가라"가 아니다
    && /!pickBmkAt\(e\.target\)/.test(pickHost)               // 지목 중엔 그냥 이동하지 않는다
    && /\.picking-tabs \.bmk\.pick-hover/.test(css("25-pick-record")) // 무엇을 고르는지 보인다
    && /msg\.type === "site-pick-relay"/.test(read("server/index.js")); // 분리창에서도 된다
});
// 쪽지는 계속 고쳐 쓰는 것이라, 어제 무엇을 적었는지는 남겨두지 않으면 사라진다.
check("메모를 날짜로 보관한다", () => {
  const si = read("server/memo-service.js");
  return /memo-archives\.json/.test(si)
    && /msg\.type === "memo\.archive"/.test(si)
    && /function todayStamp/.test(si) && /function clockStamp/.test(si)
    && /msg\.type === "memo\.archive\.delete"/.test(si);
});
// 같은 날 덮어쓰면 그날 앞서 보관한 내용이 사라지므로, 앞에 시각을 붙여 이어 쓴다.
check("같은 날은 한 장에 시각을 달고 쌓인다", () => {
  const si = read("server/memo-service.js");
  const i = si.indexOf('msg.type === "memo.archive"');
  const seg = si.slice(i, i + 900);
  return /clock: clockStamp\(\)/.test(seg)
    && /cur\.blocks\.push\(block\)/.test(seg)          // 같은 날엔 쌓는다
    && /list\.push\(\{ date, blocks: \[block\]/.test(seg)
    && !/cur\.text = text;/.test(seg);                  // 덮어쓰기가 남아 있으면 안 된다
});
check("메모 관리 페이지가 있고 단축키로 보관된다", () => {
  return /data-rail="memo"/.test(web) && /function mmRefresh/.test(memoAdmin)
    && /function archiveMemo/.test(memoAdmin)
    && /matchBinding\(e, bindingOf\("memo-archive"\)\)/.test(keynav)          // 조합은 표가 정한다
    && /"memo-archive": \{ mod: true, shift: true, key: "s" \}/.test(mainWindowSource)   // webview 포커스에서도
    && /case "memo-archive": callHook\("memo\.archive"\)/.test(dock)
    && /provide\("memo\.archive"/.test(memoAdmin)
    && !/from "\.\.\/panel\/memo-admin\.js"/.test(dock)
    && !/from "\.\.\/panel\/memo-admin\.js"/.test(keynav);
});
// 다른 스페이스를 보는 것은 잠깐 넘어가 보는 것이지 작업 스페이스를 옮기는 것이 아니다.
check("메모 페이지는 보던 스페이스로 돌아올 수 있다", () =>
  /let mmView = null, mmHome = null/.test(memoAdmin)
  && /case "home": mmView = null/.test(memoAdmin)
  && /지금 작업 중\)으로/.test(memoAdmin)
  && /case "go": \{ const id = b\.dataset\.space; if \(!id\) break; mmView = id/.test(memoAdmin)
  && !/case "go": \{ const id = b\.dataset\.space; if \(!id\) break; selectedSpaceId/.test(memoAdmin));
// 현재 스페이스가 중심이고 다른 스페이스는 보조이므로, 크기로 그 차이를 나타낸다. 세 단 가운데
// 지금 메모 편집기 단만 폭이 늘고, 스페이스 목록과 보관본 단은 폭이 고정이다.
check("메모 관리는 지금 스페이스를 크게 놓는다", () =>
  /\.mm-main \{ display:grid; grid-template-columns:\d+px minmax\(0,1fr\) \d+px;/.test(css("05-memo-manage"))
  && /id="mm-slot"/.test(memoAdmin) && /data-mm="go" data-space=/.test(memoAdmin)
  && /data-mm="restore"/.test(memoAdmin) && /data-mm="clear"/.test(memoAdmin));
// 계정이 수십 개면 단층 목록으로는 찾을 수도, 무엇이 열려 있는지 볼 수도 없다.
check("자동완성 관리 화면은 사이트로 묶고 찾을 수 있다", () =>
  /const groupOf = \(rows\) =>/.test(autofillAllowlist)
  && /const ao = a\[1\]\.some\(\(x\) => x\.allowed\) \? 0 : 1/.test(autofillAllowlist)   // 열어둔 사이트가 위로
  && /id="af-q"/.test(autofillAllowlist) && /data-filter="\$\{v\}"/.test(autofillAllowlist)
  && /seg\("on", "허용됨"\)/.test(autofillAllowlist) && /data-lockall="1"/.test(autofillAllowlist)
  && /class="af-sw/.test(autofillAllowlist) && /role="switch"/.test(autofillAllowlist)   // 켜짐/꺼짐은 형태로 읽힌다
  && /\.af-sw \{[^}]*border-radius:8px/.test(css("06b-autofill")) && /\.af-sw\.on i \{[^}]*left:14px/.test(css("06b-autofill")));
// 목록이 적은 이유는 누락이 아니라 가져오지 않은 프로필이다. 그 사실이 화면에 보여야 한다.
check("열린 사이트와 저장된 전체를 나눠 보여준다", () =>
  /function afOpenOrigins/.test(autofillAllowlist)
  && /지금 열려 있는 사이트/.test(autofillAllowlist) && /저장된 로그인 전체/.test(autofillAllowlist)
  && /openNoCred/.test(autofillAllowlist)                                     // 열려 있는데 저장이 없는 곳도 알린다
  && /ac-ai-login-sources/.test(aiLoginPolicySource)
  && /아직 안 가져온 Chrome 계정 \$\{gap\}개/.test(autofillAllowlist)
  && /data-goacct="1"/.test(autofillAllowlist));
// 프로필 식별 방식이 이 경고의 정확도를 정한다. 이름은 사용자가 바꾸고 서로 겹칠 수 있어
// 식별자가 못 되고, 로그인한 계정(gaia_id·이메일)이 키다. 파티션 이름에 Chrome 프로필 id가
// 들어 있는지 문자열로 판정하면 이미 가져온 것까지 "안 가져옴"으로 표시된다.
check("가져온 프로필 판정은 계정으로 한다", () => {
  return /function chromeProfileKey/.test(chromeImportRegistrySource)
    && /if \(entry\.gaia\) return "gaia:" \+ entry\.gaia;/.test(chromeImportRegistrySource)
    && /function note\(entry, partition\)/.test(chromeImportRegistrySource);
});
check("Chrome import 계정 장부 배선이 native에 존재한다", () => {
  const native = readAll("native");
  return /account: v\.user_name \? String\(v\.user_name\) : ""/.test(native) // 계정 이메일을 읽어온다
    && /noteChromeImport\(entry, partition\)/.test(native)
    && /imported: chromeImportRegistry\.has\(x\)/.test(native)
    && !/String\(i\.partition\)\.includes\(p\.id\)/.test(native); // 문자열 넘겨짚기 제거
});
// 로그인하는 화면에서 켜고 끌 수 있어야 관리 페이지까지 찾아가지 않는다.
check("자동완성 드롭다운에서 바로 AI 허용을 바꿀 수 있다", () => {
  const pre = read("native/electron/webview-preload.cjs");
  return /data-ac-ai/.test(pre)
    && /ipcRenderer\.sendToHost\("ac-ai-allow"/.test(pre)
    && /if \(!ev\.isTrusted\) return;\s*\/\/ 페이지가 합성 이벤트로 권한을 켜지 못하게/.test(pre)
    && /e\.channel === "ac-ai-allow"/.test(webviewFactory)
    && /acHost\.aiLoginSet\(req\.origin, c\.username, !!req\.allow\)/.test(webviewFactory);
});
// 게스트는 아이디와 권한을 스스로 만들 수 없다. 전송하는 값은 순번뿐이고 이름은 호스트 캐시에서 온다.
check("드롭다운 허용은 게스트가 아니라 호스트가 기록한다", () => {
  const i = webviewFactory.indexOf('e.channel === "ac-ai-allow"');
  const seg = webviewFactory.slice(i, i + 600);
  return /const c = rec\.autofill\.creds\[req\.i\]/.test(seg) && !/req\.username/.test(seg);
});
// 지목받지 않은 그룹은 접근도, 목록 노출도 안 된다. 목록에 나오면 존재가 드러나고,
// 그것을 대상으로 삼아 실패하거나 다른 세션의 탭을 조작하게 된다.
check("선택 안 된 그룹은 세션에게 보이지도 않는다", () => {
  const si = browserRuntime;
  const seg = sliceBetween(si, "function visibleTabsFor", "function tabBrief", "선택 안 된 그룹은 세션에게 보이지도 않는다");
  return /const g = controlOwnerOf\(mine, t\.tabId\)/.test(seg)
    && /return g === mineG \|\| groupGranted\(session, mine, g\)/.test(seg)
    && !/\(mine \? t\.space === mine : false\)/.test(seg);
});
// 지목 문구에 wc 숫자(@4)가 들어가면 그건 부를 수 있는 이름이 아니고, 숫자라 헷갈린다.
check("탭 지목 문구도 서버가 매긴 핸들을 쓴다", () => {
  const si = read("server/browser-message-handlers.js");
  return /type: "tab-granted"[\s\S]{0,240}handle: handleFor\(pickedId\)/.test(si)
    && /"tab-granted": \(m\) => \{/.test(pickBoot)
    && /탭: @\$\{m\.handle\}/.test(pickBoot)
    && !/핸들: @\$\{tab\.wc\}/.test(web);   // 창이 wc를 붙이던 옛 문구는 없어야 한다
});
// 요소 지목 문구의 탭 이름도 호출 가능한 이름이어야 한다. "지금 콘솔이 보고 있는 탭"의 표시
// 라벨을 쓰면 분리창이나 다른 탭에서 고를 때 엉뚱한 탭 이름이 붙고 핸들도 없다.
check("요소 지목 문구도 고른 그 탭의 핸들을 쓴다", () => {
  const si = readAll("server");
  return /function broadcastTabHandles/.test(si)
    && /broadcast\(\{ type: "tab-handles", map \}\)/.test(si)
    && /"tab-handles": dispatchWs\(handleTabHandlesMessage\)/.test(mainJs)
    && /callHook\("pick\.deliver", pick, tabId\)/.test(webviewFactory)   // 어느 탭에서 골랐는지 함께 넘긴다
    && /const pickedId = p\.tabId \|\| getActiveTabId\(getCenterSpace\(\)\)/.test(pick)
    && /const handle = tabHandles\[pickedId\] \|\| null/.test(pick);
});
// 터미널에 붙는 문구에는 실제로 호출 가능한 이름이 들어가야 한다. 창이 임의로 만들면 안 된다.
check("그룹 지목 문구의 핸들은 서버가 매긴다", () => {
  const si = read("server/browser-message-handlers.js");
  return /type: "group-granted"[\s\S]{0,200}handle: groupHandleFor/.test(si)
    && /"group-granted": \(m\) => \{/.test(pickBoot)
    && /그룹: \$\{m\.label\} \(\$\{m\.handle\}\)/.test(pickBoot)
    && !/그룹: \$\{g\.label\}/.test(web);   // 창이 짓던 옛 문구는 없어야 한다
});
check("메모도 안 저장된 편집을 동그라미로 알린다", () => {
  const si = readAll("server");
  return /function markDirty/.test(memoStorePanel)
    && /markDirty\(true\)/.test(memoStorePanel)
    && /MEMO_DRAFTS_KEY/.test(memoStorePanel)
    && /baseVersion: draft\.baseVersion/.test(memoStorePanel)
    && /memoDock\.setDocument/.test(si)
    && /type: "memo-saved"/.test(si)
    && /isSavedDraft\(draft, message\.text\)/.test(memoStorePanel); // ACK 본문과 같은 초안만 지운다
});
// 그룹에서 작업하다 탭을 더 여는 흐름이다. 새 탭을 만들고 끌어다 넣는 두 단계를 없앤다.
check("그룹 우클릭에서 그 그룹에 새 탭을 만든다", () =>
  /label: "이 그룹에 새 탭"/.test(browserTabs)
  && /newBrowserTab\(null, \{ group: gid, space: sp \}\)/.test(browserTabs)
  && /if \(opts && opts\.group\) mut\.group = opts\.group;\s*bsMutate\(mut\)/.test(mainJs)
  && /const sp = \(opts && opts\.space\) \|\|/.test(mainJs));   // 그룹이 사는 스페이스에 만든다
// 스페이스가 바뀌면 에이전트 섹션도 함께 바뀌고, 선택한 줄은 목록 끝에 붙지 않아야 한다.
// 위아래로 한 줄씩 보여야 현재 위치를 알 수 있다.
check("고른 에이전트는 앞뒤가 보이게 드러난다", () =>
  /function revealAgentRow\(paneId\)/.test(herdrAgents)
  && /const pad = r\.height \+ 6;/.test(herdrAgents)                    // 위아래 한 줄치 여유
  && /collapsed\.groups\.has\(spk\(a\.workspaceId\)\)/.test(herdrAgents)  // 접힌 그룹이면 먼저 편다(열쇠는 폴더)
  && /renderAgents\(\); revealAgentRow\(a\.paneId \|\| curTarget\);/.test(mainJs)  // 스페이스 이동 시
  && !/agentList\.querySelector\(`\.srow\[data-target="\$\{cssEsc\([^)]*\)\}"\]`\)\?\.scrollIntoView/.test(herdrAgents));
// 도구 목록만으로는 AI가 로그인할 수 있다는 것을 알 수 없어, 로그인 벽에서 사람에게 넘기게 된다.
// 연결되는 순간 한 줄, 로그인 칸이 실제로 보일 때 그 화면에서 한 줄을 붙인다.
// 항상 붙는 문구는 짧게 유지하고, 도구 설명에 있는 내용을 반복하지 않는다.
check("로그인할 수 있다는 사실이 호출자에게 닿는다", () => {
  const mcp = read("bin/iris-mcp.mjs"), inspect = cdpCmdInspectSource;
  const ins = /instructions: "([^"]*)"\s*\n?\s*\+ "([^"]*)"/.exec(mcp);
  return !!ins && (ins[1] + ins[2]).length < 220          // 항상 붙는 글은 짧게
    && /browser_login을 먼저 불러라/.test(mcp)
    && /async function loginHint/.test(cdpHintsSource)
    && /input\[type=password\]/.test(cdpHintsSource)
    && /if \(hint\) out\.loginHint = hint;/.test(inspect)     // 스냅샷
    && /if \(lh\) out\.loginHint = lh;/.test(inspect)         // observe
    && /d\.loginHint \? d\.loginHint/.test(mcp);
});
// 직접 적은 명령 목록은 명령이 늘어도 그대로 남아, 있는 기능을 없는 것처럼 보이게 한다.
// 확인 결과 다른 세션이 login·upload·nativeclick을 찾지 못하고 사람에게 넘겼다.
check("CLI 도움말이 실제 명령을 다 보여준다", () => {
  const cli = read("bin/iris-browser.mjs");
  const help = /const HELP = `([\s\S]*?)`;/.exec(cli);
  if (!help) return false;
  const shown = help[1];
  return ["login", "upload", "download", "nativewin", "nativeclick", "nativekey", "observe", "newtab", "target"]
    .every((c) => shown.includes(c))
    && /cmd === "help" \|\| cmd === "--help" \|\| cmd === "-h"/.test(cli)
    && /쓸 수 있는 것: /.test(read("native/electron/cdp-control.cjs"));   // 모르는 명령일 때도 목록을 준다
});
check("그룹째 지목할 수 있다", () => {
  const si = read("server/index.js");
  return /function grantGroup\(pane, space, gid\)/.test(browserRuntime)
    && /msg\.type === "browser-group-grant"/.test(si)
    && /msg\.type === "group-pick-relay"/.test(si)
    && /function pickGroupAt/.test(pickHost)
    && /function deliverGroupPick/.test(pickHost)
    && /\.picking-tabs \.ctab, \.picking-tabs \.tgroup, \.picking-tabs \.bmk \{ cursor:crosshair/.test(css("25-pick-record"));
});
// AI는 스스로 권한을 넓힐 수 없고, 그룹 지목도 로컬 UI 경로에서만 일어나야 한다.
// 지목은 권한 확대이므로 사람이 앱에서 해야 한다. 확인 결과 임의의 로컬 프로세스가 WS로 붙어
// 자기에게 탭을 지목하고 곧바로 조작할 수 있었다. 앱만 아는 토큰을 증명해야 받는다.
check("지목은 앱임을 증명한 연결만", () => {
  const si = read("server/browser-message-handlers.js");
  return /uiToken = loadUiToken\(\)/.test(browserRuntime)
    && /crypto\.timingSafeEqual/.test(browserRuntime)
    && /msg\.type === "ui-auth"/.test(si)
    && /ws\._ui = !!\(ws\._local && uiTokenOk\(msg\.token\)\)/.test(si)
    && /if \(ws\._local && ws\._ui && msg\.pane && pickedId/.test(si)
    && /mode: 0o600/.test(browserRuntime);
});
check("앱은 그 증명을 실제로 보낸다", () => {
  const pre = read("native/electron/preload.cjs"), mainH = read("native/electron/main.cjs");
  return /uiToken: \(\) => ipcRenderer\.sendSync\("ac-ui-token"\)/.test(pre)
    && /ipcMain\.on\("ac-ui-token"/.test(mainH)
    && /wsSend\(\{ type: "ui-auth", token: t \}\)/.test(web);
});
// 페이지가 던진 예외 메시지에 "연결 안 됨"이 들어 있으면 문자열 판별은 "안 나갔다"로 오판해
// 이미 일어난 부수효과를 여러 번 반복한다. 전송 여부는 구조화된 값으로 판단한다.
check("전송 사실은 문자열이 아니라 플래그로", () => {
  const si = read("server/browser-commands.js");
  return /sent: false, appGone: true/.test(si)
    && /const notSent = last && last\.sent === false;/.test(si)
    && !/NOT_SENT_RE/.test(si) && !/APP_GONE_RE/.test(si);
});
check("기다리는 이유가 바뀌면 회차도 다시 센다", () => {
  const si = readAll("server");
  return /if \(gone !== longWait\) \{ longWait = gone; step = 0; \}/.test(si) && /ladder\[step\+\+\]/.test(si);
});
// 브라우저 탭을 보고 있지 않으면 그 사실도 알려야 한다. 그러지 않으면 키 입력이 사라진다.
check("보던 브라우저 탭에서 나가면 그것도 알린다", () => {
  return /acHost\.tabShown\(0, 0, 0\)/.test(webviewFactory);
});
// 새 탭은 기본이 아니라 예외다. 탭이 늘수록 사용자의 브라우저가 AI 작업물로 채워진다.
check("쓰던 탭이 있으면 새로 만들지 않는다", () => {
  const si = readAll("server"), mcp = read("bin/iris-mcp.mjs"), cli = read("bin/iris-browser.mjs");
  return /function reusableTabFor\(session\)/.test(si)
    && /const wantParallel = !!\(args && \(args\.parallel \|\| args\.newState\)\);/.test(si)
    && /reused: true/.test(si)
    && /parallel: \{ type: "boolean"/.test(mcp)
    && /args\.parallel = true;/.test(cli);
});
// "다른 상태"는 프로필만이 아니다. 프론트·어드민 동시 사용(탭 추가)과 다른 계정(로그인 칸 분리)은
// 요구가 다르다. 계정이 다른데 칸을 나누지 않으면 쿠키가 하나여서 한쪽이 로그아웃된다.
check("다른 계정은 로그인 칸까지 가른다", () => {
  const mcp = read("bin/iris-mcp.mjs"), cli = read("bin/iris-browser.mjs");
  return /function profileRefToId\(ref\)/.test(browserRuntime)
    && /그런 로그인 칸\(프로필\)이 없습니다/.test(browserCommands)
    // 기본 칸의 id 는 빈 문자열이다. 참/거짓으로 거르면 그 칸이 전달되지 않아 스페이스 기본으로
    // 열리므로, null 여부로 판정한다.
    && /\.\.\.\(profileId != null \? \{ profile: profileId \} : \{\}\)/.test(browserCommands)
    && /if \(profileId === null\)/.test(browserCommands)
    && /profiles: profileNames\(\)/.test(browserCommands)
    && /browser-profiles/.test(web)
    && /profile: \{ type: "string"/.test(mcp)
    && /args\.profile = rest\[\+\+i\]/.test(cli);
});
// 결제·본인확인처럼 AI가 대신할 수 없는 경우다. 화면을 빼앗지 않고 호출하며, 이동 여부만 돌려준다.
// 호출한 위치로 이동시킨다면서 탭만 바꾸고 스페이스를 그대로 두면 작업 환경이 다른 곳에 남는다.
check("그 탭으로는 스페이스까지 옮긴다", () => {
  const i = web.indexOf("function gotoTabById");
  const seg = web.slice(i, i + 900);
  return /if \(sp !== selectedSpaceId\) focusSpace\(sp\);/.test(seg) && /op: "space\.active"/.test(seg);
});
// 도구 설명만으로는 호출되지 않는다. 화면을 본 결과에 다음 할 일이 함께 와야 한다.
check("사람이 나설 차례는 그 자리에서 알려준다", () => {
  const inspect = cdpCmdInspectSource, mcp = read("bin/iris-mcp.mjs");
  return /async function humanHint\(send\)/.test(cdpHintsSource)
    && /out\.humanHint = hh;/.test(inspect) && /out\.humanHint = hh2;/.test(inspect)   // snapshot·observe 둘 다
    && /browser_ask_user로 불러라/.test(cdpHintsSource)
    && /d\.humanHint \? d\.humanHint \+ "\\n\\n" : ""/.test(mcp)
    && /browser_ask_user를 불러라/.test(mcp);   // MCP 서버 지시문에도
});
// 호출 전에 AI가 채울 수 있는 칸이 남았는지 화면에서 확인한다. 배송지·받는 사람을 비워 두고
// 호출하면 사람이 AI 몫까지 하게 된다. 비밀 칸은 사람 몫이므로 집계에서 제외한다.
check("부르기 전에 할 일이 남았는지 본다", () => {
  const si = readAll("server"), mcp = read("bin/iris-mcp.mjs");
  return /const UNFILLED_PROBE = /.test(si)
    && /password\|cc-\|card\|cvc\|cvv\|expiry\|one-time\|otp\|captcha/.test(si)   // 비밀 칸 제외
    && /아직 네가 채울 수 있는 칸이 남았습니다/.test(si)
    && /if \(left\.length && !ready\)/.test(si)
    && /AI가 못 채운 칸/.test(si)      // ready로 넘어가도 사용자에게는 보인다
    && /ready: \{ type: "boolean"/.test(mcp);
});
// 요소를 고르는 것 자체가 이 탭의 대상을 봐 달라는 사용자 행위이므로, 그 시점에 권한 등록까지 끝낸다.
// 핸들만 보내면 받는 쪽에 권한이 없어 그 지점에서 막힌다.
// 또한 받는 쪽이 어느 탭인지 몰라 목록을 다시 조회하게 되므로, 그 왕복을 없앤다.
// 알림에는 설명 없이 사실만 싣는다. "이 알림은 통지일 뿐이다", "권한: 이 탭을 만질 수 있게
// 열렸다" 같은 문장이 픽 하나의 4분의 1을 차지했다. 권한 제한은 서버가 관리하므로 그런 안내가
// 없어도 우회되지 않는다.
check("알림은 설명하지 않고 사실만 싣는다", () => {
  const bad = ["통지일 뿐이다", "browser_tabs가 정답이다", "권한: 이 탭을 만질 수 있게",
    "원본 필드는 browser_picks", "원본 필드는 app_picks", "app_tap·app_expect를 쓴다",
    "지정 없는 명령은 이 탭에서 실행됩니다"];
  return bad.every((s) => !pick.includes(s) && !mainJs.includes(s))
    && /function noticeBlock\(title, lines\) \{/.test(xtermWiring)     // 신뢰 문구 인자 자체가 사라졌다
    && /handle && curHandle && curHandle !== handle \? `대상 탭: @\$\{curHandle\}` : null/.test(pick);
});
// 여는 표식만 있으면 끝나는 위치를 알 수 없고, 뒤에는 사용자 입력이 이어진다. 두 표식은 한 함수가
// 함께 붙인다. 따로 적으면 한쪽만 남을 수 있다.
check("알림은 여닫는 표식이 짝으로 나간다", () => {
  // 표식의 소유자는 앱 셸이다. 터미널에 무엇이 들어가는지는 앱 셸이 정하고, 여러 기능이
  // 호출한다(요소 지목·화면 스케치). 기능 파일에 두면 다음 기능이 같은 것을 다시 만든다.
  const owner = xtermWiring;
  const open = (owner.match(/"⟦Iris⟧ " \+ title/g) || []).length;
  const close = (owner.match(/"⟦\/Iris⟧"/g) || []).length;
  // 측정 대상은 이 함수를 쓰는 곳의 수다. 파일을 직접 나열하면 이동할 때마다 수가 어긋난다.
  const uses = (allWebJs.match(/noticeBlock\(/g) || []).length;
  // 표식을 만드는 곳은 하나뿐이고 나머지는 모두 그 함수를 호출한다. 호출 지점의 수(정의 1 + 호출 5)를
  // 세면 알림을 하나 추가할 때마다 수가 어긋나기만 하고 아무것도 검사하지 못한다.
  // 검사할 것은 표식 문자열이 이 파일 밖에 또 있는지다. 짝이 갈라지는 경로가 그것뿐이다.
  const elsewhere = allWebJs.replace(owner, "");
  return open === 1 && close === 1 && uses >= 2
    && !elsewhere.includes("⟦Iris⟧") && !elsewhere.includes("⟦/Iris⟧");
});
// 부름은 "갔음"에서 끝나면 안 된다. 거기서 돌려주면 AI가 사람이 일을 마치기 전에 턴을 끝낸다.
check("부름은 사람이 끝낼 때까지 붙잡는다", () => {
  const si = readAll("server"), mcp = read("bin/iris-mcp.mjs");
  return /if \(a === "갔음"\) \{ waitOn\(id, tabId, true\); return; \}/.test(si)   // 출발 신호로는 안 돌려준다
    && /done: answer === "다 했음"/.test(si)
    && /const deadline = Date\.now\(\) \+ waitMs;/.test(si)                        // 단계가 넘어가도 한 호출의 끝은 그대로
    && /ASK_CALL_MAX_MS = 240000/.test(si)
    && /data-done="1">다 했어요/.test(web) && /data-fail="1">못 하겠어요/.test(web)
    && /answer\("다 했음"\)/.test(web)
    && /턴을 끝내지 마/.test(mcp);
});
check("기다리는 알림은 다른 알림에 밀려나지 않는다", () =>
  /if \(answer\) el\.dataset\.wait = "1";/.test(web)
  && /const victim = \[\.\.\.stack\.children\]\.find\(\(c\) => !c\.dataset\.wait\);/.test(web));
// 호출이 끊긴 사이에 사람이 누른 답도 잃지 않는다. 그러지 않으면 알림을 두 번 띄우게 된다.
check("끊긴 사이의 답과 부름을 이어받는다", () => {
  const si = readAll("server");
  return /const askGoing = new Map\(\)/.test(si) && /const askAnswers = new Map\(\)/.test(si)
    && /if \(a === "갔음" && own\) askGoing\.set\(own\.session, aid\);/.test(si)
    && /else \{ askAnswers\.set\(aid, a\);/.test(si)
    && /const cont = askGoing\.get\(skey\);/.test(si);
});
// 이어받기는 호출 본문을 건너뛰고 곧바로 응답 조립으로 간다. 그 조립이 본문에서 선언되는 값을
// 읽으면 서버가 종료된다(server.log의 ReferenceError: Cannot access 'askDevice' before
// initialization). 소스 모양이 아니라 그 경로를 실제로 실행해서 확인한다. 종료되는 코드라면
// 여기서 거부로 돌아온다.
await checkAsync("끊긴 부름을 이어받아도 서버가 살아 있다", async () => {
  const mod = await import("../../../server/browser-commands.js");
  const sent = [];
  mod.initBrowserCommands({ broadcast: (m) => sent.push(m) });
  const sess = "smoke-ask-" + process.pid;
  // 앱 대상이라 탭 폴백을 쓰지 않으므로, 실제 브라우저 없이 호출이 뜬다.
  const first = mod.runBrowserCmd("ask", { message: "사람 손이 필요합니다", device: "smoke-sim", wait: 1 }, sess);
  await new Promise((r) => setTimeout(r, 30));
  const ask = sent.find((m) => m && m.type === "ai-ask");
  if (!ask) return false;
  mod.answerUserAsk(ask.id, "갔음");            // 사람이 출발만 알리고 아직 안 끝냈다
  await first;                                   // 첫 호출은 제 시간이 다 되어 돌아온다
  const again = await mod.runBrowserCmd("ask", { message: "이어받기", device: "smoke-sim", wait: 1 }, sess);
  return !!(again && again.ok && again.data && again.data.device === "smoke-sim");
});

// 여러 개를 골랐을 때 어느 문구가 어느 요소인지 대응시키는 라벨.
check("여러 개 고르면 이름표와 한 벌 표시가 붙는다", () => {
  const si = readAll("server");
  return /if \(!p\.pid\) p\.pid = "p" \+ Math\.random\(\)/.test(pick)
    && /요소 선택 \$\{p\.pid \? "#" \+ p\.pid \+ " " : ""\}/.test(pick)
    && /pickBurst = \(now - lastPickAt < 20000\) \? pickBurst \+ 1 : 1;/.test(pick)
    && /연속 \$\{p\.burst\}번째/.test(pick)
    && /p\.otherTab \? " · 앞과 다른 탭" : ""/.test(pick)
    && /pick: x\.pick\.pid \|\| undefined, burst: x\.pick\.burst \|\| undefined,/.test(si);
});
check("그룹 지목 글이 어느 탭인지 말해준다", () => {
  const si = readAll("server");
  return /return \{ handle: h, name: \(t && t\.name\) \|\| "", url: live\.url/.test(si)
    && /showing: tabIsShowing\(live\.space, id\)/.test(si)
    && /t\.showing \? "  \(보임\)" : ""/.test(pickBoot)
    && /스페이스 \$\{m\.space\}/.test(pickBoot);
});
check("요소를 고르면 그 탭이 등록된다", () => {
  const si = read("server/index.js"), commands = read("server/browser-commands.js"), mcp = read("bin/iris-mcp.mjs");
  return /type: "browser-target-set", pane: curTarget, tabId: pickedTab, via: "pick"/.test(pick)
    && /type: "ai-pick", pane: curTarget/.test(pick)
    && /msg\.type === "ai-pick"/.test(si)
    && /if \(cmd === "picks"\)/.test(commands)
    && /browser_picks/.test(mcp);
});
}
