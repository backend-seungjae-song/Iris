import { callHook } from "../core/hooks.js";

const defaults = ["claude", "codex", "antigravity"];
const storageKey = "ac.session-menu.providers";
const visibilityOptions = [{ value: "show", label: "표시" }, { value: "hide", label: "숨기기" }];

function availableProviders() {
  const providers = callHook("agentchat.providers");
  return providers?.length ? providers : [
    { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "antigravity", label: "Antigravity" },
    { id: "gemini", label: "Gemini CLI" },
  ];
}

function visibleIds() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? "null");
    if (Array.isArray(saved) && saved.every(id => typeof id === "string")) return new Set(saved.map(id => id === "agy" ? "antigravity" : id));
  } catch {}
  return new Set(defaults);
}

export function sessionLaunchOptions() {
  const visible = visibleIds();
  const rows = availableProviders().filter(({ id }) => visible.has(id));
  return [...rows.map(({ id, label }) => [id, `새 ${label} 세션`]), ["", "새 터미널"]];
}

export function sessionMenuSettings() {
  const visible = visibleIds();
  return {
    id: "session-menu",
    label: "세션 만들기 메뉴",
    rows: availableProviders().map(({ id, label }) => ({
      key: id, label, value: visible.has(id) ? "show" : "hide", options: visibilityOptions,
    })),
    set(id, value) {
      const selected = visibleIds();
      if (value === "show") selected.add(id);
      else selected.delete(id);
      localStorage.setItem(storageKey, JSON.stringify([...selected]));
    },
  };
}
