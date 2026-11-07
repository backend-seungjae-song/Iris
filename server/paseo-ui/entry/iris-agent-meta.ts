// 부모 창이 준 지금 값(모델·effort·모드·사용량·답 기다리는 질문) → Paseo 통신 규약 값
//
// 유지 조건
//   화면·목록은 Paseo 정의를 그대로 씀(Claude 모델 manifest, 권한 모드 AGENT_PROVIDER_DEFINITIONS)
//   Iris 가 넣는 것은 지금 값과 Codex 모델 목록뿐. 순수 함수만 둠(소켓·창 접근은 iris-shim.ts)
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { getClaudeManifestModels, normalizeClaudeRuntimeModelId } from "../server/src/server/agent/providers/claude/model-manifest";
import { actionId, answerIndex } from "./iris-prompt-actions.js";

export interface IrisAgentMeta {
  model: string | null;
  effort: string | null;
  mode: string | null;
  usage: { used: number; max: number | null } | null;
}
export interface IrisPromptOption { row: number; text: string; role?: string | null }
// AskUserQuestion 질문(서버가 기록의 tool_use 입력에서 읽음)
export interface IrisQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export interface IrisPrompt {
  id: string;
  // "question": Paseo 질문 카드로 보임. options 대신 questions
  kind?: "question" | null;
  toolUseId?: string | null;
  questions?: IrisQuestion[] | null;
  title?: string | null;
  question?: string | null;
  detail?: string | null;
  variant?: string | null;
  options: IrisPromptOption[];
  selectedRow?: number | null;
}
// Paseo AgentModelDefinition. 서버가 models_cache.json 을 변환해 줌
export type IrisModelDefinition = ReturnType<typeof getClaudeManifestModels>[number];

export const CODEX_ONLY_MESSAGE = "Codex 는 터미널에서 바꿔 주세요";

function providerModes(provider: string) {
  const def = AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === provider);
  return {
    defaultModeId: def?.defaultModeId ?? null,
    modes: (def?.modes ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description, icon: m.icon, colorTier: m.colorTier })),
  };
}

// 모델 목록. Claude 는 manifest, Codex 는 부모가 준 목록(없으면 unavailable)
export function providerEntries(codexModels: IrisModelDefinition[] | null, fetchedAt: string) {
  const claude = providerModes("claude");
  const codex = providerModes("codex");
  const hasCodex = !!codexModels?.length;
  return [
    { provider: "claude", status: "ready" as const, enabled: true, label: "Claude", models: getClaudeManifestModels(), modes: claude.modes, defaultModeId: claude.defaultModeId, fetchedAt },
    { provider: "codex", status: hasCodex ? ("ready" as const) : ("unavailable" as const), enabled: true, label: "Codex", models: hasCodex ? codexModels! : [], modes: codex.modes, defaultModeId: codex.defaultModeId, fetchedAt },
  ];
}

// 에이전트 스냅샷의 모델·effort·모드·사용량 칸
export function agentFields(provider: string, meta: IrisAgentMeta | null) {
  const { modes } = providerModes(provider);
  // Claude 기록의 모델 id 는 날짜·[1m] 이 붙어 있어 manifest id 로 맞춤
  const model = meta?.model ? (provider === "claude" ? normalizeClaudeRuntimeModelId(meta.model) ?? meta.model : meta.model) : null;
  const effort = meta?.effort || null;
  const mode = meta?.mode || null;
  let max = meta?.usage?.max ?? null;
  // Claude 기록에는 창 크기가 없음. manifest 값 사용
  if (max === null && provider === "claude" && model) max = getClaudeManifestModels().find((m) => m.id === model)?.contextWindowMaxTokens ?? null;
  const used = meta?.usage?.used;
  return {
    model,
    thinkingOptionId: effort,
    effectiveThinkingOptionId: effort,
    currentModeId: mode,
    availableModes: modes,
    runtimeInfo: model || effort || mode ? { provider, sessionId: null, model, thinkingOptionId: effort, modeId: mode } : undefined,
    lastUsage: typeof used === "number" ? { contextWindowUsedTokens: used, ...(max !== null ? { contextWindowMaxTokens: max } : {}) } : undefined,
  };
}

// 터미널이 답을 기다리는 질문 → 권한 요청. 카드는 title·description·actions 를 그림(plan 은 metadata.planText 를 계획 카드로)
// Paseo 서버가 AskUserQuestion 으로 만드는 요청과 같은 모양(packages/server/src/server/agent/providers/claude/agent.ts handlePermissionRequest)
// - allowOther: 직접 입력 칸. 터미널의 Type something
function questionRequest(provider: string, prompt: IrisPrompt, questions: IrisQuestion[]) {
  const first = questions[0];
  return {
    id: prompt.id,
    provider,
    name: "AskUserQuestion",
    kind: "question" as const,
    title: first.question.trim(),
    description: first.options.map((o) => o.label).join(" / "),
    input: { questions: questions.map((q) => ({ question: q.question, header: q.header, multiSelect: q.multiSelect, options: q.options, allowOther: true })) },
    metadata: { toolUseId: prompt.toolUseId ?? null },
  };
}

export function permissionRequest(provider: string, prompt: IrisPrompt) {
  if (prompt.questions?.length) return questionRequest(provider, prompt, prompt.questions);
  const isPlan = prompt.variant === "plan";
  const detail = prompt.detail?.trim() ? prompt.detail : null;
  let firstAllow = true;
  return {
    id: prompt.id,
    provider,
    name: "terminal",
    kind: isPlan ? ("plan" as const) : ("tool" as const),
    ...(prompt.title ? { title: prompt.title } : {}),
    description: prompt.question || "",
    ...(detail && !isPlan ? { detail: { type: "plain_text" as const, text: detail } } : {}),
    ...(detail && isPlan ? { metadata: { planText: detail } } : {}),
    actions: prompt.options.map((o, i) => {
      const behavior = o.role === "deny" ? ("deny" as const) : ("allow" as const);
      const variant = behavior === "deny" ? ("danger" as const) : firstAllow ? ("primary" as const) : ("secondary" as const);
      if (behavior === "allow") firstAllow = false;
      return { id: actionId(i), label: o.text, behavior, variant };
    }),
  };
}

// 앱의 답 → 눌러야 할 선택지 row(서버는 이 row 의 순서로 지금 화면의 줄을 다시 찾음)
export function answerRow(prompt: IrisPrompt, response: { behavior?: string; selectedActionId?: string }): number | null {
  const i = answerIndex(prompt.options, response);
  return i === null ? null : prompt.options[i].row;
}
