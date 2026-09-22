// herdr socket 클라이언트.
// 확인한 herdr 연결 모델:
//  - 일반 요청(agent.list, agent.send): 응답 후 herdr가 소켓을 닫는다 → 매 호출 새 연결.
//  - events.subscribe: 소켓 유지, push 스트림 → 전용 구독 소켓 1개.
//  - agent_status_changed(working↔idle)는 pane_id별 구독이라, 현재 pane 전체를 구독하고
//    pane 집합이 바뀌면 재구독한다. 전역 이벤트(pane.created 등)는 type만으로 구독.
import net from "node:net";
import { EventEmitter } from "node:events";
import { herdrSession } from "./herdr-session.cjs";

// 어느 세션의 소켓인지는 herdr-session.cjs 한 곳이 정한다. 여기서 경로를 다시 조합하면
// pty.js 가 연결하는 세션과 갈라져, 사이드바와 터미널이 서로 다른 세션을 본다.
const SOCK = herdrSession().socket;

// type만으로 구독 가능한 전역 이벤트 (pane_id 불필요).
const GLOBAL_SUBS = [
  "pane.created", "pane.closed", "pane.exited", "pane.agent_detected", "pane.focused",
  "workspace.created", "workspace.closed", "workspace.renamed", "tab.created", "tab.closed",
].map((type) => ({ type }));

export class HerdrClient extends EventEmitter {
  constructor() {
    super();
    this.subSock = null;
    this.subBuf = "";
    this.paneKey = ""; // 현재 구독 중인 pane 집합의 서명(재구독 판단용)
    this.reconnectTimer = null;
  }

  // 요청-응답: 매번 새 연결, 첫 응답 수신 후 종료.
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const c = net.connect(SOCK, () => {
        c.write(JSON.stringify({ id: "1", method, params }) + "\n");
      });
      let buf = "";
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        c.destroy();
        fn(arg);
      };
      c.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let msg;
        try {
          msg = JSON.parse(buf.slice(0, nl));
        } catch {
          return finish(reject, new Error("herdr bad response"));
        }
        if (msg.error) finish(reject, new Error(msg.error.message || "herdr error"));
        else finish(resolve, msg.result ?? msg);
      });
      c.on("error", (e) => finish(reject, e));
      setTimeout(() => finish(reject, new Error(`herdr timeout: ${method}`)), 5000);
    });
  }

  agentList() {
    return this.call("agent.list").then((r) => r.agents || []);
  }

  // Spaces(워크스페이스) 목록. 좌상단 사이드바용이다. {workspace_id, label, focused, agent_status, ...}
  workspaceList() {
    return this.call("workspace.list").then((r) => r.workspaces || []);
  }

  // 스페이스 생성. cwd를 반드시 넘긴다. 생략하면 herdr가 호출자(이 서버)의 cwd를 상속해
  // 의도하지 않은 폴더의 스페이스가 생긴다. 반환값에 workspace_id가 들어 있다.
  workspaceCreate({ cwd, label, focus } = {}) {
    const params = { focus: !!focus };
    if (cwd) params.cwd = String(cwd);
    if (label) params.label = String(label);
    return this.call("workspace.create", params);
  }
  // 스페이스 닫기. 그 안의 탭·pane·셸이 전부 종료된다(되돌릴 수 없다).
  workspaceClose(workspaceId) {
    return this.call("workspace.close", { workspace_id: workspaceId });
  }
  // 이 스페이스의 pane 목록. 스페이스의 폴더를 확실히 알 수 있는 유일한 경로다. workspace.list는
  // 폴더를 반환하지 않고, state의 folder는 에이전트 cwd에서 유추한 값이라 에이전트가 없으면 비어 있다.
  paneList(workspaceId) {
    return this.call("pane.list", workspaceId ? { workspace_id: workspaceId } : {}).then((r) => r.panes || []);
  }
  paneGet(paneId) {
    return this.call("pane.get", { pane_id: paneId }).then((r) => r.pane || r);
  }
  // pane 닫기. 보관에서 에이전트 하나만 종료할 때 쓴다. 그 pane의 셸이 끝나 메모리가 해제된다.
  paneClose(paneId) {
    return this.call("pane.close", { pane_id: paneId });
  }
  // 탭 목록/생성/이름변경. 에이전트 탭 이름 표시와 herdr 방식 터미널 탭 관리에 쓴다.
  tabList(workspaceId) {
    return this.call("tab.list", { workspace_id: workspaceId }).then((r) => r.tabs || []);
  }
  tabCreate(workspaceId) {
    return this.call("tab.create", workspaceId ? { workspace_id: workspaceId } : {});
  }
  tabRename(tabId, label) {
    return this.call("tab.rename", { tab_id: tabId, label });
  }
  // 탭 순서 이동. 사이드바에서 에이전트를 드래그해 옮길 때 쓴다. 에이전트와 탭이 1:1이라
  // 탭 순서가 곧 에이전트 순서다. 표시만 바꾸면 herdr 사이드바·키보드 이동과 일치하지 않는다.
  tabMove(tabId, insertIndex) {
    return this.call("tab.move", { tab_id: tabId, insert_index: insertIndex });
  }
  // 탭 포커스. 세션(에이전트) 없는 탭도 tab_id로 포커스할 수 있다(agent.focus는 pane_id/에이전트 전용).
  // 임베드된 herdr 세션의 attach 화면이 그 탭으로 전환된다 → 사용자가 그 탭에 직접 입력 가능.
  tabFocus(tabId) {
    return this.call("tab.focus", { tab_id: tabId });
  }
  // 탭 삭제. tab_id로 herdr 터미널 탭을 닫는다(그 탭의 pane/셸 종료).
  tabClose(tabId) {
    return this.call("tab.close", { tab_id: tabId });
  }

  // 사이드바에서 에이전트를 고르면 임베드된 herdr(같은 세션)를 그 pane으로 이동시킨다.
  // agent.focus {target: pane_id}. 같은 live 세션이라 attach된 PTY 화면이 그 에이전트로 전환된다.
  agentFocus(target) {
    return this.call("agent.focus", { target });
  }
  // on은 해당 pane으로 포커스를 옮기면서 한 pane만 표시한다. 반복 호출해도 분할 보기로 돌아가지 않는다.
  paneZoom(paneId, mode = "on") {
    return this.call("pane.zoom", { pane_id: paneId, mode });
  }
  workspaceFocus(workspaceId) {
    return this.call("workspace.focus", { workspace_id: workspaceId });
  }

  // 조종 블록: 채팅 send. 대상 세션(부모 pane)의 에이전트에 메시지를 전달한다.
  // target은 pane_id 문자열. agent.send는 herdr가 에이전트 입력으로 제출한다.
  agentSend(target, text) {
    return this.call("agent.send", { target, text });
  }

  // 조종 블록: 응답 읽기. pane의 터미널 내용이다. source: "recent"(스크롤백 포함) | "visible"(현재 화면).
  // format: "text" | "ansi"(SGR 색코드 유지, strip_ansi=false와 함께). 반환 result.read =
  // { text, revision, truncated }. revision 증가로 새 출력 감지.
  paneRead(paneId, source = "recent", format = "text", stripAnsi = true, lines = null) {
    const params = { pane_id: paneId, source, format, strip_ansi: stripAnsi };
    if (lines) params.lines = lines;
    return this.call("pane.read", { ...params }).then((r) => r.read || r);
  }

  // 실제 터미널 상호작용: send_text는 pane PTY에 원시 바이트를 그대로 넣는다(확인 결과: raw "\r"이
  // 명령을 제출한다). Enter=\r, Ctrl-C=\x03, 화살표=\x1b[A 등 이스케이프 시퀀스를 그대로 전달한다.
  // 명령을 실행하려면 "\r" 까지 함께 보낸다. 글자만 보내면 입력줄에 남는다.
  paneSendText(paneId, text) {
    return this.call("pane.send_text", { pane_id: paneId, text });
  }

  // 현재 pane 전체 + 전역 이벤트를 구독. pane 집합이 바뀌었으면 소켓을 새로 연다.
  async refreshSubscription() {
    let panes;
    try {
      const agents = await this.agentList();
      panes = agents.map((a) => a.pane_id).filter(Boolean).sort();
    } catch {
      return;
    }
    const key = panes.join(",");
    if (key === this.paneKey && this.subSock && !this.subSock.destroyed) return; // 변화 없음
    this.paneKey = key;
    this._openSubSocket(panes);
  }

  _openSubSocket(panes) {
    if (this.subSock) {
      this.subSock.removeAllListeners();
      this.subSock.destroy();
    }
    this.subBuf = "";
    const subs = [
      ...GLOBAL_SUBS,
      ...panes.map((p) => ({ type: "pane.agent_status_changed", pane_id: p })),
      ...panes.map((p) => ({ type: "pane.scroll_changed", pane_id: p })),
    ];
    const c = net.connect(SOCK, () => {
      c.write(JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions: subs } }) + "\n");
      this.emit("connect");
    });
    this.subSock = c;
    c.on("data", (d) => this._onSubData(d));
    c.on("error", () => {});
    c.on("close", () => {
      this.emit("close");
      // 재연결. herdr 재시작·업데이트 중에도 복구된다.
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.paneKey = ""; // 강제 재구독
        this.refreshSubscription();
      }, 1000);
    });
    // 변경 이벤트가 오기 전 첫 드래그도 정확한 시작 offset을 잡을 수 있게 현재값을 한 번 채운다.
    this.paneList().then((items) => {
      for (const pane of items || []) {
        if (pane?.pane_id && pane?.scroll) this.emit("event", {
          event: "pane.scroll_changed",
          data: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, scroll: pane.scroll },
        });
      }
    }).catch(() => {});
  }

  _onSubData(chunk) {
    this.subBuf += chunk.toString();
    let nl;
    while ((nl = this.subBuf.indexOf("\n")) >= 0) {
      const line = this.subBuf.slice(0, nl);
      this.subBuf = this.subBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // 구독 확인 응답(id:"sub")은 무시, 이후 이벤트만 emit.
      if (msg.id === "sub") continue;
      if (msg.error) continue;
      this.emit("event", msg);
    }
  }

  // 진입점: 구독을 시작한다.
  connect() {
    this.refreshSubscription();
  }
}
