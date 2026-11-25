// 에이전트 실행 argv 의 유일한 조립 위치(새 세션·보관 복원·원격 재시작 공용)
const BASE_ARGV = new Map([
  ["claude", (resumeSession) => resumeSession == null
    ? ["claude"]
    : ["claude", "--resume", String(resumeSession)]],
  ["codex", (resumeSession) => resumeSession == null
    ? ["codex"]
    : ["codex", "resume", String(resumeSession)]],
  ["agy", (resumeSession) => resumeSession == null
    ? ["agy"]
    : ["agy", "--conversation", String(resumeSession)]],
  ["antigravity", (resumeSession) => resumeSession == null
    ? ["agy"]
    : ["agy", "--conversation", String(resumeSession)]],
]);

// 인용 없이 넘기는 글자. = 는 zsh 경로 치환(=cmd, MAGIC_EQUAL_SUBST) 때문에 제외
const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+:,./-]+$/;

export function agentArgv(kind, { resumeSession } = {}) {
  const normalizedKind = typeof kind === "string" ? kind.toLowerCase() : "";
  const makeBase = BASE_ARGV.get(normalizedKind);
  if (!makeBase) return null;

  return makeBase(resumeSession);
}

export function nativeSessionProviders() {
  return [
    { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" },
    { id: "gemini", label: "Gemini CLI" }, { id: "antigravity", label: "Antigravity" },
  ];
}

export function newTerminalArgv(kind) {
  if (kind === "gemini") return ["gemini"];
  return agentArgv(kind);
}

export function shellCommand(argv) {
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
    throw new TypeError("argv must be a string array");
  }
  return argv.map((arg) => SAFE_SHELL_ARG.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}
