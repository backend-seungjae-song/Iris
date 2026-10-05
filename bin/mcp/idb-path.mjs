// iOS 시뮬레이터 조작 도구 idb 의 실행 파일 위치. MCP 앱 도구(app.mjs)가 쓴다.
//
// idb 는 pip 로 설치하는 도구라 설치 방법마다 위치가 다르다(pipx ~/.local/bin, pip --user
// ~/Library/Python/<버전>/bin, Homebrew Python /opt/homebrew/bin). IRIS_IDB 로 바꿀 수 있다.
import fs from "node:fs";
import path from "node:path";

export const IDB_MISSING = "idb를 찾지 못했습니다. iOS 시뮬레이터 조작에는 idb 가 필요합니다: "
  + "brew install facebook/fb/idb-companion && pipx install fb-idb. 다른 위치에 있으면 IRIS_IDB 로 지정";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function idbCandidates(env = process.env) {
  const home = env.HOME || "";
  let userPython = [];
  try {
    userPython = fs.readdirSync(path.join(home, "Library", "Python")).sort().reverse()
      .map((v) => path.join(home, "Library", "Python", v, "bin", "idb"));
  } catch {}
  return [
    env.IRIS_IDB,
    path.join(home, ".local", "bin", "idb"),
    ...userPython,
    "/opt/homebrew/bin/idb",
    "/usr/local/bin/idb",
    ...String(env.PATH || "").split(":").filter(Boolean).map((dir) => path.join(dir, "idb")),
  ].filter(Boolean);
}

// 저장하지 않고 매번 찾음. 세션 중에 설치·제거할 수 있음
export function idbPath(env = process.env) {
  return idbCandidates(env).find(isFile) || null;
}
