// 대화 화면 입력창 아래 표시값(지금 모델·effort·권한 모드·컨텍스트 사용량)과 Codex 모델 목록을 만드는 순수 함수
// - 목록·창 크기·모드 정의는 Paseo 쪽(진입 파일이 import)이 가짐. 여기서는 기록·화면에서 지금 값만 읽음
// - 계산식은 Paseo 데몬과 같게(claude/agent.ts ClaudeContextUsageState, codex-app-server-agent.ts toAgentUsage)
// - 영향 범위: server/agent-chat.js 가 부름, 화면 쪽 짝은 server/paseo-ui/entry

import { stripVTControlCharacters } from "node:util";

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// Claude 기록 줄(파싱된 객체) 목록 → 마지막 값. 줄은 시간 순서
// - usage: 마지막 assistant usage 네 값의 합(iterations 가 있으면 마지막 것), compact 뒤에는 postTokens
// - effort: api-request 줄의 params.output_config.effort
export function claudeMeta(records) {
  const out = { model: null, effort: null, mode: null, usage: null };
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "assistant" && r.message && typeof r.message === "object" && !r.isSidechain) {
      const m = r.message;
      if (typeof m.model === "string" && m.model && m.model !== "<synthetic>") out.model = m.model;
      const u = Array.isArray(m.usage?.iterations) && m.usage.iterations.length ? m.usage.iterations.at(-1) : m.usage;
      if (u && typeof u === "object") {
        const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
        if (used > 0) out.usage = { used, max: null };
      }
    } else if (r.type === "system" && r.subtype === "compact_boundary") {
      const post = r.compactMetadata?.postTokens;
      if (Number.isFinite(post) && post >= 0) out.usage = { used: post, max: null };
    } else if (r.type === "api-request" && r.params && typeof r.params === "object") {
      const effort = r.params.output_config?.effort;
      if (typeof effort === "string" && effort) out.effort = effort;
      if (typeof r.params.model === "string" && r.params.model) out.model = r.params.model;
    } else if ((r.type === "permission-mode" || r.type === "user") && typeof r.permissionMode === "string" && r.permissionMode) {
      out.mode = r.permissionMode;
    }
  }
  return out;
}

// Paseo 의 Codex 모드 정의(codex-app-server-agent.ts MODE_PRESETS)와 같은 조합 → 모드 id. 맞는 것이 없으면 null
const CODEX_MODE_PRESETS = [
  ["auto", "on-request", "workspace-write", "user"],
  ["auto-review", "on-request", "workspace-write", "auto_review"],
  ["full-access", "never", "danger-full-access", "user"],
];
export function codexModeId(approvalPolicy, sandboxType, reviewer) {
  const r = reviewer === "guardian_subagent" ? "auto_review" : (reviewer || "user");
  const hit = CODEX_MODE_PRESETS.find(([, a, s, v]) => a === approvalPolicy && s === sandboxType && v === r);
  return hit ? hit[0] : null;
}

// Codex rollout 줄 목록 → 마지막 값
// - usage: token_count 의 last_token_usage.total_tokens / model_context_window. total_token_usage 는 세션 누적이라 안 씀
export function codexMeta(records) {
  const out = { model: null, effort: null, mode: null, usage: null };
  for (const r of records) {
    const p = r?.payload;
    if (!p || typeof p !== "object") continue;
    if (r.type === "turn_context") {
      if (typeof p.model === "string" && p.model) out.model = p.model;
      if (typeof p.effort === "string" && p.effort) out.effort = p.effort;
      out.mode = codexModeId(p.approval_policy, p.sandbox_policy?.type, p.approvals_reviewer);
    } else if (r.type === "event_msg" && p.type === "token_count" && p.info && typeof p.info === "object") {
      const used = p.info.last_token_usage?.total_tokens;
      const max = p.info.model_context_window;
      if (Number.isFinite(used) && used >= 0) out.usage = { used, max: Number.isFinite(max) && max > 0 ? max : null };
    }
  }
  return out;
}

const AGY_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const AGY_EFFORT_SUFFIX = new RegExp(`-(${AGY_MODEL_EFFORTS.join("|")})$`, "i");

function agyContextMax(model) {
  if (!model) return null;
  return /^gemini/i.test(model) ? 1_000_000 : 200_000;
}

// Antigravity transcript 줄 목록 → 마지막 모델·effort·컨텍스트 사용량
export function agyMeta(records) {
  const out = { model: null, effort: null, mode: null, usage: null };
  for (const r of records) {
    if (!r || typeof r !== "object" || r.type !== "PLANNER_RESPONSE") continue;
    if (typeof r.model === "string" && r.model) {
      const m = AGY_EFFORT_SUFFIX.exec(r.model);
      if (m) {
        out.model = r.model.slice(0, m.index);
        out.effort = m[1].toLowerCase();
      } else {
        out.model = r.model;
      }
    }
    const used = num(r.input_tokens) + num(r.cache_read_tokens) + num(r.output_tokens);
    if (used > 0) out.usage = { used, max: agyContextMax(out.model) };
  }
  return out;
}

// Antigravity 모델 목록 → Paseo AgentModelDefinition 모양
export function agyDefaultModels() {
  const mkOptions = (levels, def) => levels.map((id) => ({ id, label: id, isDefault: id === def }));
  const defs = [
    { id: "gemini-4-neon", label: "Gemini 4 Neon", isDefault: true, max: 1_000_000, levels: ["low", "medium", "high", "xhigh"], def: "medium" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", max: 1_000_000, levels: ["low", "medium", "high"], def: "medium" },
    { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", max: 1_000_000, levels: ["low", "medium", "high", "xhigh"], def: "medium" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", max: 1_000_000, levels: ["low", "medium", "high"], def: "medium" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", max: 200_000, levels: ["low", "medium", "high"], def: "medium" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", max: 200_000, levels: ["low", "medium", "high"], def: "medium" },
    { id: "gpt-oss-120b", label: "GPT-OSS 120B", max: 200_000, levels: ["medium"], def: "medium" },
  ];
  return defs.map((m) => ({
    provider: "agy",
    id: m.id,
    label: m.label,
    isDefault: !!m.isDefault,
    contextWindowMaxTokens: m.max,
    thinkingOptions: mkOptions(m.levels, m.def),
    defaultThinkingOptionId: m.def,
  }));
}

// Antigravity 화면 아래줄("auto · Orchestrator · Gemini 4 Neon · medium")에서 모드·effort 추출
const AGY_MODES = { auto: "auto", plan: "plan", "accept-edits": "acceptEdits", default: "default", "request-review": "default" };
const AGY_EFFORTS = new Set(AGY_MODEL_EFFORTS);
export function agyFooter(screen) {
  const tail = String(screen || "").split("\n").slice(-6);
  let mode = null;
  let effort = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (!tail[i].includes("·")) continue;
    const parts = tail[i].split("·").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const part of parts) {
      const token = part.split(/\s+/).at(-1) || "";
      if (!mode && AGY_MODES[token]) mode = AGY_MODES[token];
      if (!effort && AGY_EFFORTS.has(part)) effort = part;
    }
    if (mode || effort) break;
  }
  return { effort, mode };
}

// Claude Code 화면 아래줄 → effort·권한 모드. 기록은 다음 요청 때에야 바뀌므로 화면이 더 최근 값
// - "◐ medium · /effort", "⏵⏵ auto mode on (shift+tab to cycle)", "⏸ manual mode on"(default), "⏸ plan mode on", "⏵⏵ accept edits on", "⏵⏵ bypass permissions on"
// - 모드 줄이 없고 effort 줄만 보이면 default(이전 버전 화면)
const CLAUDE_MODE_LINES = [
  [/\bmanual mode on\b/i, "default"],
  [/\bplan mode on\b/i, "plan"],
  [/\baccept edits on\b/i, "acceptEdits"],
  [/\bbypass permissions on\b/i, "bypassPermissions"],
  [/\bauto mode on\b/i, "auto"],
];
export function claudeFooter(screen) {
  const tail = String(screen || "").split("\n").slice(-12).join("\n");
  const effort = /([a-z]+)\s*·\s*\/effort\b/i.exec(tail)?.[1]?.toLowerCase() || null;
  let mode = null;
  for (const [re, id] of CLAUDE_MODE_LINES) if (re.test(tail)) { mode = id; break; }
  if (!mode && effort) mode = "default";
  return { effort, mode };
}

// 터미널 입력과 상태줄 사이의 빈 줄로 사용자가 작성 중인 글을 제외
export function codexFooter(screen, models) {
  if (!models?.length) return null;
  const lines = stripVTControlCharacters(screen).trimEnd().split("\n");
  const prompt = lines.findLastIndex(line => /^›(?:\s|$)/.test(line));
  if (prompt < 0) return null;
  const gap = lines.findIndex((line, index) => index > prompt && !line.trim());
  if (gap < 0 || lines.length - gap > 6) return null;
  const first = lines[gap + 1]?.trim().split(/\s+·\s+/)[0] || "";
  const match = /^(.+)\s+(\S+)$/.exec(first);
  if (!match) return null;
  const name = match[1].toLowerCase(), effort = match[2].toLowerCase();
  const model = models.find(m => [m.label, m.id].some(s => s.toLowerCase() === name));
  return model?.thinkingOptions?.some(option => option.id === effort) ? { model: model.id, effort } : null;
}

// ~/.codex/models_cache.json → Paseo AgentModelDefinition 목록(buildCodexModelDefinition 과 같은 모양)
// - visibility "list" 만. 기본 모델은 configuredModel(config.toml model) 이 있으면 그것, 없으면 priority 가 가장 작은 것
export function codexModelsFromCache(cache, configuredModel = null) {
  const models = Array.isArray(cache?.models) ? cache.models : [];
  const shown = models.filter((m) => m && typeof m.slug === "string" && m.slug && m.visibility === "list");
  const first = [...shown].sort((a, b) => num(a.priority) - num(b.priority))[0]?.slug;
  const defaultId = configuredModel && shown.some((m) => m.slug === configuredModel) ? configuredModel : first;
  return shown.map((m) => {
    const levels = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
      .filter((l) => typeof l?.effort === "string" && l.effort && l.effort !== "default");
    const def = typeof m.default_reasoning_level === "string" && m.default_reasoning_level !== "default" ? m.default_reasoning_level : undefined;
    const thinkingOptions = levels.map((l) => ({ id: l.effort, label: l.effort,
      ...(typeof l.description === "string" && l.description.trim() ? { description: l.description } : {}), isDefault: l.effort === def }));
    if (def && !thinkingOptions.some((o) => o.id === def)) thinkingOptions.push({ id: def, label: def, description: "Model default reasoning effort", isDefault: true });
    return {
      provider: "codex", id: m.slug, label: String(m.display_name || m.slug).replace(/\bgpt\b/gi, "GPT"),
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      isDefault: m.slug === defaultId,
      ...(Number.isFinite(m.context_window) && m.context_window > 0 ? { contextWindowMaxTokens: m.context_window } : {}),
      ...(thinkingOptions.length ? { thinkingOptions } : {}),
      ...(def || thinkingOptions[0] ? { defaultThinkingOptionId: def ?? thinkingOptions[0].id } : {}),
    };
  });
}

// config.toml 의 맨 위 model = "..." 한 줄만 읽음(표 안 model 은 다른 뜻)
export function codexConfiguredModel(toml) {
  for (const line of String(toml || "").split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}
