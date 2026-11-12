// Iris 용 Paseo 대화 화면 진입. Paseo 태그 소스의 packages/app 에 복사해 웹으로 빌드함
//
// 유지 조건
//   Paseo 소스는 고치지 않음. 이 파일이 Paseo 내부 모듈을 import 하므로 Paseo 가 그 모듈을 바꾸면
//   빌드가 실패하고 Iris 는 이전 빌드를 계속 씀(server/paseo-ui/index.js)
//   데몬 대신 iris-shim.ts 가 진입 파일 안에서 Paseo 통신 규약으로 답함. 맨 먼저 import 해야 함
//   대화 데이터는 부모 창(web/js/agentchat/boot.js)이 postMessage 로 줌. 같은 출처 메시지만 받음
//   메시지 형식은 server/agent-chat-transcript.js 의 { id, role, blocks, ts }
//   입력·중단·명령·파일 찾기는 부모 창에 postMessage 로 넘김(iris-chat.send·cancel·commands·files)
//   모든 요청에 요청을 만든 때의 대화 key 를 넣음. 부모는 지금 보기와 key 가 다르면 거절
import { SHIM_SERVER_ID, SHIM_WORKSPACE_ID, UPLOAD_LIMIT_BYTES, shimDaemon, type ShimItem } from "./iris-shim";
import "./src/polyfills/install-early";
import "./src/styles/unistyles";
import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import { Component, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PortalProvider } from "@gorhom/portal";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { QueryClientProvider } from "@tanstack/react-query";
import { UnistylesRuntime } from "react-native-unistyles";
import { LucideProvider } from "lucide-react-native";
import { queryClient } from "@/data/query-client";
import { APP_SETTINGS_KEY, APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { I18nProvider } from "@/i18n/provider";
import { ToastProvider } from "@/contexts/toast-context";
import { SessionProvider } from "@/contexts/session-context";
import { PaneFocusProvider, PaneProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { AgentStreamView } from "@/agent-stream/view";
import { ComposerEditingSessionsProvider } from "@/composer/editing-session";
import { CommandCenterProvider } from "@/command-center/provider";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { KeyboardActionDispatcherProvider, useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { dispatchTopWebOverlayKeyDown, keyBelongsToDomPopover } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { WindowChromeProvider } from "@/utils/desktop-window";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { SheetPaneHostProvider } from "@/screens/workspace/sheet-pane/host";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { registerPanel } from "@/panels/panel-registry";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { resolveClientSlashCommand } from "@/client-slash-commands";
import { useDraftStore } from "@/stores/draft-store";
import { buildWorkspaceAttachmentScopeKey, useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { chatHistoryAttachment, forkDrafts, isBranchCommand } from "./iris-fork-model";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { i18n } from "@/i18n/i18next";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { collectPluginThemes } from "@/plugins/themes";
import { PLUGIN_THEME_NAMES, ICON_STROKE_WIDTH } from "@/styles/theme";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { ContextChips, openContextDialog, type IrisContext } from "./iris-contexts";
import { TaskBar, cleanOutput, type IrisTask, type TaskReader } from "./iris-tasks";
import { attachmentText, expandText, insertAtCaret } from "./iris-inline-tokens";
import { patchUserRow } from "./iris-user-images";
import { PENDING_SEND_CSS, dropRewound, pinPendingLast, poppedSends, rewoundLastId, staleSends } from "./iris-pending-sends";
import { StashButton, stashNow, type StashHost } from "./iris-stash";
import { installCodeCopy } from "./iris-code-copy";
import { installLinkTail, openableUrl } from "./iris-link-tail";
// 빌드 때 web/js/panel/url-token.js 를 복사한 파일(server/paseo-ui/index.js SHARED_FILES). 저장소 entry 폴더에는 없음
import { terminalUrlToken } from "./iris-url-token";
import { installInlineChips, syncContexts, writeComposer } from "./iris-inline-chips";
import type { IrisAgentMeta, IrisModelDefinition, IrisPrompt } from "./iris-agent-meta";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "../server/src/server/agent/providers/claude/tool-call-mapper";
import { mapTaskNotificationUserContentToToolCall } from "../server/src/server/agent/providers/claude/task-notification-tool-call";
import { mapCodexToolCallFromThreadItem } from "../server/src/server/agent/providers/codex/tool-call-mapper";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; off?: number; i?: number }
  | { type: "tool-call"; id: string | null; name: string; input: unknown; wrapper?: boolean }
  | { type: "tool-item"; item: unknown }
  | { type: "tool-result"; id: string | null; output: string; isError?: boolean; off?: number; images?: { i: number; j: number }[] }
  | { type: "task-notification"; text: string };
interface IrisMessage { id: string; role: "user" | "assistant" | "tool" | "reasoning"; blocks: Block[]; ts?: number | null; parent?: string }
interface ChatState {
  key: string;
  paneId: string;
  agentId: string | null;
  kind: "claude" | "codex";
  cwd: string;
  file: string | null;
  gen: string | null;
  messages: IrisMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  running: boolean;
  // 원격(폰) 웹뷰는 늘 true. 입력창을 그리지 않고 첨부도 올리지 않음(원격 전송은 막혀 있음)
  readOnly?: boolean;
  theme: "dark" | "light";
  // Iris 요소 선택 칩(부모가 pane 마다 보관). 보낼 때 글 앞에 붙음
  contexts?: IrisContext[];
  // 지금 모델·effort·모드·사용량(서브에이전트 보기는 null). 화면은 Paseo 것을 쓰고 값만 넣음
  agent?: IrisAgentMeta | null;
  // kind codex 일 때만. Paseo AgentModelDefinition 목록
  codexModels?: IrisModelDefinition[] | null;
  // 그 pane 이 답을 기다리는 동안의 질문
  prompt?: IrisPrompt | null;
  // 터미널 입력줄에 쓰다 만 글. 입력 칸이 안 보이면 null
  draft?: { text: string } | null;
  // 지금 실행 중인 Claude 서브에이전트. Paseo 입력창 위 서브에이전트 줄로 보임
  subagents?: { id: string; description: string; agentType: string }[];
  // 백그라운드 셸·Monitor(server/agent-chat-tasks.js). 입력창 위 작업 줄과 도구 카드 출력
  tasks?: IrisTask[];
}

const noop = () => {};
const PANE_FOCUS = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });

// Iris 색. 값의 정본은 web/css/00-tokens.css(어두움)·01-base.css(밝음)
const IRIS_THEMES = {
  dark: { id: "dark", name: "Iris", appearance: "dark",
    colors: { background: "#0A1620", foreground: "#EAF3FA", raised: "#0F1E2B", control: "#16293A", border: "#1B3140", accent: "#00AFF0", mutedForeground: "#8FB0C4", ring: "#85E8F6" } },
  light: { id: "light", name: "Iris Light", appearance: "light",
    colors: { background: "#EEF7FD", foreground: "#0F1E2B", raised: "#EAF3FA", control: "#D8ECF8", border: "#CBE4F5", accent: "#00AFF0", mutedForeground: "#3F5E6C", ring: "#00A6FB" } },
} as const;

// Paseo 의 플러그인 테마 변환을 그대로 거쳐 적용
// - 앱 설정의 테마 선택은 AppearanceProvider 가 적용하는데 이 진입은 그것을 띄우지 않으므로 Iris 테마가 남음
function applyIrisTheme(mode: "dark" | "light") {
  const plugin = { id: "iris", serverId: SHIM_SERVER_ID, themes: [IRIS_THEMES[mode]], locale: "en", i18n: { resolve: (n: unknown) => String(n) } } as any;
  const [option] = collectPluginThemes([plugin], new Set([SHIM_SERVER_ID]));
  if (!option) return;
  const name = PLUGIN_THEME_NAMES[option.theme.colorScheme];
  UnistylesRuntime.updateTheme(name, () => option.theme);
  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(name);
  document.documentElement.style.background = IRIS_THEMES[mode].colors.background;
}

function textOf(blocks: Block[]) {
  return blocks.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n\n");
}

// 글 없이 이미지만 보낸 사용자 말. Paseo 는 빈 글의 사용자 항목을 버리므로 이 글자로 넘기고 그린 뒤 비움
export const IMAGE_ONLY_TEXT = "\u200b";

const SUBAGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);

// Iris 메시지 → Paseo 대화 항목(통신 규약 AgentTimelineItem). 도구 호출은 Paseo 의 변환 함수 사용
// - 결과가 없는 호출은 마지막 에이전트 차례에서만 실행 중으로, 그 앞은 완료로 봄
// - key: shim 이 같은 행인지 가리는 값. 앞뒤로 행이 붙어도 그대로
// - resultImageUrl: 도구 결과 이미지 주소(없으면 이미지를 넣지 않음)
// 백그라운드 작업 카드의 출력: 도구 결과(“백그라운드에서 실행 중” 안내) 대신 출력 파일 끝부분
function taskCardOutput(task: IrisTask) {
  const tail = cleanOutput(task.tail || "");
  return task.cut ? `…\n${tail}` : tail;
}

export function toTimeline(all: IrisMessage[], running: boolean, cwd = "", origin = "", resultImageUrl?: (b: { off?: number; i: number; j: number }) => string, tasks: IrisTask[] = []): ShimItem[] {
  const messages: IrisMessage[] = dropRewound(all);
  const byCall = new Map(tasks.map((t) => [t.toolUseId, t]));
  const results = new Map<string, Extract<Block, { type: "tool-result" }>>();
  for (const m of messages) for (const b of m.blocks) if (b.type === "tool-result" && b.id) results.set(b.id, b);
  let lastUser = -1;
  messages.forEach((m, n) => { if (m.role === "user") lastUser = n; });
  const items: ShimItem[] = [];
  messages.forEach((m, n) => {
    const ts = typeof m.ts === "number" ? m.ts : Date.now();
    if (m.role === "user") {
      const text = textOf(m.blocks);
      const hasImage = m.blocks.some((b) => b.type === "image");
      if (text || hasImage) items.push({ key: m.id, ts, item: { type: "user_message", text: text || IMAGE_ONLY_TEXT, messageId: m.id } });
      return;
    }
    if (m.role === "reasoning") {
      const text = textOf(m.blocks);
      if (text) items.push({ key: `${m.id}:r`, ts, item: { type: "reasoning", text } });
      return;
    }
    for (const [k, b] of m.blocks.entries()) {
      // 백그라운드 셸 끝남·Monitor 알림: Paseo 데몬과 같은 변환으로 알림 카드
      if (b.type === "task-notification") {
        const notice = mapTaskNotificationUserContentToToolCall({ content: b.text, messageId: m.id });
        if (notice) items.push({ key: `tool:${notice.callId}`, ts, item: notice });
        continue;
      }
      if (b.type === "text" && b.text) items.push({ key: `${m.id}:${k}`, ts, item: { type: "assistant_message", text: localImagesToUrls(b.text, cwd, origin), messageId: `${m.id}:${k}` } });
      // Codex 끝난 도구 항목: Paseo 데몬이 Codex 에서 받는 것과 같은 항목이라 Paseo Codex 변환 그대로
      if (b.type === "tool-item") {
        const mapped = mapCodexToolCallFromThreadItem(b.item, { cwd });
        if (mapped) items.push({ key: `tool:${mapped.callId}`, ts, item: mapped });
        continue;
      }
      if (b.type !== "tool-call") continue;
      const callId = b.id || `${m.id}:${k}`;
      const result = b.id ? results.get(b.id) : undefined;
      // Codex exec 묶음: 끝나면 안의 항목 카드로 보이므로 실행 중일 때만
      if (b.wrapper && result) continue;
      const task = b.id ? byCall.get(b.id) : undefined;
      const output = task && task.size != null ? taskCardOutput(task) : result?.output;
      const params = { callId, name: b.name, input: b.input, output };
      const mapped = result?.isError ? mapClaudeFailedToolCall({ ...params, error: { message: result.output || "실패" } })
        : task?.status === "running" ? mapClaudeRunningToolCall(params)
          : result || !(running && n > lastUser) ? mapClaudeCompletedToolCall(params) : mapClaudeRunningToolCall(params);
      if (!mapped) continue;
      // Monitor: Paseo 에 해당 카드가 없어 이름만 보임 → 설명·명령·출력이 보이는 글 카드(Paseo plain_text)
      if (b.name === "Monitor" && mapped.type === "tool_call") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : "";
        const text = [command && `$ ${command}`, typeof output === "string" ? output : ""].filter(Boolean).join("\n\n");
        (mapped as any).detail = {
          type: "plain_text", icon: "eye",
          ...(typeof input.description === "string" && input.description ? { label: input.description } : {}),
          ...(text ? { text } : {}),
        };
      }
      // 서브에이전트 도구(Paseo claude/agent.ts isClaudeSubagentToolName 과 같은 판정)는 실행 표시 카드로 그림
      if (SUBAGENT_TOOLS.has(b.name) && mapped.type === "tool_call") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        (mapped as any).detail = {
          type: "sub_agent", log: "",
          ...(typeof input.subagent_type === "string" ? { subAgentType: input.subagent_type } : {}),
          ...(typeof input.description === "string" ? { description: input.description } : {}),
        };
      }
      items.push({ key: `tool:${callId}`, ts, item: mapped });
      // 도구 결과 이미지: 통신 규약의 도구 항목에는 이미지 칸이 없어 Paseo 데몬처럼 바로 뒤 답변 마크다운으로 넣음
      const shots = result?.images ?? [];
      if (resultImageUrl && shots.length) {
        const text = shots.map((img) => `![이미지](${resultImageUrl({ off: result!.off, i: img.i, j: img.j })})`).join("\n\n");
        items.push({ key: `tool:${callId}:img`, ts, item: { type: "assistant_message", text, messageId: `${m.id}:${k}:img` } });
      }
    }
  });
  return items;
}

// - f·g(기록 파일 이름·inode): 같은 pane 에서 세션이 바뀌면 같은 off 라도 다른 주소·캐시
function imageUrl(state: ChatState, b: { off?: number; i?: number }) {
  const q = new URLSearchParams({ pane: state.paneId, off: String(b.off ?? -1), i: String(b.i ?? -1) });
  if (state.agentId) q.set("agent", state.agentId);
  if (state.file) q.set("f", state.file);
  if (state.gen) q.set("g", state.gen);
  return `/agentchat-image?${q}`;
}

// 사용자 말풍선 이미지: 서버에서 받아 Paseo 첨부 저장소에 넣고 그 메타데이터를 붙임
// - 통신 규약의 user_message 에는 이미지 칸이 없음. 앱 저장소의 그 행에 images 를 직접 넣음(useUserImages)
// - 실패하면 캐시에서 빼고 다음 상태 갱신 때 다시 시도. 주소마다 3번까지
const IMAGE_TRIES = 3;
const imageCache = new Map<string, Promise<AttachmentMetadata | null>>();
const imageFailures = new Map<string, number>();
function attachmentId(url: string) {
  let h = 0;
  for (let k = 0; k < url.length; k++) h = (Math.imul(h, 31) + url.charCodeAt(k)) | 0;
  return `iris-${(h >>> 0).toString(36)}-${url.length}`;
}
function loadImage(url: string): Promise<AttachmentMetadata | null> | null {
  let hit = imageCache.get(url);
  if (hit) return hit;
  if ((imageFailures.get(url) || 0) >= IMAGE_TRIES) return null;
  hit = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`이미지 응답 ${r.status}`);
    const blob = await r.blob();
    return await persistAttachmentFromBlob({ blob, mimeType: blob.type, id: attachmentId(url) });
  }).catch((e) => {
    imageCache.delete(url);
    imageFailures.set(url, (imageFailures.get(url) || 0) + 1);
    console.warn("[iris-chat] 이미지를 불러오지 못함", url, e);
    return null;
  });
  imageCache.set(url, hit);
  return hit;
}

// 답변 마크다운의 로컬 이미지 경로 → Iris 이미지 주소
// - Paseo 는 로컬 경로를 데몬의 파일 읽기로 가져오는데 데몬이 없음. http 주소는 그대로 불러오고 확대도 됨
// - 인라인 ![a](경로)와 참조 정의 [p]: 경로 둘 다. 참조 정의는 이미지 확장자일 때만(일반 링크 정의는 그대로)
const LOCAL_IMAGE = /(!\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
const IMAGE_REFERENCE = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]+>|\S+)(.*)$/gm;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
function localTarget(rawTarget: string, cwd: string, origin: string): string | null {
  const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
  let file = target;
  if (target.startsWith("file://")) {
    try { file = decodeURIComponent(target.slice(7)); } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith("//") || file.startsWith("#")) return null;
  return `${origin}/agentchat-file?${new URLSearchParams({ cwd, path: file })}`;
}
export function localImagesToUrls(text: string, cwd: string, origin: string) {
  return text
    .replace(LOCAL_IMAGE, (all, open, rawTarget, close) => {
      const url = localTarget(rawTarget, cwd, origin);
      return url ? `${open}${url}${close}` : all;
    })
    .replace(IMAGE_REFERENCE, (all, open, rawTarget, rest) => {
      const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
      if (!IMAGE_EXT.test(target.split(/[?#]/)[0])) return all;
      const url = localTarget(rawTarget, cwd, origin);
      return url ? `${open}${url}${rest}` : all;
    });
}

function post(msg: unknown) {
  window.parent?.postMessage(msg, window.location.origin);
}

// 부모 창에 요청을 보내고 같은 id 의 답을 기다림
// - 부모가 답하지 않으면 timeoutMs 뒤 null
const replies = new Map<string, (data: any) => void>();
let requestSeq = 0;
function ask(type: string, body: Record<string, unknown>, timeoutMs: number, id = `r${++requestSeq}-${Date.now().toString(36)}`): Promise<any | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { replies.delete(`${type}:${id}`); resolve(null); }, timeoutMs);
    replies.set(`${type}:${id}`, (data) => { clearTimeout(timer); resolve(data); });
    post({ type, id, ...body });
  });
}

// Iris 서버에 파일 하나를 올림 → 서버에 저장된 절대 경로
async function uploadBlob(name: string, blob: Blob) {
  if (blob.size > UPLOAD_LIMIT_BYTES) throw new Error("파일이 30MB 를 넘습니다");
  const res = await fetch(`/agentchat-upload?${new URLSearchParams({ name })}`, { method: "POST", body: blob });
  if (!res.ok) throw new Error(`파일을 올리지 못했습니다(${res.status})`);
  const body = await res.json();
  if (typeof body?.path !== "string") throw new Error("업로드 응답에 경로가 없습니다");
  return { path: body.path as string, size: typeof body.size === "number" ? body.size : blob.size, fileName: typeof body.fileName === "string" ? body.fileName : name };
}

// 보낼 이미지(base64) → 부모 서버에 올린 절대 경로, 그 밖의 첨부 → 글(파일은 이미 올린 경로). 에이전트는 경로를 보고 파일을 읽음
async function uploadPaths(images: { data: string; mimeType: string }[], attachments: unknown[]) {
  const paths: string[] = [];
  for (const [n, img] of images.entries()) {
    const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
    const ext = (img.mimeType.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
    paths.push((await uploadBlob(`image-${Date.now()}-${n + 1}.${ext}`, new Blob([bytes], { type: img.mimeType }))).path);
  }
  // 분기 채팅 기록은 파일로 올려 @경로로 보냄
  // - 글로 붙이면 기록 속 @경로를 Claude 가 첨부로 읽고, 최대 10만 자가 터미널 붙여넣기로 들어감
  const texts: string[] = [];
  for (const a of attachments as any[]) {
    if (a?.type === "text" && a.contextKind === "chat_history" && typeof a.text === "string") {
      texts.push(`@${(await uploadBlob(`chat-history-${Date.now()}.txt`, new Blob([a.text], { type: "text/plain" }))).path}`);
    } else texts.push(attachmentText(a));
  }
  return { images: paths, attachments: texts };
}

const SEND_TIMEOUT_MS = 15_000;
const TASK_READ_TIMEOUT_MS = 5_000;
const readTask: TaskReader = (taskId, from) => ask("iris-chat.taskread", { key: currentKey, taskId, ...(from === null ? {} : { from }) }, TASK_READ_TIMEOUT_MS);
const OLDER_TIMEOUT_MS = 10_000;
// 모드는 Shift+Tab 을 최대 6번 눌러 맞추므로 길게. 권한 답은 앱 쪽 대기(15초)보다 짧게
const MODE_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 12_000;
// 부모에 글 하나를 보내고 iris-chat.sent 를 기다림
async function sendText(key: string, id: string, text: string, contextIds: string[] = []) {
  sentAt.set(key, Date.now());
  const r = await ask("iris-chat.send", { key, text, ...(contextIds.length ? { contextIds } : {}) }, SEND_TIMEOUT_MS, id);
  if (!r) return { ok: false, reason: "Iris 창이 답하지 않았습니다" };
  return { ok: r.ok !== false, reason: r.reason || "" };
}

shimDaemon.host = {
  async send({ key, id, text, images, attachments, remember }) {
    // 칩은 보낸 시점의 것만. 업로드를 기다리는 사이 새로 붙인 칩은 다음 메시지에 남김
    const ctx = key === currentKey ? currentContexts.slice() : [];
    let full = text;
    try {
      const paths = await uploadPaths(images, attachments);
      // 글 속 칩 자리에 이미지 경로·요소 내용. 보내기에 성공하면 부모가 요소 칩을 뺌
      full = expandText(text, { imagePaths: paths.images, attachments: paths.attachments, contexts: ctx });
    } catch (e) {
      return { ok: false, reason: String((e as any)?.message || e) };
    }
    remember(full);
    return sendText(key, id, full, ctx.map((c) => c.id));
  },
  cancel(key) { post({ type: "iris-chat.cancel", key }); },
  loadOlder() {
    post({ type: "iris-chat.older" });
    return new Promise((resolve) => setTimeout(resolve, OLDER_TIMEOUT_MS));
  },
  async commands(key) {
    const r = await ask("iris-chat.commands", { key }, 10_000);
    if (!r) return { commands: [], error: "Iris 창이 답하지 않았습니다" };
    return { commands: Array.isArray(r.commands) ? r.commands : [], error: r.error || undefined };
  },
  async files(key, query) {
    const r = await ask("iris-chat.files", { key, query }, 10_000);
    if (!r) return { directories: [], entries: [], error: "Iris 창이 답하지 않았습니다" };
    return { directories: Array.isArray(r.directories) ? r.directories : [], entries: Array.isArray(r.entries) ? r.entries : [], error: r.error || undefined };
  },
  upload({ fileName, bytes }) { return uploadBlob(fileName, bytes); },
  sendFailed(key, id, text, reason) {
    useSessionStore.getState().rejectAgentMessageSubmission(SHIM_SERVER_ID, key, id);
    console.warn(`[iris-chat] 보내지 못함: ${reason}`);
    // 그 대화가 열려 있을 때만 입력창에 되돌림. 첨부는 되돌리지 않음
    if (key === currentKey) focusComposer(text);
  },
  command(key, text) { return sendText(key, `cmd-${Date.now().toString(36)}-${++requestSeq}`, text); },
  async mode(key, modeId) {
    const r = await ask("iris-chat.mode", { key, modeId }, MODE_TIMEOUT_MS);
    return r ? { ok: r.ok !== false, reason: r.reason || "" } : { ok: false, reason: "Iris 창이 답하지 않았습니다" };
  },
  async answer(key, promptId, row) {
    const r = await ask("iris-chat.answer", { key, promptId, row }, ANSWER_TIMEOUT_MS);
    return r ? { ok: r.ok !== false, reason: r.reason || "" } : { ok: false, reason: "Iris 창이 답하지 않았습니다" };
  },
  async answerQuestion(key, promptId, answers) {
    const r = await ask("iris-chat.answer", { key, promptId, ...(answers ? { answers } : { dismiss: true }) }, ANSWER_TIMEOUT_MS);
    return r ? { ok: r.ok !== false, reason: r.reason || "" } : { ok: false, reason: "Iris 창이 답하지 않았습니다" };
  },
};

// Paseo 클라이언트 명령(/clear·/new·/exit·/quit 등)을 터미널의 같은 명령으로 보냄
// - Paseo 는 이 명령을 입력창에서 가로채 대화를 보관하고 새 초안을 엶. Iris 에서는 터미널 CLI 가 처리해야 함
// - 입력창이 받기 전(document capture 단계)에 Enter·보내기 단추를 가로채 글 그대로 iris-chat.send 로 보냄
// - 명령 목록은 Paseo resolveClientSlashCommand 를 그대로 씀. Paseo 가 명령을 늘리면 함께 따라감
let currentKey: string | null = null;
let currentContexts: IrisContext[] = [];

// 답변의 웹 링크. Paseo 는 window.open 으로 여는데 iframe 안이라 Electron 이 창을 띄우지 않음 → 부모가 Iris 브라우저 탭으로 엶
// - 같은 클릭이 <a> 클릭과 Paseo onPress(window.open) 둘 다로 올 수 있어 1초 안의 같은 주소는 한 번만
let lastWebLink = { href: "", at: 0 };
function openWebLink(raw: string) {
  const href = openableUrl(raw, terminalUrlToken);
  if (!/^https?:\/\//i.test(href) || !currentKey) return;
  const now = Date.now();
  if (href === lastWebLink.href && now - lastWebLink.at < 1000) return;
  lastWebLink = { href, at: now };
  post({ type: "iris-chat.open-url", key: currentKey, url: href });
}
window.open = ((url?: string | URL) => { openWebLink(String(url ?? "")); return null; }) as typeof window.open;
// <a href> 를 직접 누른 경우(react-native-web 링크)도 iframe 이 이동하지 않게 같은 경로로
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || !/^https?:\/\//i.test(a.href) || new URL(a.href).origin === window.location.origin) return;
  e.preventDefault();
  openWebLink(a.href);
}, true);
// 번호 목록 복사: 번호는 CSS 표시라 드래그로 못 고름 → 첫 항목 글자 맨 앞에서 시작한 선택은 Paseo 가 그 번호를 뺌
// - 그 항목 밖까지 이어진 선택만 시작점을 항목 맨 앞(li, 0)으로 옮김. 변환은 Paseo(assistant-selection-copy) 그대로
document.addEventListener("copy", () => {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : (range.startContainer as Element);
  const li = start?.closest?.("li");
  if (!li || li.contains(range.endContainer)) return;
  const before = document.createRange();
  before.setStart(li, 0);
  before.setEnd(range.startContainer, range.startOffset);
  if (before.toString().trim()) return;
  range.setStart(li, 0);
}, true);
// 마지막 누름의 보조 키. Paseo 의 파일 링크 콜백에는 이벤트가 없어 여기서 기록(⌘⇧ = Finder 판정은 부모 wantsReveal)
let lastPress = { shiftKey: false, metaKey: false, ctrlKey: false, at: 0 };
const recordPress = (e: MouseEvent) => { lastPress = { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, at: Date.now() }; };
document.addEventListener("pointerdown", recordPress, true);
document.addEventListener("click", recordPress, true);
function pressMods() {
  const { at, ...mods } = lastPress;
  return Date.now() - at < 1500 ? mods : { shiftKey: false, metaKey: false, ctrlKey: false };
}
// 답변의 / 로 끝나는 폴더 경로 ⌘⇧클릭 → 부모가 Finder 로 엶(파일 경로와 같은 요청)
// - Paseo 는 폴더를 자기 탐색기 사이드바·데스크톱 앱으로만 보내 Iris 에서는 아무 일도 없음. 보통 클릭은 Paseo 그대로
// - Paseo 가 경로로 알아본 글만: 누를 수 있는 code(cursor pointer)
document.addEventListener("click", (e) => {
  if (!e.metaKey || !e.shiftKey || e.button !== 0 || !currentKey) return;
  const code = (e.target as Element | null)?.closest?.("code");
  const text = code?.textContent?.trim() ?? "";
  if (!code || !/^\S+\/$/.test(text) || getComputedStyle(code).cursor !== "pointer") return;
  post({ type: "iris-chat.open-file", key: currentKey, path: text, mods: { shiftKey: true, metaKey: true, ctrlKey: e.ctrlKey } });
}, true);
function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('[data-testid="message-input-root"] textarea');
}
// 대화 목록을 눌러도 입력창 커서 유지(터미널처럼). 커서 위치는 textarea 가 기억함
// - 끌어서 고른 글·링크·버튼·입력칸을 누른 경우는 그대로
const INTERACTIVE = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
document.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  const t = e.target as Element | null;
  if (!t?.closest?.('[data-testid="agent-chat-scroll"]') || t.closest(INTERACTIVE)) return;
  if (window.getSelection()?.toString()) return;
  composerTextarea()?.focus({ preventScroll: true });
});
function submitLabels() {
  return new Set(["sendMessage", "queueMessage", "sendAndSteer", "sendAndInterrupt"].map((k) => i18n.t(`composer.input.${k}`)));
}
function clearTextarea(ta: HTMLTextAreaElement) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(ta, "");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
function clientCommandText(): string | null {
  const ta = composerTextarea();
  const text = ta?.value.trim() ?? "";
  return text && (resolveClientSlashCommand({ text, hasAttachments: false }) || isBranchCommand(text)) ? text : null;
}
// 부모가 붙인 글(@파일 멘션)을 입력창 끝에 넣고 입력창에 포커스
// 부모가 보낸 글(@경로)은 커서 자리에. 글 없이 포커스만이면 커서를 그대로 둠
// - 요소 칩은 칩 목록 쪽(syncContexts)이 커서 자리에 넣고 포커스 요청이 뒤따름. 끝으로 옮기면 넣은 자리를 잃음
function focusComposer(insert: string) {
  const ta = composerTextarea();
  if (!ta) return;
  ta.focus();
  if (!insert) return;
  const next = insertAtCaret(ta.value, ta.selectionStart, ta.selectionEnd, insert);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(ta, next.text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.setSelectionRange(next.caret, next.caret);
}

// 포커스만 요청(세션 이동 등). 옮긴 직후에는 새 입력창이 아직 없거나 다시 그려져 포커스를 잃으므로 잠깐 동안 다시 맞춤
// - 이 화면 밖(부모의 터미널 등)으로 포커스가 가거나 사람이 누르면 그만둠
const FOCUS_RETRY_MS = 1500;
let focusUntil = 0;
function focusComposerSoon() {
  focusUntil = Date.now() + FOCUS_RETRY_MS;
  const tick = () => {
    if (Date.now() > focusUntil) return;
    const ta = composerTextarea();
    if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
    setTimeout(tick, 100);
  };
  tick();
}
const stopFocusRetry = () => { focusUntil = 0; };
window.addEventListener("blur", stopFocusRetry);
document.addEventListener("pointerdown", stopFocusRetry, true);

// 터미널 입력줄 글을 입력창에 보임. 입력창이 비었거나 지난번에 옮긴 글 그대로일 때만 바꿈
// - 대화 화면에서 고쳐 쓰는 중이면 덮어쓰지 않음. 보낼 때 서버가 터미널 입력 칸을 다 지움
// - 보낸 직후에는 지우기 전 화면이 한 번 더 올 수 있어 잠깐 건너뜀
const shownDraft = new Map<string, string>();
const sentAt = new Map<string, number>();
const DRAFT_AFTER_SEND_MS = 3000;
// - 건너뛴 동안 온 마지막 글은 그 시간이 지나면 다시 적용. 입력줄이 그 뒤로 안 바뀌면 다시 오지 않음
const draftRetry = new Map<string, ReturnType<typeof setTimeout>>();
function syncTerminalDraft(key: string, draft: { text: string } | null | undefined) {
  clearTimeout(draftRetry.get(key));
  if (!draft || typeof draft.text !== "string" || key !== currentKey) return;
  const wait = DRAFT_AFTER_SEND_MS - (Date.now() - (sentAt.get(key) ?? 0));
  if (wait > 0) { draftRetry.set(key, setTimeout(() => syncTerminalDraft(key, draft), wait + 50)); return; }
  dropPoppedSends(key, draft.text);
  const ta = composerTextarea();
  if (!ta) return;
  const shown = shownDraft.get(key) ?? "";
  if (ta.value !== "" && ta.value !== shown) return;
  shownDraft.set(key, draft.text);
  if (ta.value === draft.text) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(ta, draft.text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// 중단으로 터미널 입력줄에 돌아간 글은 대화에서 뺌. 한 번 판정하면 그 대화가 열려 있는 동안 계속 뺌
// - 다음에 보낸 글이 기록에 들어오면 dropRewound(toTimeline)가 같은 글을 기록만으로 뺌
// - 보낸 직후에는 터미널 입력줄이 아직 안 비었을 수 있어 판정하지 않음
const rewound = new Map<string, Set<string>>();
function withoutRewound(next: ChatState): IrisMessage[] {
  if (next.readOnly) return next.messages;
  let ids = rewound.get(next.key);
  const justSent = Date.now() - (sentAt.get(next.key) ?? 0) < DRAFT_AFTER_SEND_MS;
  const id = justSent ? null : rewoundLastId(next.messages, next.draft?.text, !!next.running);
  if (id) { if (!ids) rewound.set(next.key, (ids = new Set())); ids.add(id); }
  return ids?.size ? next.messages.filter((m) => !ids.has(m.id)) : next.messages;
}

// 전달 전 보낸 글(Paseo 가 기록에 나올 때까지 "보내는 중"으로 둔 말풍선) id
function pendingSendIds(key: string): string[] {
  const subs = useSessionStore.getState().sessions[SHIM_SERVER_ID]?.messageSubmissions.get(key) ?? [];
  return subs.filter((s) => !s.providerAcknowledged).map((s) => s.clientMessageId);
}
// 전달 전 글이 터미널 입력줄로 되돌아옴(↑·중단) → 말풍선을 Paseo 의 보내기 실패와 같게 뺌. 글은 위 초안 동기화로 입력창에
function dropPoppedSends(key: string, draftText: string) {
  const ids = new Set(pendingSendIds(key));
  if (!ids.size) return;
  const store = useSessionStore.getState();
  for (const id of poppedSends(draftText, shimDaemon.sentNotSeen().filter((s) => ids.has(s.id)))) {
    store.rejectAgentMessageSubmission(SHIM_SERVER_ID, key, id);
    shimDaemon.forgetSent(id);
  }
}
// 짝을 못 찾은 채 에이전트가 쉬고 입력줄에도 없는 "보내는 중" 말풍선을 뺌(staleSends)
// - 차례가 끝나고 대기 글이 다음 차례로 들어가기 전 잠깐 쉬는 것으로 보일 수 있어 같은 판정이 3초 이어질 때만 뺌
const STALE_MIN_AGE_MS = 5000;
const STALE_HOLD_MS = 3000;
const UNMARKED_MIN_AGE_MS = 20000;
const staleSince = new Map<string, number>();
const unmarkedSince = new Map<string, number>();
const lastTerminal = new Map<string, { running: boolean; draft: string }>();
let staleTimer: ReturnType<typeof setTimeout> | undefined;
function dropStaleSends(key: string) {
  clearTimeout(staleTimer);
  const ids = new Set(pendingSendIds(key));
  const term = lastTerminal.get(key);
  if (!ids.size || !term || key !== currentKey) { staleSince.clear(); unmarkedSince.clear(); return; }
  const now = Date.now();
  const sends = shimDaemon.sentNotSeen().filter((s) => ids.has(s.id));
  // shim 이 받지 못한 제출(보내기 중 오류 등)은 처음 본 때부터 나이를 셈. 업로드·붙여넣기 시간을 넘게 기다림
  const marked = new Set(sends.map((s) => s.id));
  for (const id of [...unmarkedSince.keys()]) if (!ids.has(id) || marked.has(id)) unmarkedSince.delete(id);
  const unmarked = [...ids].filter((id) => !marked.has(id)).map((id) => {
    if (!unmarkedSince.has(id)) unmarkedSince.set(id, now);
    return { id, text: "", at: unmarkedSince.get(id)! };
  });
  const found = new Set([
    ...staleSends(sends, { running: term.running, draftText: term.draft, now, minAge: STALE_MIN_AGE_MS }),
    ...staleSends(unmarked, { running: term.running, draftText: term.draft, now, minAge: UNMARKED_MIN_AGE_MS }),
  ]);
  for (const id of [...staleSince.keys()]) if (!found.has(id)) staleSince.delete(id);
  const store = useSessionStore.getState();
  let dropped = false;
  for (const id of found) {
    const since = staleSince.get(id) ?? now;
    staleSince.set(id, since);
    if (now - since < STALE_HOLD_MS) continue;
    store.rejectAgentMessageSubmission(SHIM_SERVER_ID, key, id);
    shimDaemon.forgetSent(id);
    staleSince.delete(id);
    unmarkedSince.delete(id);
    dropped = true;
  }
  // 앞 글이 멈춰 대기열에 걸린 글. 앱은 에이전트가 멈출 때만 대기열을 보내므로 쉬고 있으면 여기서 보냄
  if (dropped && !term.running) getHostRuntimeStore().drainQueuedAgentMessage(SHIM_SERVER_ID, key);
  // 상태가 더 오지 않아도 다시 봄. 아직 보낸 지 얼마 안 된 글도 나이가 차면 다시 봄
  if (sends.length || unmarked.length) staleTimer = setTimeout(() => dropStaleSends(key), 1000);
}
// 전달 전 말풍선을 맨 아래에(터미널 대기 글처럼). 전달되면 기록 행이 들어간 자리에 대신 들어옴
function usePendingSendsLast(agentId: string | undefined) {
  useEffect(() => {
    if (!agentId) return;
    if (!document.getElementById("iris-pending-sends")) {
      const el = document.createElement("style");
      el.id = "iris-pending-sends";
      el.textContent = PENDING_SEND_CSS;
      document.head.appendChild(el);
    }
    let applying = false;
    const pin = () => {
      if (applying) return;
      const s = useSessionStore.getState().sessions[SHIM_SERVER_ID];
      if (!s) return;
      const next = pinPendingLast(s.agentStreamTail.get(agentId) ?? [], s.agentStreamHead.get(agentId) ?? [], pendingSendIds(agentId));
      if (!next) return;
      applying = true;
      try { useSessionStore.getState().setAgentStreamState(SHIM_SERVER_ID, agentId, next); } finally { applying = false; }
    };
    pin();
    return useSessionStore.subscribe(pin);
  }, [agentId]);
}

// 입력창 임시 저장(iris-stash.tsx)이 쓰는 입력창·칩
// - 칩 되살리기는 부모의 칩 추가와 같음. 부모가 지금 칩 다음 번호를 차례로 매기므로 저장 목록의 번호 규칙과 맞음
const STASH_HOST: StashHost = {
  draftKey: () => (currentKey ? buildDraftStoreKey({ serverId: SHIM_SERVER_ID, agentId: currentKey }) : null),
  text: () => composerTextarea()?.value ?? "",
  setText: (text) => { writeComposer(text); },
  contexts: () => currentContexts,
  // 부모가 새 상태를 보내기 전에 한 번 더 저장해도 같은 칩이 다시 들어가지 않게 바로 비움
  clearContexts: () => { if (currentKey) { currentContexts = []; post({ type: "iris-chat.context-remove", key: currentKey }); } },
  restoreContexts: (items) => {
    for (const c of items) if (currentKey) post({ type: "iris-chat.context-add", key: currentKey, content: c.content, ...(c.kind ? { kind: c.kind } : {}) });
  },
};
// ⌘⇧Enter: 입력창 지금 내용을 임시 저장
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.metaKey || !e.shiftKey || e.isComposing || e.target !== composerTextarea()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stashNow(STASH_HOST);
}, true);

// 글·첨부 없이 칩만 있을 때 Enter·보내기 단추: Paseo 입력창은 빈 글을 보내지 않으므로 칩만 직접 보냄
// - 첨부가 있으면 가로채지 않음. Paseo 가 보내고 host.send 가 칩을 붙임
function chipsOnly() {
  if (!currentKey || !currentContexts.length || composerTextarea()?.value.trim()) return false;
  const draft = useDraftStore.getState().getDraftInput(buildDraftStoreKey({ serverId: SHIM_SERVER_ID, agentId: currentKey }));
  return !draft?.attachments?.length;
}
function sendContextsOnly() {
  const key = currentKey;
  const ctx = currentContexts;
  if (!key || !ctx.length) return;
  void sendText(key, `ctx-${Date.now().toString(36)}`, ctx.map((c) => c.content).join("\n\n"), ctx.map((c) => c.id)).then((r) => {
    if (!r.ok) console.warn("[iris-chat] 붙인 요소를 보내지 못함", r.reason);
  });
}
function runClientCommand(text: string) {
  const ta = composerTextarea();
  if (ta) clearTextarea(ta);
  const key = currentKey;
  if (!key) return;
  if (isBranchCommand(text)) { branchWhole(key); return; }
  void sendText(key, `cmd-${Date.now().toString(36)}`, text).then((r) => {
    if (!r.ok) console.warn("[iris-chat] 명령을 보내지 못함", text, r.reason);
  });
}
// 분기: 채팅 기록 첨부를 Iris 창에 넘김. Iris 창이 새 탭에서 같은 에이전트를 실행하고 그 대화 입력창에 첨부를 돌려줌
// - 응답 아래 분기 단추: Paseo 가 만든 첨부를 새 초안 범위에서 가져감
// - /branch: 지금까지 전체 대화로 같은 첨부를 만듦(Paseo 진행 중 분기와 같은 범위)
function requestFork(sourceKey: string, attachment: unknown) {
  post({ type: "iris-chat.fork", key: sourceKey, attachment });
}
function branchWhole(key: string) {
  try {
    requestFork(key, shimDaemon.forkContext({ agentId: key }).attachment);
  } catch (e) {
    console.warn("[iris-chat] 분기하지 못함", e);
  }
}
useWorkspaceAttachmentsStore.subscribe((s) => {
  for (const f of forkDrafts(s.attachmentsByScope)) {
    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey: f.scopeKey });
    requestFork(f.sourceKey, f.attachment);
  }
});
// 새 탭 대화의 입력창에 채팅 기록 첨부. Paseo 대화 패널이 읽는 워크스페이스 범위에 넣음
function attachForkHistory(sourceKey: string, attachment: unknown) {
  const scopeKey = buildWorkspaceAttachmentScopeKey({ serverId: SHIM_SERVER_ID, workspaceId: SHIM_WORKSPACE_ID, cwd: "/" });
  useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({ scopeKey, attachment: chatHistoryAttachment(attachment, { serverId: SHIM_SERVER_ID, sourceKey }) as any });
}
function installClientCommandBridge() {
  const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.target !== composerTextarea()) return;
    const text = clientCommandText();
    if (!text) {
      if (chipsOnly()) { stop(e); sendContextsOnly(); }
      return;
    }
    stop(e);
    runClientCommand(text);
  }, true);
  // 보내기 단추: 누르기 시작부터 막아야 Pressable 이 onPress 를 내지 않음
  const isSubmit = (t: EventTarget | null) => {
    const el = (t as Element | null)?.closest?.('[role="button"]');
    return !!el && !!el.closest('[data-testid="message-input-root"]') && submitLabels().has(el.getAttribute("aria-label") || "");
  };
  for (const type of ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend"]) {
    document.addEventListener(type, (e) => { if (isSubmit(e.target) && (clientCommandText() || chipsOnly())) stop(e); }, true);
  }
  document.addEventListener("click", (e) => {
    if (!isSubmit(e.target)) return;
    const text = clientCommandText();
    if (!text) {
      if (chipsOnly()) { stop(e); sendContextsOnly(); }
      return;
    }
    stop(e);
    runClientCommand(text);
  }, true);
}
installClientCommandBridge();
installCodeCopy();
installLinkTail(terminalUrlToken);
installInlineChips({ post, openContext: openContextDialog, mods: pressMods });

// 그리다 실패하면 부모에 알림. 부모는 첫 화면이 실패한 새 빌드면 이전 빌드로 되돌림
function reportError(error: unknown) {
  post({ type: "iris-chat.error", message: String((error as any)?.message || error).slice(0, 500) });
}
// - 처리 안 된 Promise 거절은 보고하지 않음. 지원하지 않는 요청 하나로 멀쩡한 빌드가 되돌려지지 않게
window.addEventListener("error", (e) => reportError(e.error || e.message));

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { reportError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

// 부모 창 상태 → shim. 받은 상태를 돌려줌
function useParentState() {
  const [state, setState] = useState<ChatState | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const type = e.data?.type;
      if (type === "iris-chat.insert" || type === "iris-chat.focus") {
        if (e.data.key !== currentKey) return;
        if (type === "iris-chat.insert") focusComposer(String(e.data.text || ""));
        else focusComposerSoon();
        return;
      }
      if (type === "iris-chat.fork-attach") {
        if (e.data.key === currentKey && e.data.attachment && typeof e.data.attachment.text === "string") attachForkHistory(String(e.data.sourceKey || ""), e.data.attachment);
        return;
      }
      if (type !== "iris-chat.state") {
        const id = type === "iris-chat.sent" ? `iris-chat.send:${e.data.id}` : `${type}:${e.data?.id}`;
        replies.get(id)?.(e.data);
        replies.delete(id);
        return;
      }
      const next = e.data.state as ChatState;
      currentKey = next.key;
      currentContexts = next.readOnly ? [] : (Array.isArray(next.contexts) ? next.contexts : []);
      syncContexts(currentKey, currentContexts);
      applyIrisTheme(next.theme === "light" ? "light" : "dark");
      const kind = next.kind === "codex" ? "codex" : "claude";
      shimDaemon.setAgent(
        { id: next.key, provider: kind, cwd: next.cwd || "/", title: null, running: !!next.running, meta: next.agent ?? null, codexModels: Array.isArray(next.codexModels) ? next.codexModels : null, prompt: next.prompt ?? null, subagents: Array.isArray(next.subagents) ? next.subagents : [] },
        toTimeline(withoutRewound(next), next.running, next.cwd, window.location.origin, (b) => `${window.location.origin}${imageUrl(next, b)}&j=${b.j}`, Array.isArray(next.tasks) ? next.tasks : []),
        !!next.hasOlder, !!next.loadingOlder,
      );
      setState(next);
      // 입력창이 새 상태로 그려진 뒤
      requestAnimationFrame(() => syncTerminalDraft(next.key, next.readOnly ? null : next.draft));
      if (!next.readOnly) { lastTerminal.set(next.key, { running: !!next.running, draft: next.draft?.text ?? "" }); dropStaleSends(next.key); }
    };
    window.addEventListener("message", onMessage);
    post({ type: "iris-chat.ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return state;
}

// 사용자 이미지: 내려받아 첨부 저장소에 넣고, 앱 저장소의 해당 user_message 행에 images 를 넣음
function useUserImages(state: ChatState | null) {
  const [images, setImages] = useState<Map<string, AttachmentMetadata>>(() => new Map());
  useEffect(() => {
    if (!state) return;
    for (const m of state.messages) {
      if (m.role !== "user") continue;
      for (const b of m.blocks) {
        if (b.type !== "image" || typeof b.off !== "number") continue;
        const url = imageUrl(state, b);
        if (images.has(url)) continue;
        loadImage(url)?.then((meta) => { if (meta) setImages((prev) => (prev.has(url) ? prev : new Map(prev).set(url, meta))); });
      }
    }
  }, [state, images]);

  // messageId → 붙일 이미지(못 받았으면 빈 배열)·보일 글
  // - 대화 화면에서 보낸 말: Paseo 는 보내기 전에 그린 행(입력창 글, 칩 글자 그대로)의 글을 유지함. 기록의 글(칩을 펼친 원문)로 바꿈
  const wanted = useMemo(() => {
    const out = new Map<string, { metas: AttachmentMetadata[]; text: string | null }>();
    if (!state) return out;
    for (const m of state.messages) {
      if (m.role !== "user") continue;
      const sent = shimDaemon.messageIds.get(m.id);
      const hasImage = m.blocks.some((b) => b.type === "image");
      if (!hasImage && !sent) continue;
      const metas = m.blocks.flatMap((b) => (b.type === "image" ? [images.get(imageUrl(state, b))] : [])).filter(Boolean) as AttachmentMetadata[];
      // 글 없는 이미지 말: 이미지를 받았으면 빈 글, 아직(또는 끝내) 못 받았으면 빈 말풍선 대신 [이미지]
      const text = textOf(m.blocks) || (!hasImage ? null : metas.length ? "" : "[이미지]");
      out.set(sent ?? m.id, { metas, text });
    }
    return out;
  }, [state, images]);

  useEffect(() => {
    if (!state) return;
    const agentId = state.key;
    // 구독 안에서 저장소를 다시 씀. 쓰기가 이 구독을 바로 다시 부르므로 그 안의 호출은 건너뜀
    let applying = false;
    const patch = () => {
      if (applying) return;
      const store = useSessionStore.getState();
      const items = store.sessions[SHIM_SERVER_ID]?.agentStreamTail.get(agentId);
      if (!items) return;
      let changed = false;
      const next = items.map((it: any) => {
        if (it.kind !== "user_message") return it;
        const out = patchUserRow(it, wanted.get(it.messageId) ?? wanted.get(it.id));
        if (out !== it) changed = true;
        return out;
      });
      if (!changed) return;
      applying = true;
      try { store.setAgentStreamTail(SHIM_SERVER_ID, (tail) => new Map(tail).set(agentId, next)); } finally { applying = false; }
    };
    patch();
    return useSessionStore.subscribe(patch);
  }, [state?.key, wanted]);
}

// 이 대화를 화면에 보이는 대화로 등록. 앱의 시트 패널(sheet-pane.tsx)과 같은 방식
// - 등록해야 앱이 대화 기록을 받아 오고(fetch_agent_timeline) 실시간 구독을 시작함
function VisibleAgent({ agentId }: { agentId: string }) {
  const sync = useSessionStore((s) => s.sessions[SHIM_SERVER_ID]?.viewedTimelineSync ?? null);
  useEffect(() => {
    void getHostRuntimeStore().prepareAgentTimeline(SHIM_SERVER_ID, agentId).catch(() => undefined);
  }, [agentId]);
  useLayoutEffect(() => {
    if (!sync) return;
    sync.replaceVisibleAgentIds("iris-chat", [agentId]);
    // 앱은 한 번 본 대화를 탭이 닫힐 때까지 받는 대화로 둠. Iris 는 레이아웃에 탭이 없어 지금 대화만 남김
    // - 떠난 대화는 따라잡기에서 빠지고, 돌아오면 앱이 그 대화를 새로 따라잡음
    sync.replaceOpenTabAgentIds([agentId]);
    return () => sync.replaceVisibleAgentIds("iris-chat", []);
  }, [agentId, sync]);
  return null;
}

// 읽기 전용(폰): Paseo 대화 목록만. 데이터는 shim 이 채운 앱 저장소에서
const EMPTY_ITEMS: never[] = [];
const EMPTY_PERMISSIONS = new Map();
function ReadOnlyStream({ state }: { state: ChatState }) {
  const tail = useSessionStore((s) => s.sessions[SHIM_SERVER_ID]?.agentStreamTail.get(state.key)) ?? EMPTY_ITEMS;
  const head = useSessionStore((s) => s.sessions[SHIM_SERVER_ID]?.agentStreamHead.get(state.key)) ?? EMPTY_ITEMS;
  const context = useMemo(() => ({ serverId: SHIM_SERVER_ID, id: state.key, provider: state.kind, status: state.running ? "running" : "idle", cwd: state.cwd || "/" } as any),
    [state.key, state.kind, state.running, state.cwd]);
  const turn = useMemo(() => ({ isActive: state.running, isCancelling: false, startedAt: null, turnId: null }), [state.running]);
  // historyPagination 을 넘기지 않음: Paseo 기본 경로(fetch_agent_timeline before)로 shim 을 거쳐야 받은 이전 행이 앱 저장소에 들어감
  return (
    <AgentStreamView
      key={state.key}
      agentId={state.key}
      serverId={SHIM_SERVER_ID}
      context={context}
      streamItems={tail}
      streamHead={head}
      turnPresentation={turn}
      pendingPermissions={EMPTY_PERMISSIONS}
      isAuthoritativeHistoryReady
      readOnly
    />
  );
}

// 이 대화의 기록이 앱 저장소에 들어오면(화면에 그릴 준비가 되면) 부모에 한 번 알림
// - 부모는 이것으로 새 빌드가 정상인지 판정. iris-chat.ready 는 이보다 일찍 감
let healthySent = false;
function useHealthySignal(key: string | null) {
  useEffect(() => {
    if (!key || healthySent) return;
    const check = () => {
      if (healthySent) return;
      const status = selectAgentTimelineState(useSessionStore.getState().sessions[SHIM_SERVER_ID], key).status;
      if (status !== "synced") return;
      healthySent = true;
      post({ type: "iris-chat.healthy" });
    };
    check();
    return useSessionStore.subscribe(check);
  }, [key]);
}

// 서브에이전트 줄에서 항목을 누르면 Paseo 는 작업공간 탭 저장소에 provider_subagent 탭을 엶
// - 이 진입에는 탭을 그릴 곳이 없으므로 새로 생긴 탭을 부모에 알리고 닫음. 부모가 Iris 의 읽기 전용 보기를 엶
const openedSubagentTabs = new Set<string>();
function reportOpenedSubagents() {
  const store = useWorkspaceLayoutStore.getState();
  const found: { workspaceKey: string; tabId: string; subagentId: string; sheet: boolean }[] = [];
  for (const [workspaceKey, layout] of Object.entries(store.layoutByWorkspace)) {
    for (const tab of collectAllTabs((layout as any).root)) {
      if ((tab.target as any)?.kind === "provider_subagent") found.push({ workspaceKey, tabId: tab.tabId, subagentId: (tab.target as any).subagentId, sheet: false });
    }
  }
  for (const [workspaceKey, sheets] of Object.entries(store.sheetsByWorkspace ?? {})) {
    for (const sheet of sheets as any[]) {
      if (sheet?.tab?.target?.kind === "provider_subagent") found.push({ workspaceKey, tabId: sheet.tab.tabId, subagentId: sheet.tab.target.subagentId, sheet: true });
    }
  }
  // 닫힌 탭은 목록에서 뺌. Paseo 는 같은 서브에이전트에 같은 tabId 를 쓰므로 남겨 두면 두 번째 열기를 못 알림
  const live = new Set(found.map((f) => f.tabId));
  for (const id of openedSubagentTabs) if (!live.has(id)) openedSubagentTabs.delete(id);
  for (const f of found) {
    if (openedSubagentTabs.has(f.tabId)) continue;
    openedSubagentTabs.add(f.tabId);
    if (currentKey) post({ type: "iris-chat.open-subagent", key: currentKey, agentId: f.subagentId });
    store.closeTab(f.workspaceKey, f.tabId);   // 시트도 같은 함수로 닫힘
  }
}

// 서브에이전트 줄이 그릴 때 읽는 패널 등록과 시트 호스트. 탭은 그리지 않으므로 호스트의 내용 만들기는 비움
registerPanel(providerSubagentPanelRegistration);
const SHEET_HOST = {
  workspaceKey: buildWorkspaceTabPersistenceKey({ serverId: SHIM_SERVER_ID, workspaceId: SHIM_WORKSPACE_ID }) as string,
  serverId: SHIM_SERVER_ID, workspaceId: SHIM_WORKSPACE_ID, isWorkspaceFocused: true,
  buildContent: () => { throw new Error("Iris 대화 화면은 시트 탭을 그리지 않습니다"); },
} as any;

// Esc → 일하는 에이전트 중단(Paseo agent-interrupt 단축키)
// - 그 단축키를 다는 Paseo useKeyboardShortcuts 는 expo-router 가 있어야 해서 이 화면에 없음
// - 거르는 조건은 Paseo 와 같음: 맨 위 오버레이·열린 팝오버·IME 조합 중이면 넘기고, 입력창·그 밖 포커스에서만
// - 중단 여부(돌고 있는가·받아쓰기 취소)는 입력창 처리기가 판단
function useEscapeInterrupt() {
  const dispatcher = useKeyboardActionDispatcher();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (dispatchTopWebOverlayKeyDown(e) || keyBelongsToDomPopover(e) || isImeComposingKeyboardEvent(e)) return;
      const scope = resolveKeyboardFocusScope({ target: e.target, commandCenterOpen: false });
      if (scope !== "message-input" && scope !== "other") return;
      dispatcher.dispatch({ id: "agent.interrupt", scope: "global" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatcher]);
}

function IrisChat() {
  const state = useParentState();
  useEscapeInterrupt();
  useEffect(() => useWorkspaceLayoutStore.subscribe(reportOpenedSubagents), []);
  useUserImages(state);
  usePendingSendsLast(state && !state.readOnly ? state.key : undefined);
  useHealthySignal(state?.key ?? null);
  const client = useHostRuntimeClient(SHIM_SERVER_ID);
  // 사이드바가 없으므로 에이전트·워크스페이스 목록 구독을 여기서 요청
  useDirectoryDemand(SHIM_SERVER_ID);

  useEffect(() => {
    void getHostRuntimeStore().boot();
    // 시험 때 화면 밖에서 상태를 들여다보는 손잡이
    if (/[?&]check=1\b/.test(location.search)) (window as any).__irisDebug = { runtime: getHostRuntimeStore(), session: useSessionStore };
  }, []);

  const pane = useMemo(() => state && ({
    serverId: SHIM_SERVER_ID, workspaceId: SHIM_WORKSPACE_ID, host: "main", tabId: `iris-chat:${state.key}`,
    target: { kind: "agent", agentId: state.key },
    openTab: noop, openPreferredTarget: noop, closeCurrentTab: noop, retargetCurrentTab: noop,
    setCurrentTabState: noop, openImportSheet: noop,
    // 답변의 파일 경로 링크. 부모가 터미널 경로 링크와 같게 엶
    openFileInWorkspace: (req: any) => {
      const loc = req?.location;
      if (typeof loc?.path === "string" && loc.path) post({ type: "iris-chat.open-file", key: state.key, path: loc.path, mods: pressMods() });
    },
  } as any), [state?.key]);

  if (!state || !client || !pane) return <View style={{ flex: 1 }} />;
  return (
    <SessionProvider serverId={SHIM_SERVER_ID} client={client}>
      <DiffDocumentWorkspaceCacheProvider>
      <SheetPaneHostProvider value={SHEET_HOST}>
      <VisibleAgent agentId={state.key} />
      <ComposerEditingSessionsProvider>
        <CommandCenterProvider>
        <PaneProvider value={pane}>
          <PaneFocusProvider value={PANE_FOCUS}>
            <View style={{ flex: 1 }}>
              {state.readOnly ? <ReadOnlyStream state={state} /> : <AgentConversationPanel key={state.key} />}
              {state.readOnly ? null : (
                <TaskBar tasks={Array.isArray(state.tasks) ? state.tasks : []} colors={IRIS_THEMES[state.theme === "light" ? "light" : "dark"].colors} read={readTask} />
              )}
              {state.readOnly ? null : <StashButton host={STASH_HOST} scope={buildDraftStoreKey({ serverId: SHIM_SERVER_ID, agentId: state.key })} />}
              {state.readOnly ? null : (
                <ContextChips items={state.contexts || []} colors={IRIS_THEMES[state.theme === "light" ? "light" : "dark"].colors}
                  onRemove={(ids) => post({ type: "iris-chat.context-remove", key: state.key, ...(ids ? { ids } : {}) })} />
              )}
              {/* / 명령·@ 파일 목록 같은 떠 있는 패널이 그려지는 자리. 앱 레이아웃(_layout.tsx)과 같음 */}
              <FloatingPanelPortalHost />
            </View>
          </PaneFocusProvider>
        </PaneProvider>
        </CommandCenterProvider>
      </ComposerEditingSessionsProvider>
      </SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </SessionProvider>
  );
}

// Iris 설정 > 대화 화면에 띄우는 Paseo 채팅 설정(?panel=chat-settings). 항목·기본값·저장은 Paseo 것
// - 저장소는 같은 출처 localStorage(@paseo:app-settings). 대화 화면은 storage 이벤트로 다시 읽음
const PANEL = new URLSearchParams(window.location.search).get("panel");
function ChatSettingsPanel() {
  useEffect(() => {
    const root = window.parent?.document?.documentElement;
    const sync = () => applyIrisTheme(root?.getAttribute("data-theme") === "light" ? "light" : "dark");
    sync();
    const themeWatch = root ? new MutationObserver(sync) : null;
    themeWatch?.observe(root!, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { themeWatch?.disconnect(); };
  }, []);
  // 부모가 iframe 높이를 내용 높이에 맞춤. body 는 창 높이를 채우므로 내용을 감싼 View 로 잼
  return (
    <View onLayout={(e) => post({ type: "iris-chat.panel-size", panel: PANEL, height: Math.ceil(e.nativeEvent.layout.height) })}>
      <ChatSection />
    </View>
  );
}
// 다른 iframe(설정)에서 바꾼 Paseo 설정을 바로 반영
window.addEventListener("storage", (e) => {
  if (e.key === APP_SETTINGS_KEY) void queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
});

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SafeAreaProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>
              <KeyboardActionDispatcherProvider>
                <WindowChromeProvider>
                  <KeyboardProvider>
                    <KeyboardShiftProvider>
                      <ToastProvider>
                        <PortalProvider>
                          <BottomSheetModalProvider>
                            <Boundary>
                              {PANEL === "chat-settings" ? <ChatSettingsPanel /> : <IrisChat />}
                            </Boundary>
                          </BottomSheetModalProvider>
                        </PortalProvider>
                      </ToastProvider>
                    </KeyboardShiftProvider>
                  </KeyboardProvider>
                </WindowChromeProvider>
              </KeyboardActionDispatcherProvider>
            </LucideProvider>
          </GestureHandlerRootView>
        </SafeAreaProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

registerRootComponent(Root);
