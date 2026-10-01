// 에이전트 실행 argv 의 유일한 조립 위치(새 세션·보관 복원·원격 재시작 공용)
const BASE_ARGV = new Map([
  ["claude", (resumeSession) => resumeSession == null
    ? ["claude"]
    : ["claude", "--resume", String(resumeSession)]],
  ["codex", (resumeSession) => resumeSession == null
    ? ["codex", "--no-daemon"]
    : ["codex", "--no-daemon", "resume", String(resumeSession)]],
]);

const optionProviders = [];
// 인용 없이 넘기는 글자. = 는 zsh 경로 치환(=cmd, MAGIC_EQUAL_SUBST) 때문에 제외
const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+:,./-]+$/;

export function agentArgv(kind, { resumeSession } = {}) {
  const normalizedKind = typeof kind === "string" ? kind.toLowerCase() : "";
  const makeBase = BASE_ARGV.get(normalizedKind);
  if (!makeBase) return null;

  const argv = makeBase(resumeSession);
  for (const entry of [...optionProviders]) {
    try {
      const extra = entry.provider(normalizedKind, { resumeSession });
      if (Array.isArray(extra) && extra.every((arg) => typeof arg === "string")) argv.push(...extra);
    } catch {} // 공급자 실패는 무시(원격 옵션이 빠져도 로컬 실행 유지)
  }
  return argv;
}

export function registerLaunchOptions(provider) {
  if (typeof provider !== "function") throw new TypeError("provider must be a function");
  const entry = { provider };
  optionProviders.push(entry);
  return () => {
    const index = optionProviders.indexOf(entry);
    if (index >= 0) optionProviders.splice(index, 1);
  };
}

export function shellCommand(argv) {
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
    throw new TypeError("argv must be a string array");
  }
  return argv.map((arg) => SAFE_SHELL_ARG.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}
