// Paseo 앱이 여는 데몬 WebSocket 을 진입 파일 안에서 받는 가짜 데몬
//
// 유지 조건
//   SHIM_URL 로 여는 소켓만 받음. 다른 주소는 원래 WebSocket 으로 보냄
//   응답 형식은 Paseo 통신 규약(packages/protocol messages.ts). 모르는 요청은 rpc_error
//   에이전트 1개·워크스페이스 1개를 합성. 대화·상태는 부모 창(web/js/agentchat/boot.js)이 줌
//   보내기·중단은 부모 창에 postMessage 로 넘김(iris-chat.send·iris-chat.cancel)
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import { asUint8Array, decodeFileTransferFrame, FileTransferOpcode } from "@getpaseo/protocol/binary-frames/index";
import { CODEX_ONLY_MESSAGE, agentFields, answerRow, permissionRequest, providerEntries, type IrisAgentMeta, type IrisModelDefinition, type IrisPrompt } from "./iris-agent-meta";

export const SHIM_HOST = "iris-shim.invalid:80";
const SHIM_URL_PREFIX = `ws://${SHIM_HOST}/`;
export const SHIM_SERVER_ID = "iris";
export const SHIM_WORKSPACE_ID = "iris-workspace";
const PROTOCOL_VERSION = 1;
// Iris 서버 /agentchat-upload 상한과 같음
export const UPLOAD_LIMIT_BYTES = 30 * 1024 * 1024;

// 시험·개발에서만 보낸 메시지를 Paseo 검사기로 확인. 주소에 check=1 이 있거나 개발 빌드
const CHECK = (typeof __DEV__ !== "undefined" && __DEV__) || /[?&]check=1\b/.test(globalThis.location?.search || "");

export type ShimItem = { key: string; item: any; ts: number };
export interface ShimAgent {
  id: string;
  provider: string;
  cwd: string;
  title: string | null;
  running: boolean;
  // 지금 모델·effort·모드·사용량. 서브에이전트 보기 등 모르면 null
  meta?: IrisAgentMeta | null;
  codexModels?: IrisModelDefinition[] | null;
  // 터미널이 답을 기다리는 질문
  prompt?: IrisPrompt | null;
  // 지금 실행 중인 Claude 서브에이전트(부모 창이 아는 목록). Paseo 의 공급자 서브에이전트 줄로 보임
  subagents?: { id: string; description: string; agentType: string }[];
}
// 부모 창 쪽 동작. 진입 파일이 채움
// - key: 요청을 받은 때의 대화(pane) key. 업로드를 기다리는 동안 다른 대화로 바뀌어도 이 key 로 보냄
// - send: 부모에 넘기기 직전 실제로 보내는 글로 remember 를 불러야 대화 기록의 그 글이 보낸 행과 합쳐짐
export interface ShimHost {
  send(input: { key: string; id: string; text: string; images: { data: string; mimeType: string }[]; attachments: unknown[]; remember: (text: string) => void }): Promise<{ ok: boolean; reason?: string }>;
  cancel(key: string): void;
  loadOlder(): Promise<void>;
  commands?(key: string): Promise<{ commands: { name: string; description: string; argumentHint: string; kind?: string }[]; error?: string }>;
  files?(key: string, query: string): Promise<{ directories: string[]; entries: { path: string; kind: "file" | "directory" }[]; error?: string }>;
  // 모델·effort 변경 같은 터미널 명령 글. 대화 글이 아니므로 remember 를 거치지 않음
  command?(key: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  mode?(key: string, modeId: string): Promise<{ ok: boolean; reason?: string }>;
  answer?(key: string, promptId: string, row: number): Promise<{ ok: boolean; reason?: string }>;
  // AskUserQuestion 답(Paseo 질문 카드 answers, 키는 header). null 이면 닫기(Esc)
  answerQuestion?(key: string, promptId: string, answers: Record<string, string> | null): Promise<{ ok: boolean; reason?: string }>;
  upload?(input: { fileName: string; mimeType: string; bytes: Blob }): Promise<{ path: string; size: number; fileName: string }>;
}

// 보낸 글 하나. 보낸 대화, 보낸 때 기록에 있던 행 key 와 마지막 행 key 를 함께 저장
type SentMark = { text: string; id: string; agent: string; seen: Set<string>; lastKey: string | null; at: number };

type Row = { key: string; item: any; ts: number; seqStart: number; seqEnd: number; sig: string };

// 처음 seq. 앞쪽(이전 대화)이 붙으면 아래로 내려가며 번호를 줌
const SEQ_BASE = 1_000_000;

class ShimDaemon {
  host: ShimHost | null = null;
  agent: ShimAgent | null = null;
  hasOlder = false;
  private rows: Row[] = [];
  private epoch = newEpoch();
  // 마지막으로 발급한 seq. 새 행·도구 갱신 모두 issueSeq 로만 받음(같은 번호를 두 번 주면 앱이 뒤엣것을 버림)
  private lastSeq = SEQ_BASE - 1;
  private minSeq = SEQ_BASE;
  private sockets = new Set<ShimSocket>();
  private createdAt = new Date().toISOString();
  private turnId: string | null = null;
  private turnStartedAt: string | null = null;
  private olderWaiters: (() => void)[] = [];
  // 아직 기록 행과 짝짓지 못한 보낸 글. 짝지으면 목록에서 뺌
  private pending: SentMark[] = [];
  // Iris 메시지 id → 대화 기록에 실제로 쓴 messageId(보낸 글이면 Paseo 의 id). 한 번 정하면 유지
  readonly messageIds = new Map<string, string>();
  // 앱에 보여 준 모델 목록의 Codex 쪽. 부모가 null 을 보내도(서브에이전트 보기 등) 마지막 값을 유지
  private codexModels: IrisModelDefinition[] | null = null;
  private providersSig = "";
  private metaSig = "";
  // 앱에 권한 요청으로 보낸 질문. 앱이 답한 id 는 질문이 사라질 때까지 다시 보내지 않음
  private shownPrompt: IrisPrompt | null = null;
  private shownPromptSig = "";
  private answeredPromptId: string | null = null;
  // 앱에 보여 준 서브에이전트 id → 내용 서명. 에이전트 목록(fetch_agents)에는 섞지 않고 전용 메시지로만 보냄
  private shownSubagents = new Map<string, string>();
  private subagentParent = "";
  private subagentCreated = new Map<string, string>();

  setAgent(next: ShimAgent, items: ShimItem[], hasOlder: boolean, loadingOlder: boolean) {
    const prev = this.agent;
    const switched = !prev || prev.id !== next.id;
    // 이전 대화가 새로 생기면 앱은 대화 기록을 다시 받아야 앎. epoch 를 바꿔 다시 받게 함
    const olderAppeared = !switched && hasOlder && !this.hasOlder;
    this.agent = next;
    this.hasOlder = hasOlder;
    if (next.codexModels) this.codexModels = next.codexModels;
    if (switched) {
      this.rows = [];
      this.epoch = newEpoch();
      this.resetSeq();
      this.turnId = null;
      this.messageIds.clear();
    }
    if (next.running && !this.turnId) {
      this.turnId = `iris-turn-${Date.now().toString(36)}`;
      this.turnStartedAt = new Date().toISOString();
      if (!switched) this.broadcastStream({ type: "turn_started", provider: next.provider, turnId: this.turnId });
    }
    this.applyItems(this.withSentIds(items), switched);
    if (olderAppeared) { this.epoch = newEpoch(); this.replace(); }
    if (!next.running && this.turnId) {
      const turnId = this.turnId;
      this.turnId = null;
      this.turnStartedAt = null;
      if (!switched) this.broadcastStream({ type: "turn_completed", provider: next.provider, turnId });
    }
    this.syncPrompt(prev, switched);
    this.syncProviders();
    this.syncSubagents(switched);
    const metaSig = JSON.stringify([agentFields(next.provider, next.meta ?? null), this.shownPrompt?.id ?? null]);
    const metaChanged = metaSig !== this.metaSig;
    this.metaSig = metaSig;
    if (switched || metaChanged || prev?.running !== next.running || prev?.title !== next.title || prev?.cwd !== next.cwd) this.broadcastAgentUpdate();
    if (!loadingOlder) {
      const waiters = this.olderWaiters;
      this.olderWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  // 보낸 글과 기록의 사용자 행 짝짓기
  // - 보낸 때 기록 끝(lastKey) 뒤에 새로 생긴 사용자 행 하나에만 대응. 짝지은 보낸 글은 목록에서 뺌
  // - 같은 글을 여러 번 보내도 앞의 기록 행이 새로 보낸 글과 합쳐지지 않음
  // - 앞뒤 공백·줄바꿈은 비교에서 뺌(터미널이 붙여넣기 앞뒤에 줄바꿈을 더해 저장)
  private withSentIds(items: ShimItem[]): ShimItem[] {
    return items.map((r, idx) => {
      if (r.item.type !== "user_message") return r;
      let id = this.messageIds.get(r.key);
      if (!id) {
        const n = this.pending.findIndex((s) => s.agent === this.agent?.id && s.text.trim() === String(r.item.text ?? "").trim() && !s.seen.has(r.key)
          && (s.lastKey === null || idx > items.findIndex((x) => x.key === s.lastKey)));
        if (n < 0) return r;
        id = this.pending[n].id;
        this.pending.splice(n, 1);
        this.messageIds.set(r.key, id);
      }
      return { ...r, item: { ...r.item, messageId: id, clientMessageId: id } };
    });
  }

  // 보내기 요청을 받은 때 그 대화의 기록 상태. 업로드가 끝난 뒤 rememberSent 에 넘김
  // - 보낸 글은 대화마다 따로. 보내는 중에 다른 대화로 갔다 와도 짝을 짓게 대화를 바꿀 때 비우지 않음
  markSend(agent: string): Omit<SentMark, "text" | "id" | "at"> {
    if (this.agent?.id !== agent) return { agent, seen: new Set(), lastKey: null };
    return { agent, seen: new Set(this.rows.map((r) => r.key)), lastKey: this.rows[this.rows.length - 1]?.key ?? null };
  }

  rememberSent(text: string, id: string, mark: Omit<SentMark, "text" | "id" | "at">) {
    this.pending.push({ text, id, ...mark, at: Date.now() });
    if (this.pending.length > 50) this.pending.shift();
  }

  // 아직 기록 행과 짝짓지 못한 보낸 글. 터미널 입력줄로 되돌아왔는지 볼 때
  sentNotSeen(): { id: string; text: string; at: number }[] {
    return this.pending.map((s) => ({ id: s.id, text: s.text, at: s.at }));
  }

  forgetSent(id: string) {
    this.pending = this.pending.filter((s) => s.id !== id);
  }

  private resetSeq() {
    this.lastSeq = SEQ_BASE - 1;
    this.minSeq = SEQ_BASE;
  }

  private issueSeq() {
    return ++this.lastSeq;
  }

  // 새 목록을 지금 행과 맞춤
  // - 지금 행이 새 목록 가운데 그대로 이어져 있으면 앞쪽은 이전 대화, 뒤쪽은 새 행
  // - 맞지 않으면 새 epoch 로 갈아 끼우고 앱에 다시 받으라고 알림
  private applyItems(items: ShimItem[], fresh: boolean) {
    const sig = (r: ShimItem) => JSON.stringify(r.item);
    if (fresh || this.rows.length === 0) {
      const replaced = this.rows.length > 0;
      this.rows = [];
      this.resetSeq();
      for (const r of items) this.rows.push(this.row(r, sig(r)));
      if (replaced) this.replace();
      else if (!fresh) for (const row of this.rows) this.broadcastRow(row);
      return;
    }
    const start = items.findIndex((r) => r.key === this.rows[0].key);
    const aligned = start >= 0 && this.rows.every((row, k) => items[start + k]?.key === row.key);
    if (!aligned) {
      this.epoch = newEpoch();
      this.rows = [];
      this.resetSeq();
      for (const r of items) this.rows.push(this.row(r, sig(r)));
      this.replace();
      return;
    }
    // 이미 보낸 행의 글이 바뀜(도구 결과 도착 등). 도구 호출은 같은 callId 로 다시 보내면 앱이 갈아 끼움
    // - 글 행은 앱이 이어 붙이므로 다시 보내지 않고 epoch 를 바꿔 새로 받게 함
    let needsReplace = false;
    this.rows.forEach((row, k) => {
      const r = items[start + k];
      const s = sig(r);
      if (s === row.sig) return;
      if (r.item.type !== "tool_call") { needsReplace = true; return; }
      row.item = r.item; row.sig = s; row.ts = r.ts;
      row.seqEnd = this.issueSeq();
      this.broadcastRow(row);
    });
    const older = items.slice(0, start).reverse();
    for (const r of older) {
      const seq = --this.minSeq;
      this.rows.unshift({ key: r.key, item: r.item, ts: r.ts, seqStart: seq, seqEnd: seq, sig: sig(r) });
    }
    for (const r of items.slice(start + this.rows.length - older.length)) {
      const row = this.row(r, sig(r));
      this.rows.push(row);
      this.broadcastRow(row);
    }
    if (needsReplace) {
      this.epoch = newEpoch();
      this.rows = [];
      this.resetSeq();
      for (const r of items) this.rows.push(this.row(r, sig(r)));
      this.replace();
    }
  }

  private row(r: ShimItem, sig: string): Row {
    const seq = this.issueSeq();
    return { key: r.key, item: r.item, ts: r.ts, seqStart: seq, seqEnd: seq, sig };
  }

  private replace() {
    if (!this.agent) return;
    for (const s of this.sockets) {
      if (s.timelineSub) s.push({ type: "agent.timeline.replacement", payload: { subscriptionId: s.timelineSub, agentId: this.agent.id, epoch: this.epoch } });
    }
  }

  private broadcastRow(row: Row) {
    if (!this.agent) return;
    for (const s of this.sockets) {
      if (!s.timelineSub) continue;
      s.push({ type: "agent_stream", payload: {
        subscriptionId: s.timelineSub, agentId: this.agent.id,
        event: { type: "timeline", provider: this.agent.provider, item: row.item, ...(this.turnId ? { turnId: this.turnId } : {}) },
        timestamp: new Date(row.ts).toISOString(), seq: row.seqEnd, epoch: this.epoch,
      } });
    }
  }

  private broadcastStream(event: any) {
    if (!this.agent) return;
    for (const s of this.sockets) {
      if (!s.timelineSub) continue;
      s.push({ type: "agent_stream", payload: { subscriptionId: s.timelineSub, agentId: this.agent.id, event, timestamp: new Date().toISOString() } });
    }
  }

  private broadcastAgentUpdate() {
    const agent = this.snapshot();
    if (!agent) return;
    for (const s of this.sockets) {
      if (s.agentsSub) s.push({ type: "agent_update", payload: { subscriptionId: s.agentsSub, kind: "upsert", agent, project: this.project() } });
      if (s.workspacesSub) s.push({ type: "workspace_update", payload: { subscriptionId: s.workspacesSub, kind: "upsert", workspace: this.workspace() } });
    }
  }

  // 앱에 보일 질문. 앱이 이미 답한 질문은 사라질 때까지 숨김
  private visiblePrompt(): IrisPrompt | null {
    const p = this.agent?.prompt;
    if (!p || (!p.options?.length && !p.questions?.length)) return null;
    return p.id === this.answeredPromptId ? null : p;
  }

  // 질문이 바뀌면 이전 요청을 해소하고 새 요청을 보냄. 터미널에서 먼저 답해 사라진 경우도 해소
  private syncPrompt(prev: ShimAgent | null, switched: boolean) {
    if (this.agent?.prompt?.id !== this.answeredPromptId) this.answeredPromptId = null;
    const now = this.visiblePrompt();
    const sig = now ? JSON.stringify(permissionRequest(this.agent!.provider, now)) : "";
    // 같은 질문이어도 화면 줄은 바뀜. 답할 때 쓰는 줄 번호는 늘 지금 화면 값으로
    if (now && this.shownPrompt?.id === now.id) this.shownPrompt = now;
    if (sig === this.shownPromptSig) return;
    const before = this.shownPrompt;
    this.shownPrompt = now;
    this.shownPromptSig = sig;
    const agentId = switched ? prev?.id : this.agent?.id;
    if (before && agentId && (!now || now.id !== before.id)) {
      this.broadcast({ type: "agent_permission_resolved", payload: { agentId, requestId: before.id, resolution: { behavior: "deny", message: "터미널에서 처리됨" } } });
    }
    if (now && this.agent) this.broadcast({ type: "agent_permission_request", payload: { agentId: this.agent.id, request: permissionRequest(this.agent.provider, now) } });
  }

  subagentDescriptors() {
    const a = this.agent;
    if (!a) return [];
    return (a.subagents ?? []).map((x) => {
      const created = this.subagentCreated.get(x.id) ?? new Date().toISOString();
      this.subagentCreated.set(x.id, created);
      return {
        id: x.id, parentAgentId: a.id, parentSubagentId: null, provider: a.provider, title: x.agentType || null, description: x.description || null,
        status: "running" as const, createdAt: created, updatedAt: created, toolCallId: null, cwd: a.cwd || null, subtitle: null,
      };
    });
  }

  // 서브에이전트 목록이 바뀌면 추가·갱신은 upsert, 사라진 것은 remove
  private syncSubagents(switched: boolean) {
    const a = this.agent;
    if (!a) return;
    if (switched && this.subagentParent) {
      for (const id of this.shownSubagents.keys()) this.broadcast({ type: "agent.provider_subagents.update", payload: { kind: "remove", parentAgentId: this.subagentParent, subagentId: id } });
      this.shownSubagents.clear();
      this.subagentCreated.clear();
    }
    this.subagentParent = a.id;
    const next = new Map(this.subagentDescriptors().map((d) => [d.id, JSON.stringify(d)]));
    for (const [id, sig] of next) {
      if (this.shownSubagents.get(id) === sig) continue;
      this.broadcast({ type: "agent.provider_subagents.update", payload: { kind: "upsert", subagent: JSON.parse(sig) } });
    }
    for (const id of this.shownSubagents.keys()) {
      if (!next.has(id)) {
        this.subagentCreated.delete(id);
        this.broadcast({ type: "agent.provider_subagents.update", payload: { kind: "remove", parentAgentId: a.id, subagentId: id } });
      }
    }
    this.shownSubagents = next;
  }

  // 앱이 모델 목록을 요청한 cwd. 목록이 바뀌면 이 cwd 들에 모두 알림
  snapshotCwds = new Set<string>();

  // Codex 모델 목록이 생기거나 바뀌면 앱의 모델 목록을 갱신
  // - 선택기는 cwd 별 캐시를 읽음. cwd 없는 알림은 홈 캐시에만 들어가므로 요청이 왔던 cwd 마다 보냄
  private syncProviders() {
    const entries = providerEntries(this.codexModels, "");
    const sig = JSON.stringify(entries);
    if (sig === this.providersSig) return;
    const first = this.providersSig === "";
    this.providersSig = sig;
    if (first) return;
    const now = new Date().toISOString();
    const cwds = new Set([...this.snapshotCwds, ...(this.agent?.cwd ? [this.agent.cwd] : [])]);
    for (const s of this.sockets) for (const cwd of [null, ...cwds]) {
      s.push({ type: "providers_snapshot_update", payload: { entries: providerEntries(this.codexModels, now), generatedAt: now, ...(cwd ? { cwd } : {}) } });
    }
  }

  providers() {
    return providerEntries(this.codexModels, this.createdAt);
  }

  private broadcast(message: any) {
    for (const s of this.sockets) s.push(message);
  }

  // 앱이 권한 카드에서 고른 답 → 터미널 선택지. 성공하면 앱에 해소를 알림
  async respondPermission(agentId: string, requestId: string, response: any): Promise<string | null> {
    const prompt = this.shownPrompt;
    if (!prompt || prompt.id !== requestId || !this.agent || this.agent.id !== agentId) return "이미 처리된 요청입니다";
    const host = this.host;
    if (!host?.answer) return "Iris 창과 연결되지 않았습니다";
    let res: { ok: boolean; reason?: string };
    if (prompt.questions?.length) {
      // 질문 카드 답은 선택지 줄로 바꾸지 않음(answerRow 는 첫 허용 선택지를 누름)
      if (!host.answerQuestion) return "Iris 창과 연결되지 않았습니다";
      const dismiss = response?.behavior === "deny";
      const answers = response?.updatedInput?.answers;
      if (!dismiss && (!answers || typeof answers !== "object")) return "모든 질문에 답해 주세요";
      res = await host.answerQuestion(agentId, requestId, dismiss ? null : answers);
    } else {
      const row = answerRow(prompt, response ?? {});
      if (row === null) return "고를 선택지가 없습니다";
      res = await host.answer(agentId, requestId, row);
    }
    if (!res.ok) return res.reason || "답을 보내지 못했습니다";
    this.answeredPromptId = requestId;
    this.shownPrompt = null;
    this.shownPromptSig = "";
    this.metaSig = "";
    this.broadcast({ type: "agent_permission_resolved", payload: { agentId, requestId, resolution: response } });
    this.broadcastAgentUpdate();
    return null;
  }

  attach(s: ShimSocket) { this.sockets.add(s); }
  detach(s: ShimSocket) { this.sockets.delete(s); }

  snapshot() {
    const a = this.agent;
    if (!a) return null;
    return {
      id: a.id, provider: a.provider, cwd: a.cwd || "/", workspaceId: SHIM_WORKSPACE_ID, ...agentFields(a.provider, a.meta ?? null),
      createdAt: this.createdAt, updatedAt: new Date().toISOString(), lastUserMessageAt: null,
      status: a.running ? "running" : "idle",
      activeTurn: a.running && this.turnId ? { turnId: this.turnId, startedAt: this.turnStartedAt } : null,
      capabilities: {
        supportsStreaming: true, supportsSessionPersistence: false, supportsDynamicModes: false, supportsMcpServers: false,
        supportsReasoningStream: true, supportsToolInvocations: true,
        supportsRewindConversation: false, supportsRewindFiles: false, supportsRewindBoth: false,
      },
      pendingPermissions: this.shownPrompt ? [permissionRequest(a.provider, this.shownPrompt)] : [], persistence: null,
      title: a.title, labels: {},
    };
  }

  project() {
    const cwd = this.agent?.cwd || "/";
    return { projectKey: cwd, projectName: baseName(cwd), workspaceName: null, checkout: { cwd, isGit: false, currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false, mainRepoRoot: null } };
  }

  workspace() {
    const cwd = this.agent?.cwd || "/";
    return {
      id: SHIM_WORKSPACE_ID, projectId: cwd, projectDisplayName: baseName(cwd), projectRootPath: cwd, workspaceDirectory: cwd,
      projectKind: "directory", workspaceKind: "directory", name: baseName(cwd),
      status: this.agent?.running ? "running" : "done", activityAt: null, scripts: [], gitRuntime: null, githubRuntime: null,
    };
  }

  // fetch_agent_timeline_request 응답 본문
  // - tail: 끝에서 limit 개. before: cursor 앞쪽 limit 개, 모자라면 부모에 이전 대화를 받아 옴. after: cursor 뒤 전부
  async timeline(req: any) {
    const agent = this.snapshot();
    const direction = req.direction ?? "tail";
    const limit = typeof req.limit === "number" && req.limit > 0 ? req.limit : 40;
    const cursor = req.cursor && req.cursor.epoch === this.epoch ? req.cursor : null;
    const staleCursor = !!req.cursor && !cursor;
    let picked: Row[];
    let reset = false;
    if (direction === "before" && cursor) {
      let idx = this.rows.findIndex((r) => r.seqStart >= cursor.seq);
      if (idx < 0) idx = this.rows.length;
      if (idx < limit && this.hasOlder && this.host) {
        // 부모가 답하지 않으면 host.loadOlder 의 제한 시간 뒤 지금 있는 행으로 답함
        await new Promise<void>((resolve) => { this.olderWaiters.push(resolve); void this.host!.loadOlder().then(resolve); });
        idx = this.rows.findIndex((r) => r.seqStart >= cursor.seq);
        if (idx < 0) idx = this.rows.length;
      }
      picked = this.rows.slice(Math.max(0, idx - limit), idx);
    } else if (direction === "after" && cursor) {
      picked = this.rows.filter((r) => r.seqEnd > cursor.seq);
    } else {
      picked = this.rows.slice(-limit);
      reset = direction !== "tail" || staleCursor;
    }
    const first = picked[0];
    const last = picked[picked.length - 1];
    const minSeq = this.rows[0]?.seqStart ?? this.lastSeq + 1;
    const maxSeq = Math.max(this.lastSeq, 0);
    const firstIdx = first ? this.rows.indexOf(first) : this.rows.length;
    return {
      agentId: this.agent?.id ?? req.agentId, agent, direction, projection: req.projection === "canonical" ? "canonical" : "projected",
      epoch: this.epoch, reset, staleCursor, gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      startCursor: first ? { epoch: this.epoch, seq: first.seqStart } : (cursor ?? null),
      endCursor: last ? { epoch: this.epoch, seq: last.seqEnd } : (cursor ?? null),
      hasOlder: firstIdx > 0 || this.hasOlder, hasNewer: false,
      entries: picked.map((r) => ({
        provider: this.agent?.provider ?? "claude", item: r.item, timestamp: new Date(r.ts).toISOString(),
        seqStart: r.seqStart, seqEnd: r.seqEnd, sourceSeqRanges: [{ startSeq: r.seqStart, endSeq: r.seqEnd }], collapsed: [],
        ...(this.turnId && r === last ? { turnId: this.turnId } : {}),
      })),
      error: null,
    };
  }

}

export const shimDaemon = new ShimDaemon();

function newEpoch() {
  return `iris-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseName(p: string) {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p || "/";
}

let subCounter = 0;
const nextSub = (kind: string) => `iris-${kind}-${++subCounter}`;

// 브라우저 WebSocket 처럼 보이는 객체. Paseo 전송 계층은 addEventListener·send·close·readyState 만 씀
class ShimSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  protocol = "";
  extensions = "";
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  timelineSub: string | null = null;
  agentsSub: string | null = null;
  workspacesSub: string | null = null;
  // 받는 중인 파일. requestId → 요청 정보와 지금까지 받은 조각
  private uploads = new Map<string, { fileName: string; mimeType: string; size: number; received: number; chunks: Uint8Array[]; failed: string | null }>();

  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      shimDaemon.attach(this);
      this.fire(new Event("open"));
    }, 0);
  }

  private fire(e: Event) {
    this.dispatchEvent(e);
    const handler = (this as any)[`on${e.type}`];
    if (typeof handler === "function") handler.call(this, e);
  }

  send(data: unknown) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    // 글 프레임과 2진 프레임을 같은 순서로 처리하려고 둘 다 microtask 로 넘김
    if (typeof data !== "string") {
      const bytes = asUint8Array(data as any);
      if (bytes) {
        const copy = bytes.slice();
        queueMicrotask(() => this.receiveBinary(copy));
      }
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    queueMicrotask(() => { void this.receive(msg); });
  }

  // 파일 올리기 조각(Paseo binary-frames file-transfer). 끝 조각에서 Iris 서버로 올리고 file.upload.response
  private receiveBinary(bytes: Uint8Array) {
    const frame = decodeFileTransferFrame(bytes);
    if (!frame) return;
    const up = this.uploads.get(frame.requestId);
    if (!up) return;
    if (frame.opcode === FileTransferOpcode.FileChunk && !up.failed) {
      up.received += frame.payload.byteLength;
      if (up.received > UPLOAD_LIMIT_BYTES) { up.failed = "파일이 30MB 를 넘습니다"; up.chunks = []; }
      else up.chunks.push(frame.payload.slice());
      return;
    }
    if (frame.opcode !== FileTransferOpcode.FileEnd) return;
    this.uploads.delete(frame.requestId);
    void this.finishUpload(frame.requestId, up);
  }

  private async finishUpload(requestId: string, up: { fileName: string; mimeType: string; size: number; received: number; chunks: Uint8Array[]; failed: string | null }) {
    const fail = (error: string) => this.reply("file.upload.response", { requestId, file: null, error });
    if (up.failed) return fail(up.failed);
    const host = shimDaemon.host;
    if (!host?.upload) return fail("Iris 창과 연결되지 않았습니다");
    try {
      const res = await host.upload({ fileName: up.fileName, mimeType: up.mimeType, bytes: new Blob(up.chunks as BlobPart[], { type: up.mimeType }) });
      this.reply("file.upload.response", { requestId, error: null, file: {
        type: "uploaded_file", id: `iris-upload-${requestId}`, fileName: res.fileName || up.fileName, mimeType: up.mimeType, size: res.size ?? up.received, path: res.path,
      } });
    } catch (e) {
      fail(String((e as any)?.message || e));
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    shimDaemon.detach(this);
    setTimeout(() => this.fire(Object.assign(new Event("close"), { code, reason, wasClean: true })), 0);
  }

  // 세션 메시지 하나를 봉투에 넣어 보냄
  push(message: any) {
    this.write({ type: "session", message });
  }

  private write(frame: any) {
    if (this.readyState !== 1) return;
    if (CHECK) {
      const result = validateWSOutboundMessage(frame);
      if (!result.success) console.error(`[iris-shim] 규약과 다른 메시지 ${frame?.message?.type ?? frame?.type}: ${String((result as any).error?.message ?? "").replace(/\s+/g, " ").slice(0, 1500)}`);
      // 시험에서 보낸 프레임을 확인하는 기록. 최근 2000개
      const log = ((globalThis as any).__irisShimFrames ??= []);
      log.push(frame);
      if (log.length > 2000) log.shift();
    }
    const text = JSON.stringify(frame);
    setTimeout(() => this.fire(new MessageEvent("message", { data: text })), 0);
  }

  private async receive(msg: any) {
    if (msg?.type === "hello") {
      this.push({ type: "status", payload: serverInfo() });
      return;
    }
    if (msg?.type === "ping") { this.write({ type: "pong" }); return; }
    if (msg?.type !== "session" || !msg.message) return;
    const m = msg.message;
    if (CHECK) console.debug(`[iris-shim] 요청 ${m.type}${m.direction ? ` ${m.direction} ${JSON.stringify(m.cursor ?? null)} ${m.limit ?? ""}` : ""}`);
    try {
      await this.handle(m);
    } catch (e) {
      if (m.requestId) this.reply("rpc_error", { requestId: m.requestId, requestType: m.type, error: String((e as any)?.message || e) });
    }
  }

  private reply(type: string, payload: any) {
    this.push({ type, payload });
  }

  // 모델·effort 변경: 터미널과 같게 "/model <id>"·"/effort <수준>" 글을 보냄
  // - effort 의 off·ultracode·기본값(null)은 Claude 터미널 명령에 대응하는 값이 없음
  private async changeTerminalSetting(kind: "model" | "effort", value: string | null, agentId: string): Promise<{ accepted: boolean; error: string | null }> {
    const agent = shimDaemon.agent;
    const host = shimDaemon.host;
    if (!agent || agent.id !== agentId || !host?.command) return { accepted: false, error: "Iris 창과 연결되지 않았습니다" };
    if (agent.provider !== "claude") return { accepted: false, error: CODEX_ONLY_MESSAGE };
    if (!value) return { accepted: false, error: kind === "model" ? "기본 모델로 되돌릴 수 없습니다" : "기본 effort 로 되돌릴 수 없습니다" };
    if (kind === "effort" && (value === "off" || value === "ultracode")) return { accepted: false, error: "터미널에서 지원하지 않는 값입니다" };
    if (/\s/.test(value)) return { accepted: false, error: "잘못된 값입니다" };
    const res = await host.command(agentId, `/${kind} ${value}`);
    return { accepted: !!res.ok, error: res.ok ? null : (res.reason || "보내지 못했습니다") };
  }

  private async handle(m: any) {
    const requestId = m.requestId;
    const agentId = shimDaemon.agent?.id ?? "";
    switch (m.type) {
      case "ping": {
        const now = Date.now();
        this.reply("pong", { requestId, ...(typeof m.clientSentAt === "number" ? { clientSentAt: m.clientSentAt } : {}), serverReceivedAt: now, serverSentAt: now });
        return;
      }
      case "client_heartbeat":
      case "register_push_token":
      case "recording_state":
        return;
      case "clear_agent_attention": {
        const agent = shimDaemon.snapshot();
        if (requestId) this.reply("clear_agent_attention_response", { requestId, agentId: m.agentId, agents: agent ? [agent] : [] });
        return;
      }
      case "session.events.set_subscription.request":
        this.reply("session.events.set_subscription.response", { requestId, subscriptionId: nextSub("events") });
        return;
      case "subscription.release.request":
        if (m.subscriptionId === this.timelineSub) this.timelineSub = null;
        if (m.subscriptionId === this.agentsSub) this.agentsSub = null;
        if (m.subscriptionId === this.workspacesSub) this.workspacesSub = null;
        this.reply("subscription.release.response", { requestId, subscriptionId: m.subscriptionId });
        return;
      case "agent.timeline.set_subscription.request": {
        this.timelineSub = nextSub("timeline");
        this.reply("agent.timeline.set_subscription.response", { requestId, agentIds: m.agentIds ?? [], subscriptionId: this.timelineSub });
        return;
      }
      case "fetch_workspaces_request": {
        const subscriptionId = m.subscribe ? (this.workspacesSub = nextSub("workspaces")) : null;
        this.reply("fetch_workspaces_response", {
          requestId, subscriptionId, entries: shimDaemon.agent ? [shimDaemon.workspace()] : [], emptyProjects: [],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        });
        return;
      }
      case "fetch_agents_request": {
        const subscriptionId = m.subscribe ? (this.agentsSub = nextSub("agents")) : null;
        const agent = shimDaemon.snapshot();
        this.reply("fetch_agents_response", {
          requestId, subscriptionId, entries: agent ? [{ agent, project: shimDaemon.project() }] : [],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        });
        return;
      }
      case "fetch_agent_request": {
        const agent = shimDaemon.snapshot();
        const hit = agent && m.agentId === agent.id;
        this.reply("fetch_agent_response", { requestId, agent: hit ? agent : null, project: hit ? shimDaemon.project() : null, error: hit ? null : `Agent not found: ${m.agentId}` });
        return;
      }
      case "fetch_agent_timeline_request": {
        const body = await shimDaemon.timeline(m);
        this.reply("fetch_agent_timeline_response", { requestId, ...body });
        return;
      }
      case "send_agent_message_request": {
        const host = shimDaemon.host;
        const id = String(m.messageId || requestId);
        if (!host) { this.reply("send_agent_message_response", { requestId, agentId: m.agentId, accepted: false, error: "Iris 창과 연결되지 않았습니다" }); return; }
        const mark = shimDaemon.markSend(String(m.agentId));
        const res = await host.send({
          key: String(m.agentId), id, text: String(m.text ?? ""), images: Array.isArray(m.images) ? m.images : [], attachments: Array.isArray(m.attachments) ? m.attachments : [],
          remember: (text) => shimDaemon.rememberSent(text, id, mark),
        });
        // 실패한 글은 짝 목록에서 뺌. 남겨 두면 다음에 같은 글을 보낼 때 그 기록 행을 이 글이 가져감
        if (!res.ok) shimDaemon.forgetSent(id);
        this.reply("send_agent_message_response", { requestId, agentId: m.agentId, accepted: !!res.ok, error: res.ok ? null : (res.reason || "보내지 못했습니다") });
        return;
      }
      case "cancel_agent_request":
        shimDaemon.host?.cancel(String(m.agentId));
        this.reply("cancel_agent_response", { requestId, agentId: m.agentId, agent: shimDaemon.snapshot(), error: null });
        return;
      case "list_commands_request": {
        const host = shimDaemon.host;
        if (!host?.commands) break;
        const res = await host.commands(String(m.agentId ?? agentId));
        this.reply("list_commands_response", {
          requestId, agentId: m.agentId ?? agentId, error: res.error ?? null,
          commands: res.commands.map((c) => ({ name: c.name.replace(/^\//, ""), description: c.description || "", argumentHint: c.argumentHint || "", kind: c.kind === "skill" ? "skill" : "command" })),
        });
        return;
      }
      case "directory_suggestions_request": {
        const host = shimDaemon.host;
        if (!host?.files) break;
        const res = await host.files(agentId, String(m.query ?? ""));
        this.reply("directory_suggestions_response", { requestId, directories: res.directories ?? [], entries: res.entries ?? [], error: res.error ?? null });
        return;
      }
      case "agent.provider_subagents.list.request":
        this.reply("agent.provider_subagents.list.response", {
          requestId, parentAgentId: m.parentAgentId,
          subagents: shimDaemon.agent && m.parentAgentId === shimDaemon.agent.id ? shimDaemon.subagentDescriptors() : [], error: null,
        });
        return;
      case "get_providers_snapshot_request":
        if (typeof m.cwd === "string" && m.cwd) shimDaemon.snapshotCwds.add(m.cwd);
        this.reply("get_providers_snapshot_response", { requestId, ...(m.cwd ? { cwd: m.cwd } : {}), entries: shimDaemon.providers(), generatedAt: new Date().toISOString() });
        return;
      // 목록은 정적 정의와 부모가 준 값이라 새로 읽을 것이 없음
      case "refresh_providers_snapshot_request":
        this.reply("refresh_providers_snapshot_response", { requestId, acknowledged: true });
        return;
      case "set_agent_model_request": {
        const r = await this.changeTerminalSetting("model", m.modelId, m.agentId);
        this.reply("set_agent_model_response", { requestId, agentId: m.agentId, ...r });
        return;
      }
      case "set_agent_thinking_request": {
        const r = await this.changeTerminalSetting("effort", m.thinkingOptionId, m.agentId);
        this.reply("set_agent_thinking_response", { requestId, agentId: m.agentId, ...r });
        return;
      }
      case "set_agent_mode_request": {
        const host = shimDaemon.host;
        const provider = shimDaemon.agent?.provider;
        let r: { accepted: boolean; error: string | null } = { accepted: false, error: "Iris 창과 연결되지 않았습니다" };
        if (provider === "codex") r = { accepted: false, error: CODEX_ONLY_MESSAGE };
        else if (host?.mode) {
          const res = await host.mode(String(m.agentId), String(m.modeId));
          r = { accepted: !!res.ok, error: res.ok ? null : (res.reason || "모드를 바꾸지 못했습니다") };
        }
        this.reply("set_agent_mode_response", { requestId, agentId: m.agentId, ...r });
        return;
      }
      case "agent_permission_response": {
        const error = await shimDaemon.respondPermission(String(m.agentId), String(m.requestId), m.response);
        if (error) this.reply("rpc_error", { requestId: m.requestId, requestType: m.type, error });
        return;
      }
      case "file.upload.request": {
        const size = Number(m.size) || 0;
        if (size > UPLOAD_LIMIT_BYTES) { this.reply("file.upload.response", { requestId, file: null, error: "파일이 30MB 를 넘습니다" }); return; }
        this.uploads.set(requestId, { fileName: String(m.fileName || "file"), mimeType: String(m.mimeType || "application/octet-stream"), size, received: 0, chunks: [], failed: null });
        return;
      }
      // /exit·/clear 의 보관 요청. 진입 파일이 입력창 단계에서 그 글을 터미널로 보내므로 여기까지 오면 거절
      // - 성공으로 답하면 앱이 이 대화를 보관된 것으로 표시함
      case "archive_agent_request":
        this.reply("rpc_error", { requestId, requestType: m.type, error: "Iris 에서는 대화를 보관하지 않습니다", code: "unsupported" });
        return;
    }
    if (requestId) this.reply("rpc_error", { requestId, requestType: m.type, error: `Iris 에서 지원하지 않는 요청: ${m.type}`, code: "unsupported" });
  }
}

function serverInfo() {
  return {
    status: "server_info", protocolVersion: PROTOCOL_VERSION, serverId: SHIM_SERVER_ID, hostname: "Iris", version: null,
    // canonicalSubmittedPrompts: 보낸 글 말풍선을 기록에 그 글이 나올 때까지 Paseo 가 "보내는 중"으로 둠
    // - 터미널 에이전트는 일하는 중에 받은 글을 대기열에 두었다가 나중에 넣음. 기록 행에 clientMessageId 를 실어 짝지음
    features: { ownedSubscriptions: true, providersSnapshot: true, providerSubagents: true, canonicalSubmittedPrompts: true },
    capabilities: {
      voice: {
        dictation: { enabled: false, reason: "Iris 대화 창에서는 받아쓰기를 쓰지 않습니다" },
        voice: { enabled: false, reason: "Iris 대화 창에서는 음성 대화를 쓰지 않습니다" },
      },
    },
  };
}

// 전역 WebSocket 을 감쌈. Paseo 가 소켓을 만들기 전에 불러야 함
let installed = false;
export function installIrisShim() {
  if (installed) return;
  installed = true;
  const Native = globalThis.WebSocket;
  function IrisWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    const href = String(url);
    if (href.startsWith(SHIM_URL_PREFIX) || href.startsWith(`ws://${SHIM_HOST.replace(/:80$/, "")}/`)) return new ShimSocket(href);
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  }
  Object.assign(IrisWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  IrisWebSocket.prototype = Native.prototype;
  (globalThis as any).WebSocket = IrisWebSocket;
  (globalThis as any).__PASEO_INITIAL_DAEMON_CONNECTION__ = { listen: SHIM_HOST, useTls: false };
}

installIrisShim();
