import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindSpaceFolder } from "./browser-state-owner.js";
import { requestRecompute as recompute } from "./runtime-state.js";

// 스페이스와 터미널 탭 WebSocket handler의 단일 owner.
//
// 소유 범위
//   space.create/close와 tab.create/rename/move 요청의 검증·Herdr 호출·응답 흐름.
//
// 제공 API
//   Herdr port를 받는 initWorkspaceHandlers와 namespace별 handleSpace/handleTab 함수.
//
// 의존 대상
//   browser-state owner의 요청 폴더 바인딩과 runtime-state의 recompute port에 기대고,
//   Herdr 서비스는 composition root에서 주입받으며 다른 handler를 import하지 않는다.
//
// 유지 조건
//   로컬 생성/닫기 gate, 경로·폴더 검증, bind→recompute 순서와 기존 성공·오류 envelope를 보존한다.
//
// 영향 범위
//   server/index.js의 초기화·space/tab namespace dispatch, browser-state-owner.js의 폴더 키 이관,
//   workspace-runtime.js의 후속 재계산과 bin/smoke.mjs의 스페이스 소유 검사·web의 space/tab 요청 UI.

let herdr;

// 새 터미널 탭에서 시작할 수 있는 항목. 값이 셸에 그대로 전달되므로 라벨로만 선택한다.
// 사용자가 보낸 문자열을 그대로 실행하면 원격에서 임의 명령을 실행할 수 있게 된다.
const LAUNCHERS = { claude: "claude", codex: "codex" };

export function initWorkspaceHandlers(deps) {
  herdr = deps.herdr;
}

// 스페이스 생성/닫기. 둘 다 셸을 만들거나 종료하므로 원격(폰)에서 금지한다(AC5). 터미널 탭 생성과 같은 경계다.
// 닫기는 그 스페이스의 모든 탭·pane이 종료되는 비가역 조작이라, 확인은 로컬 UI가 먼저 받는다.
export function handleSpace(ws, msg) {
  // 스페이스 오류는 터미널이 아니라 화면에 표시해야 한다. 사용자가 눌러 시작한 동작이라 결과를 그 자리에서 확인한다.
  const fail = (e) => ws.send(JSON.stringify({ type: "space-error", message: String(e && e.message || e) }));
  if (!ws._local) { fail(new Error("원격에서는 스페이스 조작 불가(AC5)")); return; }
  if (msg.type === "space.create") {
    // 사용자가 직접 입력하는 경로다. ~ 는 여기서 한 번만 확장한다.
    const raw = typeof msg.cwd === "string" ? msg.cwd.trim() : "";
    const cwd = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (!cwd || !path.isAbsolute(cwd)) { fail(new Error("스페이스로 열 폴더를 절대경로로 지정하세요: " + (raw || "(빈 값)"))); return; }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { fail(new Error("폴더가 없습니다: " + cwd)); return; }
    // 이름은 넘기지 않는다. herdr는 label을 받으면 custom_name으로 고정하고, 이후 그 스페이스의
    // 폴더가 바뀌어도(pane에서 cd) 이름이 따라가지 않는다. 한 번 고정되면 API로 되돌릴 수도 없다.
    // rename에 ""는 빈 이름이 되고 null은 타입 오류다. 넘기지 않으면 herdr가 폴더 이름을 붙이고
    // 계속 갱신한다(확인 결과: cwd .../Personal로 만들면 label "Personal", 그 pane에서 iris로
    // cd 하면 label "iris"). 사용자가 직접 지은 이름만 넘겨 그때만 고정한다.
    const label = typeof msg.label === "string" && msg.label.trim() ? msg.label.trim() : null;
    // 무엇을 받아 무엇으로 만들었는지 기록한다. 이름이 잘못 붙었을 때 클라이언트가 무엇을
    // 보냈는지 알 수 없으면 원인을 좁힐 수 없다.
    console.log(`[space.create] raw=${JSON.stringify(raw)} cwd=${cwd} msgLabel=${JSON.stringify(msg.label ?? null)} label=${JSON.stringify(label)}`);
    herdr.workspaceCreate({ cwd, label, focus: true }).then((res) => {
      const id = res?.workspace?.workspace_id || res?.workspace_id || null;
      bindSpaceFolder(id, cwd);
      recompute();
      // 붙는 이름은 herdr가 정한다. 알림도 herdr가 반환한 이름을 그대로 사용한다.
      const named = res?.workspace?.label || label || path.basename(cwd);
      ws.send(JSON.stringify({ type: "space-created", workspaceId: id, label: named, cwd }));
    }).catch(fail);
  } else if (msg.type === "space.close") {
    if (!msg.workspaceId) return;
    herdr.workspaceClose(msg.workspaceId).then(() => recompute()).catch(fail);
  }
}

// 새로 만든 탭은 셸이 아직 실행되지 않았을 수 있다. 프롬프트가 그려지기 전에 입력하면 글자가
// 입력줄에 남고 제출되지 않으므로, 화면에 출력이 나올 때까지 기다린 뒤 입력한다.
async function waitForShell(paneId, tries = 24, gap = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await herdr.paneRead(paneId, "visible");
      if (String(r?.text || "").trim()) {
        // 프롬프트가 보여도 입력을 받기까지 약간의 시간이 더 필요하다.
        await new Promise((done) => setTimeout(done, 200));
        return true;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, gap));
  }
  return false;
}

// 터미널 탭 생성/이름(#6, #8): 생성은 셸 생성이라 원격(폰)에서 금지(AC5). 이름변경은 허용.
export function handleTab(ws, msg) {
  if (msg.type === "tab.create") {
    if (!ws._local) { ws.send(JSON.stringify({ type: "control-error", message: "원격에서는 터미널 탭 생성 불가(AC5)" })); return; }
    herdr.tabCreate(msg.workspaceId).then(async (res) => {
      // 생성 직후 이름 부여(#6): tab.create 반환에서 새 tab_id를 찾아 rename.
      const newId = res?.tab_id || res?.tab?.tab_id || res?.result?.tab_id;
      if (msg.name && typeof msg.name === "string" && newId) { try { await herdr.tabRename(newId, msg.name); } catch {} }
      // 새 탭에서 바로 세션을 실행한다. 탭을 만들고 명령을 입력하는 두 단계를 한 번으로 줄인다.
      // 실행 대상은 목록으로 제한한다. 임의 명령이 전달되면 원격 실행 경로가 된다.
      if (newId && LAUNCHERS[msg.launch]) {
        try {
          const panes = (await herdr.paneList(msg.workspaceId)).filter((pane) => pane.tab_id === newId);
          if (panes[0]) {
            await waitForShell(panes[0].pane_id);
            // 제출은 raw "\r" 로 한다. 이름있는 키로 보내면 글자만 입력되고 실행되지 않는다(확인 결과).
            await herdr.paneSendText(panes[0].pane_id, LAUNCHERS[msg.launch] + "\r");
          }
        } catch (e) {
          // 오류를 무시하면 명령만 입력된 탭이 남고 사용자는 이유를 알 수 없다.
          ws.send(JSON.stringify({ type: "control-error", message: `세션 실행 실패: ${e.message || e}` }));
        }
      }
      recompute();
    }).catch((e) => ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) })));
  } else if (msg.type === "tab.rename") {
    if (!msg.tabId || typeof msg.label !== "string") return;
    herdr.tabRename(msg.tabId, msg.label).then(() => recompute()).catch(() => {});
  } else if (msg.type === "tab.move") {
    // 순서 바꾸기는 원격에서도 안전하다(셸을 만들거나 종료하지 않는다). 이름 변경과 같은 경계다.
    if (!msg.tabId || !Number.isInteger(msg.index) || msg.index < 0) return;
    herdr.tabMove(msg.tabId, msg.index).then(() => recompute())
      .catch((e) => ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) })));
  }
}
