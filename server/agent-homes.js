// 에이전트 CLI 의 홈 폴더. Claude Code 는 CLAUDE_CONFIG_DIR, Codex 는 CODEX_HOME 으로 위치를
// 바꿀 수 있어서, 각 파일이 `~/.claude`·`~/.codex` 를 직접 조합하면 위치를 옮긴 사용자의 대화
// 기록·인증을 읽지 못한다. 읽는 쪽은 모두 이 함수를 사용한다.
import os from "node:os";
import path from "node:path";

export function claudeHome(...parts) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(root, ...parts);
}

export function codexHome(...parts) {
  const root = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(root, ...parts);
}
