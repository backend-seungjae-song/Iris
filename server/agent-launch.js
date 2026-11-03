// 에이전트 실행 argv 의 유일한 조립 위치(새 세션·보관 복원·원격 재시작 공용)
// 실행 옵션(codex --no-daemon, claude 원격 채널)은 셸의 codex-pane·claude-pane 래퍼 담당
const BASE_ARGV = new Map([
  ["claude", (resumeSession) => resumeSession == null
    ? ["claude"]
    : ["claude", "--resume", String(resumeSession)]],
  ["codex", (resumeSession) => resumeSession == null
    ? ["codex"]
    : ["codex", "resume", String(resumeSession)]],
]);

// 인용 없이 넘기는 글자. = 는 zsh 경로 치환(=cmd, MAGIC_EQUAL_SUBST) 때문에 제외
const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+:,./-]+$/;

export function agentArgv(kind, { resumeSession } = {}) {
  const normalizedKind = typeof kind === "string" ? kind.toLowerCase() : "";
  const makeBase = BASE_ARGV.get(normalizedKind);
  if (!makeBase) return null;

  return makeBase(resumeSession);
}

export function shellCommand(argv) {
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
    throw new TypeError("argv must be a string array");
  }
  return argv.map((arg) => SAFE_SHELL_ARG.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}
