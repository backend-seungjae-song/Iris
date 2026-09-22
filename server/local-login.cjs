// 로컬 개발 서버의 로그인 벽을 프로젝트가 스스로 넘게 한다.
//
// 설계 이유: 로컬에서 늘 쓰는 개발 계정까지 사람에게 물으면 확인 한 번에 매번 사람이 필요하다.
// 그렇다고 비밀번호를 DB에서 꺼낼 수는 없다. 관리자 비밀번호는 해시로 저장되므로 DB에서
// 얻을 수 있는 것은 아이디까지다. 그래서 프로젝트가 개발 계정을 선언해 두고, Iris는 로컬일
// 때만 그 값을 읽어 채운다.
//
// 유지 조건
//   로컬 원점에서만 동작한다. 그 판정은 server/local-origin.cjs 하나가 소유한다.
//   비밀번호는 채우는 경로로만 전달되고 호출자에게 반환되지 않는다(저장된 로그인과 같은 계약).
//   프로젝트는 그 포트를 듣고 있는 프로세스의 작업 폴더에서 찾는다. 이름이나 관례로 추정하면
//   다른 프로젝트의 계정을 이 사이트에 입력하게 된다.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isLocalOrigin } = require("./local-origin.cjs");

const FILE = ".iris-local.json";

// 그 포트를 듣고 있는 프로세스의 작업 폴더.
function cwdOfPort(port) {
  const run = (args) => {
    try {
      return execFileSync("lsof", args, {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };
  const pids = [
    ...new Set(
      String(run(["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"]) || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  for (const pid of pids) {
    const out = run(["-a", "-p", pid, "-d", "cwd", "-Fn"]);
    for (const line of String(out).split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  }
  return null;
}

// 작업 폴더에서 위로 올라가며 찾는다. 모노레포는 서버가 하위 폴더에서 뜨고 선언은 뿌리에 둔다.
function findDecl(startDir) {
  let d = startDir;
  for (let i = 0; i < 8 && d && d !== "/" && d !== "."; i++) {
    const p = path.join(d, FILE);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function portOf(u) {
  if (u.port) return u.port;
  return u.protocol === "https:" ? "443" : "80";
}

// 이 원점에 쓸 개발 계정. 없으면 null 을 반환하고, 로그인은 사람이 직접 처리한다.
function localLoginFor(origin) {
  if (!isLocalOrigin(origin)) return null;
  let u;
  try {
    u = new URL(String(origin));
  } catch {
    return null;
  }
  const cwd = cwdOfPort(portOf(u));
  if (!cwd) return null;
  const decl = findDecl(cwd);
  if (!decl) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(decl, "utf8"));
  } catch {
    return null;
  }
  const list = Array.isArray(doc && doc.logins) ? doc.logins : [];
  const want = u.origin;
  const hit = list.find((l) => {
    if (!l || !l.username || !l.password || !l.origin) return false;
    // 선언이 원격을 가리키면 무시한다. 파일이 프로젝트에 있다는 이유로 원격까지 허용하지 않는다.
    if (!isLocalOrigin(l.origin)) return false;
    try {
      return new URL(String(l.origin)).origin === want;
    } catch {
      return false;
    }
  });
  if (!hit) return null;
  return {
    username: String(hit.username),
    password: String(hit.password),
    from: decl,
  };
}

module.exports = { localLoginFor, FILE };
