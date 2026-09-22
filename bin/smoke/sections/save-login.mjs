// 소유 범위: 이 브라우저에서 새로 로그인한 자격증명을 금고에 저장하는 경로. 수집 지점, 확인 지점,
//   한 건만 추가하는 금고 쓰기. Chrome 쪽 저장소는 이 경로 어디에서도 쓰이지 않는다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구. 금고는 electron 을 부르지 않으므로 가짜 fs·safeStorage 로
//   실제 함수를 실행한다. 코드 모양만 검사하면 한 건 추가가 나머지를 지우는 경우를 잡지 못한다.
// 유지 조건: 저장은 사람이 누른 뒤에만 일어난다. 그 순서를 보는 검사를 배선 검사로
//   바꾸면, 묻지 않고 넣는 코드가 그대로 통과한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/save-login.mjs
import { check, checkAsync, read, require_ } from "../core.mjs";

export default async function run() {
console.log("[2n4] 새 로그인을 금고에 담기");

const preload = read("native/electron/webview-preload.cjs");
const factory = read("web/js/browser/webview-factory.js");
const saveLogin = read("web/js/browser/save-login.js");
const credIpc = read("native/electron/credential-ipc.cjs");
// 부정 단언은 주석에 영향을 받는다. 제거 대상 이름이 주석에 남아 있으면 계속 실패한다.
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");

// 로그인 화면의 형태는 하나가 아니다. 폼 제출, 버튼 클릭(SPA), 엔터 입력 후 즉시 이동의
// 세 가지가 있고, 하나만 처리하면 나머지 사이트에서는 아무것도 수집되지 않는다.
check("게스트가 세 자리에서 로그인을 거둔다", () =>
  /document\.addEventListener\("submit", function \(e\) \{[\s\S]{0,120}sendCapture\(e\.target\)/.test(preload)
  && /document\.addEventListener\("click"[\s\S]{0,600}sendCapture\(el\.form \|\| document\)/.test(preload)
  && /window\.addEventListener\("pagehide", function \(\) \{ sendCapture\(document\); \}/.test(preload));

// 사용자가 입력하지 않은 값은 수집하지 않는다. isTrusted 를 확인하지 않으면 페이지 스크립트가 아무 값이나
// 제출해 금고에 밀어 넣을 수 있다.
check("사람이 친 것만 거둔다", () => {
  const seg = /document\.addEventListener\("submit"[\s\S]*?window\.addEventListener\("pagehide"/.exec(preload);
  if (!seg) throw new Error("거두는 자리를 못 찾음");
  return (seg[0].match(/isTrusted/g) || []).length >= 2;
});

// 게스트는 비신뢰 문서다. 여기서 금고에 직접 쓸 수 있으면 페이지가 스스로 자격증명을 심는다.
check("게스트는 금고에 직접 쓰지 않는다", () =>
  !/saveCred|ac-cred-save/.test(bare(preload))
  && /ipcRenderer\.sendToHost\("ac-login-captured", cap\)/.test(preload));

// AI가 채워 넣은 값이 금고에 남으면 조작 한 번이 영구 자격증명이 된다.
check("AI가 조작 중인 탭에서는 담지 않는다", () => {
  const seg = /if \(e\.channel === "ac-login-captured"\) \{[\s\S]*?\n    \}/.exec(factory);
  if (!seg) throw new Error("ac-login-captured 처리를 못 찾음");
  const gate = seg[0].indexOf("if (autofillBlocked(tabId)) return;");
  const call = seg[0].indexOf('callHook("savelogin.offer"');
  return gate > 0 && call > 0 && gate < call;
});

// 판정 쪽에도 같은 차단이 있어야 한다. 연결 한 줄이 빠지면 판정이 마지막 방어선이 된다.
await checkAsync("판정도 조작 중을 거른다", async () => {
  const mod = await import(new URL("../../../web/js/browser/save-login.js", import.meta.url).href);
  const base = { origin: "https://a.com", username: "u", password: "p" };
  const TABLE = [
    ["새 로그인", { ...base }, "new"],
    ["조작 중", { ...base, blocked: true }, "blocked"],
    ["안 함을 눌렀던 것", { ...base, dismissed: true }, "ignore"],
    ["이미 같은 것이 있다", { ...base, known: "p" }, "ignore"],
    ["비밀번호가 바뀌었다", { ...base, known: "old" }, "update"],
    ["비번이 비었다", { ...base, password: "" }, "ignore"],
    ["아이디가 비었다", { ...base, username: "" }, "ignore"],
    ["http(s) 가 아니다", { ...base, origin: "file:///x" }, "ignore"],
  ];
  for (const [label, input, want] of TABLE) {
    const got = mod.saveDecision(input);
    if (got !== want) throw new Error(`${label}: ${got} (기대 ${want})`);
  }
  return true;
});

// 묻지 않고 저장하면 그것은 수집이다. saveCred 는 사람이 누르는 콜백 안에만 있어야 한다.
check("묻기 전에는 저장하지 않는다", () => {
  const at = saveLogin.indexOf("export async function offerSaveLogin");
  if (at < 0) throw new Error("offerSaveLogin 을 못 찾음");
  const body = saveLogin.slice(at);
  const ask = body.indexOf("  askBar(");            // 정의가 아니라 부르는 자리
  const call = body.indexOf("host.saveCred(");
  if (ask < 0 || call < 0) throw new Error("막대나 저장 호출을 못 찾음");
  return call > ask;                       // 저장은 막대를 세운 뒤의 콜백 안에서만 일어난다
});

// Chrome 쪽 저장소는 수정하지 않는다. 이 경로의 저장 대상은 자체 금고뿐이다.
check("이 길은 Chrome 저장소를 건드리지 않는다", () =>
  !/Login Data|chrome-password|chromeProfile/.test(bare(saveLogin) + bare(credIpc)));

// 여기가 핵심이다. 한 건 넣기가 통째 교체로 구현되면 그 파티션의 다른 로그인이 전부 사라진다.
// 가짜 금고로 실제 함수를 실행한다.
check("한 건을 넣어도 나머지가 남는다", () => {
  const { createCredentialService } = require_("../native/electron/credential-service.cjs");
  const files = new Map();
  const fs = fakeFs(files);
  const svc = createCredentialService({ stateDir: "/vault", safeStorage: plainSafeStorage(), fs });
  svc.set("persist:p1", [
    { origin: "https://a.com", username: "old", password: "1" },
    { origin: "https://b.com", username: "keep", password: "2" },
  ]);
  if (!svc.add("persist:p1", { origin: "https://c.com", username: "new", password: "3" })) {
    throw new Error("add 가 실패로 돌아왔다");
  }
  const got = svc.listAccounts("persist:p1").map((l) => l.origin + "|" + l.username).sort().join(" / ");
  if (got !== "https://a.com|old / https://b.com|keep / https://c.com|new") throw new Error(got);
  // 같은 origin+아이디는 교체한다. 비밀번호를 변경한 것이므로 두 건이 남으면 안 된다.
  svc.add("persist:p1", { origin: "https://a.com", username: "old", password: "9" });
  const rows = svc.listAccounts("persist:p1").filter((l) => l.username === "old");
  if (rows.length !== 1) throw new Error(`같은 계정이 ${rows.length}벌`);
  if (svc.passwordFor("persist:p1", "https://a.com", "old") !== "9") throw new Error("비밀번호가 안 바뀜");
  return true;
});

// 읽지 못한 금고에 한 건을 덮어쓰면 그 파일에는 그 한 건만 남는다. 가져오기로 다시
// 채울 수 있는 경우와 달리, 여기서 잃은 데이터는 복구할 수 없다.
check("읽지 못한 금고에는 얹지 않는다", () => {
  const { createCredentialService } = require_("../native/electron/credential-service.cjs");
  const files = new Map([["/vault/creds.enc", Buffer.from("이건 우리 형식이 아니다")]]);
  const fs = fakeFs(files);
  const broken = { isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: () => { throw new Error("해독 실패"); } };
  const svc = createCredentialService({ stateDir: "/vault", safeStorage: broken, fs });
  const ok = svc.add("persist:p1", { origin: "https://a.com", username: "u", password: "p" });
  if (ok !== false) throw new Error("읽지 못한 금고에 썼다");
  if (String(files.get("/vault/creds.enc")) !== "이건 우리 형식이 아니다") throw new Error("원본이 바뀌었다");
  return true;
});

// persist 는 {written} 객체를 반환한다. 그대로 반환하면 쓰기에 실패한 회차도 참이 되어,
// 화면에는 저장 완료로 표시되지만 금고에는 아무것도 없다.
check("못 쓰면 성공으로 돌려주지 않는다", () => {
  const { createCredentialService } = require_("../native/electron/credential-service.cjs");
  const svc = createCredentialService({ stateDir: "/vault", fs: fakeFs(new Map()),
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) } });
  return svc.add("persist:p1", { origin: "https://a.com", username: "u", password: "p" }) === false;
});

// 게스트가 직접 호출할 수 있으면 위의 모든 차단이 무효가 된다.
check("저장 요청은 신뢰 발신자와 알려진 프로필만", () => {
  const seg = /ipcMain\.handle\("ac-cred-save"[\s\S]*?\n  \}\);/.exec(credIpc);
  if (!seg) throw new Error("ac-cred-save 를 못 찾음");
  return /if \(!isTrustedSender\(e\)\)/.test(seg[0])
    && /if \(!isProfilePartition\(partition\)\)/.test(seg[0])
    && /\/\^https\?:\\\/\\\/\/\.test\(origin\)/.test(seg[0])
    && /if \(!username \|\| !password\)/.test(seg[0]);
});
}

// 금고는 파일 하나만 사용한다. 메모리 맵으로 충분하고, 실제 디스크를 쓰면 검사가 사용자 금고
// 옆에 파일을 남긴다.
function fakeFs(files) {
  return {
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
    renameSync: (a, b) => {
      if (!files.has(a)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      files.set(b, files.get(a)); files.delete(a);
    },
    mkdirSync: () => {},
    chmodSync: () => {},
  };
}

function plainSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: (b) => Buffer.from(b).toString("utf8"),
  };
}
