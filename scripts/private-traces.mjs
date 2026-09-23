// 공개하면 안 되는 것을 가리는 모듈. 판정은 여기 하나다. 검사(`bin/check-public-hygiene.mjs`)와
// 내보내기(`scripts/export-public.mjs`)가 같은 함수를 쓴다. 목록이 두 곳에 있으면 갈라지고, 막는
// 자리가 검사하는 자리보다 약하면 막는다는 말이 성립하지 않는다.
//
// 이 파일은 공개본에 그대로 나간다. 그래서 "아는 단어"는 여기 적지 않는다. 찾는 단어를 담은
// 파일이 함께 나가면 목록이 곧 유출이다. 아는 단어는 git 이 모르는 옆 파일(`.gitignore` 에
// 올라 있는 아래 경로)에 `TRACES` 정규식 하나로 두고, 있으면 싣고 없으면 모양 검사만
// 한다. 없을 때 두 소비자는 그 사실을 note 로 찍고, 내보내기는 `--shape-only` 없이는 내지 않는다.
export const PRIVATE_LIST_PATH = "scripts/private-traces.local.mjs";

// ─── 1층: 아는 단어 (git 밖) ─────────────────────────────────────────────
let TRACES = null;
try {
  const local = await import(new URL("./private-traces.local.mjs", import.meta.url).href);
  if (!(local.TRACES instanceof RegExp)) throw new Error("TRACES 가 정규식이 아니다");
  TRACES = local.TRACES;
} catch (error) {
  if (error && error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
export const TRACES_LOADED = TRACES !== null;

// 글자를 훑어도 뜻이 없는 파일들: 바이너리, 의존성에서 만들어 내는 vendor, 잠금 파일.
//
// svg 는 이 목록에 넣지 않는다. svg 는 바이너리가 아니라 글자다. Illustrator·Figma·
// Inkscape 는 저장할 때 `<metadata>` 에 만든 사람과 도구를 그대로 적는다. 지금
// `assets/icon.svg` 에는 그런 값이 없지만, 규칙이 "안 본다"로 남아 있으면 디자인 도구로
// 다시 저장하는 순간 그대로 포함되어 나간다.
export const SKIP = /\.(woff2|wasm|icns|png|ico|ttf|otf|jpg|jpeg|gif|zip|docx|xlsx)$|^web\/vendor\/|^pnpm-lock/;

// ─── 2층: 아는 단어가 아니라 모양 ───────────────────────────────────────────
//
// 단어 목록은 아는 것만 잡는다. 목록에 없는 계정 이름은 그대로 공개본까지 포함된다. 목록을
// 늘리는 것으로는 이 구멍이 닫히지 않는다. 다음에 새로 생기는 이름은 또 목록에 없기
// 때문이다.
//
// 그래서 단어가 아니라 모양으로도 본다. 개인 흔적은 대체로 세 모양 중 하나로 나타난다:
// 메일 주소, 사람 홈 경로, 바깥 호스트. 앞의 둘은 이 저장소에 있을 이유가 아예 없고,
// 마지막 하나는 있을 이유가 있으므로 허용 목록으로 관리한다.

// 시험용으로 예약된 이름들(RFC 2606·6761). 실재하지 않으므로 무엇을 적어도 흔적이 아니다.
const RESERVED_HOST = /(?:^|\.)(?:test|example|invalid|localhost)$|^example\.(?:com|org|net)$|\.example\.(?:com|org|net)$/i;

// 이 저장소가 정당하게 이름을 대는 바깥 호스트. 여기 없는 실호스트는 막는다. 새 호스트를
// 들일 때 한 줄 적게 하는 것이 목적이고, 규칙의 핵심은 목록 밖이 막힌다는 점이다.
const ALLOWED_HOSTS = new Set([
  "127.0.0.1", "0.0.0.0", "localhost",
  // 프로젝트가 의존하는 곳
  "herdr.dev", "github.com", "raw.githubusercontent.com", "www.npmjs.com", "npmjs.com",
  "nodejs.org", "www.electronjs.org", "pnpm.io", "docx-editor.dev", "www.apache.org",
  "opensource.org", "www.w3.org", "developer.mozilla.org", "www.chromium.org",
  "source.chromium.org", "bugs.chromium.org", "chromedevtools.github.io",
  "support.google.com", "security.googleblog.com", "developers.googleblog.com", "developer.chrome.com", "pptr.dev",
  "developer.android.com",
  "github.io", "xtermjs.org", "microsoft.github.io", "vercel.com", "www.gstatic.com",
  "fonts.googleapis.com", "fonts.gstatic.com", "openfontlicense.org", "tailscale.com", "www.anthropic.com",
  // 구독 사용량을 물어보는 제공자 엔드포인트 (server/usage.js)
  "api.anthropic.com", "chatgpt.com", "cloudcode-pa.googleapis.com", "opencode.ai",
  "api.kimi.com", "platform.minimax.io", "cli-chat-proxy.grok.com", "auth.x.ai",
  // 기능이 그 사이트를 대상으로 삼아 이름을 대는 곳
  //   claude.ai: Chrome 미러가 붙는 오리진, 챌린지 복구가 목적지를 가리는 기준
  //   translate.google.com: 페이지 번역이 불러오는 로더
  "claude.ai", "translate.google.com",
  // 화면·동작을 설명하려고 이름을 대는 실제 사이트
  "www.google.com", "accounts.google.com", "accounts.youtube.com", "myaccount.google.com", "mail.google.com", "naver.com", "m.naver.com",
  // 픽스처로 쓰는 일반 이름들. 특정 회사가 아니다
  "shop.com", "other.com", "a.com", "b.com", "c.com",
]);

// 파일 이름에 낀 `@`(icon_16x16@2x.png, node-pty@1.1.0.patch)는 메일이 아니다.
const NOT_MAIL = /@[\w.]*\d+x?\.(?:png|jpg|jpeg|gif|svg|webp)|@\d+\.\d+\.\d+/i;

// 사람 이름 자리에 자리표시자가 들어간 것은 흔적이 아니다.
// `<이름>` 처럼 자리표시자가 한글일 수 있어 안쪽을 문자로 잡지 않는다. `<` 로 시작하면
// 자리표시자로 본다. 그렇지 않으면 `/Users/<이름>/` 이 잘려 흔적으로 잡힌다.
// 이름은 통째로 같아야 자리표시자다. 접두사만 보면 `x` 로 시작하는 진짜 이름도 통과한다.
const PLACEHOLDER_HOME = /^\/(?:Users|home)\/(?:(?:you|x|USER|username|name)(?:\/|$)|[<$])/i;

const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 공개하기로 정한 연락처(SECURITY 의 제보 주소). 이 목록 밖의 메일은 전부 흔적이다.
const PUBLIC_MAIL = new Set(["deancontactadd@gmail.com"]);
// 경로의 맨 앞에서만 홈이다. `web/home/…` 같은 상대 경로 조각은 홈 경로가 아니다. `file://`
// 뒤는 머리로 친다. 계정 이름은 영문만이 아니다.
const HOME_RE = /(?<![A-Za-z0-9_.-])(?<!(?<!:\/)\/)\/(?:Users|home)\/[\p{L}\p{N}._<>${}-]+/gu;
// 아는 단어 목록이 모르는 자격증명도 있다. 흔한 표식(개인키 블록·발급 접두사가 정해진 토큰)은
// 단어와 무관하게 모양으로 잡는다.
const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}/;
const HOST_RE = /https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
// 사설 작업 폴더 경로. `.working/<날짜>-<이름>` 은 누가 언제 무엇을 했는지를 이름으로
// 드러내고, 공개본에는 그 폴더가 없어 가리키는 대상도 없다. 문서가 그 경로를 참조하면
// 작업 내역이 드러나고 공개본에서는 없는 파일을 가리키게 된다. 그래서 여기서 막는다.
const WORKSPACE_RE = /\.working\/[0-9]{8}-[^\s"'`)\]]+/g;
// 검토 귀속. 어느 검토가 무엇을 지적했는지는 작업 경위이지 코드의 이유가 아니므로 공개본
// 주석에 남기지 않는다. "회차" 는 QA 회차라는 제품 용어라 넣지 않는다. 단어를 띄어 조립하는
// 것은 이 파일 자신이 검사에 걸리지 않게 하기 위해서다.
const REVIEW_RE = new RegExp(["적대\\s+(?:리뷰|검토)", "재대조\\s+지적", "리뷰어\\s+지적", "Codex\\s+(?:지적|재대조)"].join("|"));

// 한 줄을 보고 무엇이 걸렸는지 돌려준다. 빈 배열이면 깨끗한 줄이다.
// 검사와 내보내기가 같은 이 함수를 쓴다. 그래야 둘이 갈라지지 않는다.
// 파일 이름에도 흔적이 남는다. 내용에 문제가 없어도 이름이 `<회사이름>-plan.md` 인 파일은
// 내용만 보는 검사를 그대로 통과해 공개본에 포함된다. 그래서 같은 단어 판정을 경로에도
// 돌린다.
//
// SKIP 보다 먼저 본다. 이름 판정에는 확장자가 상관없다. `<회사이름>-icon.png` 는 바이트를 안
// 훑어도 이름만으로 흔적이다.
export function scanPath(rel) {
  return scanLine(String(rel).replace(/[\\/]/g, " "));
}

export function scanLine(line) {
  const found = [];
  if (TRACES && TRACES.test(line)) found.push("아는 낱말");
  if (SECRET_RE.test(line)) found.push("비밀값 표식");
  for (const m of line.matchAll(MAIL_RE)) {
    const v = m[0];
    if (NOT_MAIL.test(v)) continue;
    if (RESERVED_HOST.test(v.slice(v.indexOf("@") + 1))) continue;
    if (PUBLIC_MAIL.has(v.toLowerCase())) continue;
    found.push(`메일 주소(${v})`);
  }
  for (const m of line.matchAll(HOME_RE)) {
    if (PLACEHOLDER_HOME.test(m[0])) continue;
    found.push(`사람 홈 경로(${m[0]})`);
  }
  for (const m of line.matchAll(WORKSPACE_RE)) found.push(`사설 작업 폴더 경로(${m[0]})`);
  if (REVIEW_RE.test(line)) found.push("검토 귀속");
  for (const m of line.matchAll(HOST_RE)) {
    const host = m[1].toLowerCase();
    if (RESERVED_HOST.test(host) || ALLOWED_HOSTS.has(host)) continue;
    found.push(`허용 목록에 없는 호스트(${host})`);
  }
  return found;
}
