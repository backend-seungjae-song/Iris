// 실제 herdr 터미널을 그대로 사용한다(재구현하지 않는다).
// node-pty로 `herdr session attach <name>`를 실제 PTY에서 실행하면 사용자의 iTerm이 연결된
// 것과 같은 live 세션에 클라이언트 하나로 더 연결된다. herdr가 업데이트되면 그대로 반영되고,
// 모든 herdr 키바인딩·색·TUI 렌더가 원본 그대로 나온다. xterm.js는 이 PTY의 프론트엔드일 뿐
// (iTerm2가 shell PTY의 프론트엔드인 것과 동일). 스냅샷·ANSI 재파싱 같은 재구현을 하지 않는다.
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { herdrSession } from "./herdr-session.cjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

// herdr 실행 파일을 찾는 순서: 사람이 지정한 것 → PATH → 기본 설치 경로.
// 한 사람의 홈 경로를 직접 지정하면 그 기기 밖에서는 터미널이 전혀 실행되지 않는다.
// PATH는 launchd로 뜬 서버에서 로그인 셸의 것과 다르므로, 기본 경로를 마지막에 추가한다.
export function findHerdrBin() {
  const named = (process.env.HERDR_BIN || "").trim();
  if (named) return named;
  const dirs = [...(process.env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "herdr");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return "herdr"; // 찾지 못해도 spawn을 시도한다. 실패는 아래 onExit 경로가 알린다
}

const HERDR_BIN = findHerdrBin();
// 어느 세션에 붙는지는 herdr-session.cjs 한 곳이 정한다. 여기에 이름을 직접 지정하면 개발 앱이
// 사용자가 쓰는 그 채팅에 또 하나의 클라이언트로 붙고, herdr 가 공유 PTY 를 붙은 클라이언트
// 크기로 리플로우해 사용자의 채팅 화면이 깨진다.
const SESSION = herdrSession().name;

// node-pty prebuild의 darwin-arm64 spawn-helper가 설치 후 실행권한을 잃는 경우가 있다
// (pnpm 재설치 시 -rw-r--r--). posix_spawnp 실패를 막기 위해 로드 시 실행비트를 보장한다.
function ensureSpawnHelper() {
  try {
    const base = path.dirname(require.resolve("node-pty"));
    for (const arch of ["darwin-arm64", "darwin-x64"]) {
      const helper = path.join(base, "..", "prebuilds", arch, "spawn-helper");
      try {
        const st = statSync(helper);
        if (!(st.mode & constants.S_IXUSR)) chmodSync(helper, 0o755);
      } catch {}
    }
  } catch {}
}
ensureSpawnHelper();

// herdr 마커가 남은 env로 attach하면 herdr가 "nested herdr"로 인식해 거부한다.
// 서버가 herdr pane 안에서 떠도 attach가 되도록 HERDR_* 를 제거한다.
// 서버 자신을 설정하는 변수는 터미널에 전달하지 않는다. 특히 PORT 가 문제다. launchd가 서버에
// PORT=4271을 주는데, 그 값이 터미널로 전달되면 그 안에서 실행한 다른 개발 서버가
// (next·nest·vite처럼 PORT를 따르는 것 전부) 4271을 점유한다.
// 확인 결과: shop CMS의 `next dev`가 포트 지정 없이 4271을 점유했고, 와일드카드(*:4271)로
// 바인딩해 Iris의 127.0.0.1:4271과 충돌 없이 공존했다. 그래서 이름으로 접속하는 경로
// (localhost → ::1)는 Iris가 아니라 CMS로 연결됐다.
const SERVER_ONLY_ENV = ["PORT", "REMOTE"];
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("HERDR_")) delete env[k];
  for (const k of SERVER_ONLY_ENV) delete env[k];
  env.TERM = "xterm-256color";
  return env;
}

export class PtyManager {
  constructor() {
    this.sessions = new Map(); // ws → { proc }
  }

  // 이 연결에 실제 herdr 터미널을 붙인다. 이미 있으면 재사용.
  start(ws, cols, rows, onData) {
    let s = this.sessions.get(ws);
    if (s && s.proc) return s;
    const proc = pty.spawn(HERDR_BIN, ["session", "attach", SESSION], {
      name: "xterm-256color",
      cols: Math.max(20, cols | 0 || 120),
      rows: Math.max(5, rows | 0 || 32),
      cwd: process.env.HOME,
      env: cleanEnv(),
        // raw 바이트를 그대로 전달한다. utf8 문자열 디코딩이 청크 경계에서 멀티바이트(한글)를
        // 잘라 깨뜨리는 것을 막는다. xterm이 바이트를 받아 부분 시퀀스를 스스로 조립한다.
      encoding: null,
    });
    s = { proc };
    this.sessions.set(ws, s);
    // herdr 세션 상태(사이드바 표시 등)는 변경하지 않는다. 콘솔과 iTerm이 같은 세션이라
    // 여기서 토글하면 사용자 iTerm에도 영향을 준다(공유 상태). herdr 사이드바 숨김은 콘솔
    // 프론트에서 시각적 crop으로만 처리한다(web/index.html). 여기서는 원본 스트림만 전달한다.
    proc.onData((data) => onData(data));
    proc.onExit(() => {
      this.sessions.delete(ws);
      try { ws.send(JSON.stringify({ type: "pty.exit" })); } catch {}
    });
    return s;
  }

  input(ws, data) {
    const s = this.sessions.get(ws);
    if (s && s.proc && typeof data === "string") s.proc.write(data);
  }

  // 지금 터미널이 붙어 있는 연결들 = 콘솔 창들. 분리 브라우저 창은 터미널을 붙이지 않으므로
  // 여기 없다. 창이 여럿일 때 "한 곳에만" 보내야 하는 쪽에서 이 목록으로 대상을 고른다.
  clients() { return [...this.sessions.keys()]; }
  has(ws) { return this.sessions.has(ws); }

  resize(ws, cols, rows) {
    const s = this.sessions.get(ws);
    if (s && s.proc) {
      try { s.proc.resize(Math.max(20, cols | 0 || 120), Math.max(5, rows | 0 || 32)); } catch {}
    }
  }

  // 연결 종료 시 클라이언트만 detach(세션은 herdr가 persistent하게 유지).
  stop(ws) {
    const s = this.sessions.get(ws);
    if (s && s.proc) { try { s.proc.kill(); } catch {} }
    this.sessions.delete(ws);
  }
}
