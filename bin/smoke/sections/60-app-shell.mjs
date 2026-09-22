// 소유 범위: [3b] 스페이스 생성·닫기부터 [10b] 보관함·기기 에뮬레이션까지의 앱 셸 계약.
// 제공 API: 원래 [3b] 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 앱 셸·서버·네이티브 소스, slice-anchor와 Node API.
// 유지 조건: 검사 이름·순서·문구, LIVE 분기, 임시 경로 격리, full smoke 출력.
// 영향 범위: 러너가 34 앱 선택 섹션 뒤·40 QA 증거 섹션 앞에서 이 run을 호출한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/60-app-shell.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  b4Function, cannotMeasure, check, checkAsync, fnBody, LIVE, read, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiTabs, allCss, allWebJs, archive, archiveHandlers, browserState, browserStateOwner, cdpCmdPageSource, contextMenu, css, dock, keynav, main, mainJs, mainWindowSource, mcp, profiles, rail, screenMarkup, serverIndexSource as srv, touchDragPanel, tree, viewportPanel, web, webview, webviewFactory, workspaceHandlers, workspaceRuntime,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[3b] 스페이스 생성/닫기");
const herdrSrc = read("server/herdr.js");
check("herdr workspace.create 배선", () => /workspaceCreate\([\s\S]{0,300}"workspace\.create"/.test(herdrSrc));
check("herdr workspace.close 배선", () => /workspaceClose\([\s\S]{0,200}"workspace\.close"/.test(herdrSrc));
// cwd를 넘기지 않으면 herdr가 서버의 cwd를 그대로 써서 어느 폴더에도 속하지 않는 스페이스가 생긴다.
check("스페이스 생성은 절대경로 폴더를 요구", () => /path\.isAbsolute\(cwd\)/.test(workspaceHandlers) && /space\.create/.test(workspaceHandlers));
check("이름 생략 시 폴더 이름을 쓴다", () => /path\.basename\(cwd\)/.test(workspaceHandlers));
// herdr는 workspace.create 직후 잠시 홈 폴더를 identity_cwd로 내보낼 수 있다.
// 그래서 요청 cwd로 즉시 바인딩하되, identity와 루트 pane이 함께 이동하면 새 폴더 객체로 따라간다.
check("스페이스 생성 응답을 요청 폴더에 묶은 뒤 재계산", () => {
  const handler = fnBody(workspaceHandlers, "handleSpace");
  const seg = sliceBetween(handler, 'if (msg.type === "space.create")', '} else if (msg.type === "space.close")', "스페이스 생성 응답을 요청 폴더에 묶은 뒤 재계산");
  const bind = seg.indexOf("bindSpaceFolder(id, cwd)");
  const recomputeAt = seg.indexOf("recompute()", bind);
  return bind >= 0 && recomputeAt > bind;
});
check("transient identity는 루트 pane과 일치할 때만 요청 폴더를 바꾼다", () => {
  const sk = read("server/space-key.js");
  return /export const REQUESTED/.test(sk)
    && /spaceKey\.REQUESTED/.test(workspaceRuntime)
    && /rootCwd.*spaceKey\.realDir\(rootCwd\).*spaceKey\.realDir\(confirmed\)/s.test(workspaceRuntime)
    && /src === CONFIRMED \? 2/.test(sk);
});
check("폴더 객체 키는 재부팅 dev와 무관한 v2 inode·birthtime으로 정해진다", () => {
  const sk = read("server/space-key.js");
  return /fs\.statSync\(dir, \{ bigint: true \}\)/.test(sk)
    && /FOLDER_KEY_VERSION = "v2"/.test(sk)
    && !/st\.dev\.toString\(36\)/.test(sk)
    && /st\.ino\.toString\(36\)/.test(sk)
    && /st\.birthtimeNs/.test(sk);
});
// 안쪽에서 개수를 담는 const 가 바깥의 이력 배열과 이름이 같으면 블록 전체가 TDZ 가 되고,
// 옮길 것이 없어 일찍 돌아가는 정상 경로가 예외를 던져 catch 로 들어가 "이관 실패"가 출력된다.
// 소스 패턴으로는 드러나지 않으므로 실제로 호출해서 확인한다.
// 출력 문구가 실제 동작과 다르면 다른 문구도 신뢰할 수 없다.
await checkAsync("옮길 것이 없는 기동은 조용하다 — 거짓 이관 실패를 찍지 않는다", async () => {
  const mod = await import(new URL("../../../server/browser-state-owner.js", import.meta.url).href);
  const said = [];
  const original = console.log;
  console.log = (...args) => said.push(args.join(" "));
  let out;
  try { out = mod.migrateSpaceKeys([{ id: "ws-probe" }], []); }
  finally { console.log = original; }
  if (said.some((line) => line.includes("이관 실패"))) throw new Error(`옮길 것이 없는데 실패를 찍었다: ${said.join(" / ")}`);
  if (!out || out.changed !== false || !Array.isArray(out.moved)) throw new Error("반환 모양이 다르다");
  // 아무 workspace 도 없으면 아예 손대지 않는다.
  const empty = mod.migrateSpaceKeys([], []);
  if (empty.changed !== false || empty.moved.length) throw new Error("빈 목록에서 무언가를 옮겼다");
  return true;
});
check("놓친 창도 레거시 경로→폴더 객체 이력을 재접속 때 받는다", () => {
  const sk = read("server/space-key.js");
  return /export function remapsFor/.test(sk)
    && /remaps: spaceKey\.remapsFor/.test(browserStateOwner)
    && /spaceKeysWire\(\)/.test(srv)
    && /applySpaceKeys\(m\.map \|\| \{\}, m\.remaps \|\| \{\}\)/.test(web)
    && /remapWindowStores\(remaps\)/.test(web);
});
// herdr는 경로를 직접 입력받고 스페이스 이름은 폴더 이름으로 붙인다(.../my-app → "my-app").
check("폴더는 경로 입력으로 받는다", () => /askText\("새 스페이스 폴더"/.test(contextMenu) && !/pickFolder/.test(allWebJs));
check("~ 경로를 푼다", () => /os\.homedir\(\)/.test(workspaceHandlers) && /startsWith\("~\/"\)/.test(workspaceHandlers));
check("스페이스 추가 버튼(로컬 전용)", () =>
  /id="space-add"/.test(web) && /addBtn\.hidden = !getIsLocal\(\)/.test(tree));
check("스페이스 닫기는 확인을 거친다", () => /space\.close/.test(contextMenu) && /confirm\(/.test(contextMenu));
// window.prompt는 이 런타임에 없어서 호출하면 예외가 나고 그 기능 전체가 동작하지 않는다.
check("web에 window.prompt 호출이 없다", () => !/[=(,]\s*prompt\(/.test(web));
check("이름 입력은 askText로", () => /function askText\(/.test(contextMenu));

console.log("[3c] Explorer 파일·폴더 생성");
// 트리 행도 다른 목록 행과 같은 모서리 값을 쓴다. 여기만 직각이면 같은 화면에서 행 모양이
// 두 가지가 되므로, 값이 달라지지 않게 검사로 강제한다.
check("파일 트리 행 모서리가 항목 크기로 통일됨", () =>
  /\.fitem\s*\{[^}]*border-radius:\s*var\(--r-blk\)\s*;/.test(css("10-sidebar"))
  && !/\.fitem\s*\{[^}]*border-radius:\s*0\s/.test(allCss));
check("Explorer 헤더에 로컬 전용 새 파일·새 폴더 진입점이 있음", () =>
  /id="file-add"/.test(web) && /id="folder-add"/.test(web)
  && /fileAdd\.hidden\s*=\s*!getIsLocal\(\)\s*\|\|\s*!s\s*\|\|\s*!s\.folder/.test(tree)
  && /folderAdd\.hidden\s*=\s*!getIsLocal\(\)\s*\|\|\s*!s\s*\|\|\s*!s\.folder/.test(tree));
check("헤더와 트리 컨텍스트 메뉴가 같은 생성 함수로 수렴함", () => {
  const create = sliceBetween(contextMenu, "async function createFsEntry", "function createEntryMenuItems", "헤더와 트리 컨텍스트 메뉴가 같은 생성 함수로 수렴함");
  return /askText\(/.test(create)
    && /op:\s*kind\s*===\s*"file"\s*\?\s*"create-file"\s*:\s*"create-dir"/.test(create)
    && /createEntryMenuItems\(/.test(contextMenu)
    && /file-add"\)\?\.addEventListener/.test(contextMenu)
    && /folder-add"\)\?\.addEventListener/.test(contextMenu);
});
check("서버 생성은 로컬·루트·실경로·단일 이름·무덮어쓰기를 강제함", () => {
  const src = read("server/fs-handlers.js");
  const body = sliceBetween(src, "export async function handleFsOp", "// fs.tree", "서버 생성은 로컬·루트·실경로·단일 이름·무덮어쓰기를 강제함");
  return /op\s*===\s*"create-file"\s*\|\|\s*op\s*===\s*"create-dir"/.test(body)
    && /fsPathAllowed\(destDir\)/.test(body) && /realUnderRoot\(destDir\)/.test(body)
    && /name\.includes\("\/"\)/.test(body) && /name\.includes\("\\\\"\)/.test(body)
    && /flag:\s*"wx"/.test(body) && /fs\.mkdirSync\(dest,[^)]*recursive:\s*false/.test(body)
    && /같은 이름이 이미 있습니다/.test(body);
});
check("생성 성공은 부모를 갱신하고 새 파일만 연다", () => {
  const branch = fnBody(mainJs, "handleFsOpMessage");
  return /m\.op\s*===\s*"create-file"[\s\S]{0,180}openFile\(m\.newPath\)/.test(branch)
    && /collapsed\.dirs\.delete\(m\.parent\)/.test(branch)
    && /Array\.isArray\(m\.refresh\)/.test(branch);
});
check("생성 응답은 파일·폴더 모두 새 행 포커스를 예약함", () => {
  const branch = fnBody(mainJs, "handleFsOpMessage");
  const fsBranch = fnBody(mainJs, "handleFsMessage");
  const setter = b4Function(tree, "setPendingCreateFocus");
  return /setPendingCreateFocus\(\{\s*path:\s*m\.newPath,\s*parent:\s*m\.parent,\s*isDir:\s*m\.op\s*===\s*"create-dir"\s*\}\)/.test(branch)
    && /pendingCreateFocus\s*=\s*value/.test(setter)
    && (fsBranch.match(/focusCreatedAfterList\(m\.path\)/g) || []).length === 2;
});
check("생성된 행은 파일·폴더 공통 강조 후 트리 가운데로 스크롤됨", () => {
  const focus = b4Function(tree, "focusCreatedAfterList");
  const render = b4Function(tree, "renderDir");
  return /treeFocusPath\s*=\s*p\.path/.test(focus)
    && /p\.isDir\s*\?[^:]*\.fitem\.dir\[data-dir=[^:]*:\s*[^;]*\.fitem\.file\[data-file=/.test(focus)
    && /scrollIntoView\s*\(\s*\{\s*block:\s*"center"\s*\}\s*\)/.test(focus)
    && (render.match(/treeFocusPath\s*===\s*e\.path/g) || []).length >= 2;
});

console.log("[3.9] 계정 정체성 — 목록을 못 받은 채 새 계정을 만들지 않는다");
// 새 프로필 id는 곧 새 파티션이고, 새 파티션은 빈 세션이다. "계정이 없다"와 "아직 모른다"를
// 구분하지 못하면 가져오기가 이미 있는 계정을 두고 빈 계정을 하나 더 만들고, 사용자에게는
// 로그인이 사라진 것으로 보이며 원래 세션은 디스크에 참조 없이 남는다.
// 그래서 소스 문자열이 아니라 실제 함수를 떼어 내 실행한다. 소스 패턴 검사로는 이 판정을 확인할 수 없다.
function profileImportChooser(loaded) {
  const src = profiles.match(/function profileForChromeImport\([\s\S]*?\n\}/);
  if (!src) throw new Error("profileForChromeImport를 찾지 못했다");
  const made = [];
  const fn = new Function("isBrowserStateLoaded", "getProfileChromeSource", "getProfiles", "newProfileId", "made",
    src[0] + "\nreturn profileForChromeImport;")(
      () => loaded,
      () => ({ "p_keep": "chrome:Profile 6" }),
      () => [{ id: "", name: "기본" }, { id: "p_keep", name: "쓰던 계정" }],
      () => { const id = "p_new"; made.push(id); return id; },
      made);
  return { fn, made };
}
check("목록을 받기 전 가져오기는 새 계정을 만들지 않는다", () => {
  const { fn, made } = profileImportChooser(false);
  const r = fn("chrome:Profile 99", "새 라벨");
  return r && r.unknown === true && r.isNew === false && made.length === 0;
});
check("목록을 받은 뒤에는 같은 Chrome 프로필을 기존 계정에 다시 묶는다", () => {
  const { fn, made } = profileImportChooser(true);
  const r = fn("chrome:Profile 6", "아무 라벨");
  return r && r.isNew === false && r.profile && r.profile.id === "p_keep" && made.length === 0;
});
check("목록을 받은 뒤 정말 새로운 Chrome 프로필만 새 계정이 된다", () => {
  const { fn, made } = profileImportChooser(true);
  const r = fn("chrome:Profile 99", "새 라벨");
  return r && r.isNew === true && r.profile && r.profile.id === "p_new" && made.length === 1;
});
check("가져오기 호출부가 '모른다'를 그대로 통과시키지 않는다", () =>
  /const target = profileForChromeImport\(cid, label\);\s*\n\s*if \(target\.unknown\) return \{ error:/.test(profiles));
check("손으로 계정을 더하는 길도 목록을 받기 전에는 막힌다", () =>
  /function addProfile\(name\) \{[\s\S]{0,200}?if \(!isBrowserStateLoaded\(\)\) return null;/.test(profiles));
check("받았다는 표시는 상태를 실제로 갈아끼우는 자리에서만 뜬다", () => {
  const sets = browserState.match(/loaded = true/g) || [];
  return sets.length === 1
    && /export function replaceBrowserState\(state\) \{\s*browserState = state;\s*loaded = true;/.test(browserState)
    && /if \(st\) replaceBrowserState\(st\);/.test(aiTabs);
});

console.log("[3.95] 처음 켜는 사람 — 알아서 깔린다");
// 문서에 "herdr를 먼저 깔아라"라고 적어 두는 것만으로는 강제되지 않는다. 설치하지 않은 사용자는
// 앱은 떠도 터미널·에이전트·스페이스가 빈 화면이라, 고장인지 설치가 덜 된 것인지 알 수 없다.
// 그래서 setup 이 직접 설치하는 경로를 두고, 그 경로가 사라지지 않도록 여기서 검사한다.
const setupSh = read("scripts/setup.sh");
const setupEntry = read("setup");
check("저장소 맨 위의 setup이 실제 스크립트로 넘긴다", () =>
  /exec bash "\$\(dirname "\$0"\)\/scripts\/setup\.sh" "\$@"/.test(setupEntry));
check("setup이 herdr를 확인하고 없으면 깐다", () =>
  /command -v herdr/.test(setupSh)
  && /brew install herdr/.test(setupSh)
  && /herdr\.dev\/install\.sh/.test(setupSh));
// 검증된 경로를 먼저 쓴다. homebrew-core 는 병에 체크섬이 붙기 때문이다. 인터넷 스크립트를
// 셸에 바로 넘기는 경로는 brew 가 안 될 때의 대비책이고 첫 번째 선택이 아니다.
check("brew 경로가 인터넷 스크립트보다 먼저 온다", () =>
  setupSh.indexOf("brew install herdr") < setupSh.indexOf("herdr.dev/install.sh"));
// 사용자 컴퓨터에서 인터넷 스크립트를 확인 없이 실행하지 않는다. 실행 전에 반드시 묻는 단계가 있어야 한다.
check("인터넷 스크립트는 묻고 나서만 실행한다", () => {
  // 같은 문구가 사람에게 보여 주는 echo 줄과 실제로 실행하는 줄에 두 번 나오므로, 실행하는 줄만 확인한다.
  const lines = setupSh.split("\n");
  const runIdx = lines.findIndex((l) => /^\s*curl -fsSL https:\/\/herdr\.dev\/install\.sh \| sh/.test(l));
  if (runIdx < 0) return false;
  const before = lines.slice(Math.max(0, runIdx - 6), runIdx).join("\n");
  // 무엇을 실행하는지 보여 주는 줄도 따로 있어야 사용자가 모른 채 지나가지 않는다.
  const shown = lines.some((l) => /^\s*echo .*curl -fsSL https:\/\/herdr\.dev\/install\.sh \| sh/.test(l));
  return /if ask "/.test(before) && shown;
});
// 대답할 사람이 없는 환경(파이프·CI)에서는 설치를 진행하지 않는다.
check("대답할 사람이 없으면 설치하지 않는다", () =>
  /\[ -t 0 \] \|\| return 1/.test(setupSh));
// 에이전트 연결. Iris 의 도구는 MCP 로 제공되므로 등록이 없으면 에이전트에서 Iris 를 쓸 수
// 없다. README 안내만으로는 부족해서 setup 이 직접 등록한다. 등록은 각 CLI 의 사용자 설정을
// 수정하는 일이라 묻고 나서만 하고, 경로는 이 저장소의 iris-mcp.mjs 절대 경로다(앱 안의 사본은
// asar 에 포함되어 밖에서 실행할 수 없다).
check("setup이 Claude Code·Codex에 이 저장소의 iris-mcp를 등록한다", () =>
  /IRIS_MCP="\$\(pwd\)\/bin\/iris-mcp\.mjs"/.test(setupSh)
  && /claude mcp add --scope user iris-mcp -- node "\$IRIS_MCP"/.test(setupSh)
  && /codex mcp add iris-mcp -- node "\$IRIS_MCP"/.test(setupSh)
  && /install-agent-context\.mjs --app \/Applications\/Iris\.app --check/.test(setupSh));
check("MCP 등록은 묻고 나서만 한다", () => {
  const lines = setupSh.split("\n");
  // 주석이나 `:` 로 비활성화한 줄은 실행되지 않는다. 그런 줄을 집계하면 실행이 빠져도 통과한다.
  const live = (l) => !/^\s*(?:#|:)/.test(l);
  const adds = lines.map((l, i) => [l, i]).filter(([l]) => live(l) && /\brun (?:claude|codex) mcp add /.test(l));
  if (adds.length !== 2) return false;
  return adds.every(([, i]) => /if ask "/.test(lines.slice(Math.max(0, i - 3), i).join("\n")));
});
// 등록되어 있다는 것과 실제로 쓸 수 있다는 것은 다르다. 저장소를 옮기면 등록은 남고 파일은 없다.
// 그래서 판정은 파일 유무까지 보고, 등록 뒤에는 조회로 이 저장소 경로가 들어갔는지 확인하며, 실행할
// 명령은 묻기 전에 보여 준다. 셋 중 하나라도 빠지면 "등록됨" 판정이 사실과 달라질 수 있다.
check("MCP 등록 판정은 파일 유무·등록 뒤 재조회·묻기 전 명령 표시를 갖춘다", () => {
  const lines = setupSh.split("\n").filter((l) => !/^\s*(?:#|:)/.test(l));
  const at = (re) => lines.findIndex((l) => re.test(l));
  const has = (re) => at(re) >= 0;
  // 표시는 묻는 줄보다 앞에 있어야 "보여 주고 묻는다" 가 된다.
  const shownBeforeAsk = (shown, ask) => at(shown) >= 0 && at(shown) < at(ask);
  return has(/^mcp_file_exists\(\) \{/) && has(/^\s*case "\$1" in \/\*\) \[ -f "\$1" \] && return 0/)
    && has(/&& mcp_file_exists "\$REG"; then/) && lines.filter((l) => /mcp_file_exists "\$REG"/.test(l)).length === 2
    && has(/\[ "\$\(claude_iris_args\)" = "\$IRIS_MCP" \] && ok/)
    && has(/\[ "\$\(codex_iris_args\)" = "\$IRIS_MCP" \] && ok/)
    // 조회 결과는 전역(REG·IRIS_NAME)에 쓴다. $( ) 안에서 바꾼 이름은 밖에 남지 않아 옛 이름을 제거하지 못한다.
    && has(/^find_iris\(\) \{/) && !/\$\(find_iris /.test(setupSh) && lines.filter((l) => /^\s*find_iris (?:claude|codex)$/.test(l)).length === 2
    // iris-mcp 이름을 다른 도구가 쓰고 있으면 그 등록을 지우거나 덮지 않는다. 그 판정이 --check 가지보다 앞에 온다.
    && lines.map((l, i) => [l, i]).filter(([l]) => /^\s*elif \[ -n "\$TAKEN" \]; then$/.test(l))
      .filter(([, i]) => lines.slice(i + 1, i + 4).some((l) => /^\s*elif \[ "\$CHECK" = "1" \]; then$/.test(l))).length === 2
    && shownBeforeAsk(/info "\\\$ claude mcp add --scope user iris-mcp -- node \$IRIS_MCP"/, /if ask "Claude Code 에 iris-mcp/)
    && shownBeforeAsk(/info "\\\$ codex mcp add iris-mcp -- node \$IRIS_MCP"/, /if ask "Codex 에 iris-mcp/);
});
check("CLI가 없는 에이전트는 실패가 아니라 건너뜀이다", () =>
  /if ! command -v claude[^\n]*\n\s*info /.test(setupSh) && /if ! command -v codex[^\n]*\n\s*info /.test(setupSh));
// 6단계는 한 step 안에 설치 위치가 셋이라, 아래의 "가장 가까운 CHECK 분기" 검사로는 둘째·셋째
// 위치의 분기가 빠져도 첫째 것 때문에 통과한다. 위치마다 자기 블록 머리부터 확인한다.
check("에이전트 연결의 세 자리 각각이 --check 가지를 앞에 둔다", () => {
  const sites = [
    ["if ! command -v claude", "run claude mcp add"],
    ["if ! command -v codex", "run codex mcp add"],
    ["if [ -d /Applications/Iris.app ]; then", "run node scripts/install-agent-context.mjs"],
  ];
  return sites.every(([head, cmd]) => {
    const at = setupSh.indexOf(cmd);
    const from = setupSh.lastIndexOf(head, at);
    return at > 0 && from >= 0 && setupSh.slice(from, at).includes('CHECK" = "1"');
  });
});
check("--check는 아무것도 설치하지 않는다", () => {
  // 설치를 실제로 하는 코드는 전부 CHECK=1일 때 건너뛰는 분기 안에 있어야 한다.
  const installs = ["brew install herdr", "curl -fsSL https://herdr.dev/install.sh | sh", "pnpm install", "scripts/install-app.sh",
    "claude mcp add", "codex mcp add", "run node scripts/install-agent-context.mjs"];
  return installs.every((cmd) => {
    const at = setupSh.indexOf(cmd);
    if (at < 0) return false;
    const before = setupSh.slice(0, at);
    // 가장 가까운 앞선 CHECK 분기가 "확인만" 쪽을 먼저 처리하고 있어야 한다.
    return before.lastIndexOf('CHECK" = "1"') > before.lastIndexOf("step \"");
  });
});
// 라이선스 고지는 한 번 적고 두면 최신이 아니게 된다. 의존성이 하나 늘면 표는 그대로인데
// 내용이 사실과 달라진다. 그래서 확인 시점의 직접 의존성 목록을 문서에 적어 두고 여기서 대조한다.
// 어긋나면 다시 확인한다: pnpm licenses list --prod
check("제3자 고지가 지금의 직접 의존성을 담고 있다", () => {
  const doc = read("THIRD-PARTY.md");
  const deps = new Set(Object.keys(JSON.parse(read("package.json")).dependencies || {}));
  const at = doc.indexOf("이때의 직접 의존성은 이것들이었다");
  if (at < 0) return false;
  // 뒤에 다른 절이 붙어도 포함되지 않도록 그 문단이 끝나는 지점까지만 본다.
  const para = doc.slice(at).split("\n\n")[0];
  const listed = new Set((para.match(/`([^`]+)`/g) || []).map((s) => s.slice(1, -1))
    .filter((n) => n !== "package.json"));
  // 항목이 빠지거나 남아 있으면 둘 다 최신이 아니므로, 양쪽이 정확히 같아야 한다.
  return listed.size === deps.size && [...deps].every((d) => listed.has(d));
});
check("README 설치 명령이 함께 있다", () => {
  const rd = read("README.md");
  const at = rd.indexOf("## 설치하기");
  if (at < 0) return false;
  const next = rd.indexOf("\n## ", at + 1);
  const seg = rd.slice(at, next < 0 ? undefined : next);
  // clone 이 만드는 폴더는 저장소 이름(Iris)이다. 대소문자를 가리는 파일 시스템에서는 `cd iris` 가 틀린다.
  return /git clone[^\n]*\ncd Iris\n\.\/setup/.test(seg);
});

// README 에 적힌 명령은 실제로 실행되는 명령이어야 한다.
//
// 예를 들어 `pnpm test --fast` 는 pnpm 이 그 플래그를 자기 것으로 읽어
// `Unknown option: 'fast'` 로 실패한다. 러너는 `--fast` 를 지원하므로 코드 쪽에는 증상이
// 없고 처음 온 사람만 막힌다. 같은 문서에서 없는 스크립트를 적는 것과 걸리는 시간을 실제와
// 다르게 적는 것도 문제가 되며, 이 검사는 플래그 가로채기와 없는 스크립트를 막는다.
check("README 가 대는 pnpm 명령이 실재한다", () => {
  const rd = read("README.md");
  const scripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts || {}));
  // pnpm 자신의 명령. 이 이름들은 같은 이름의 스크립트가 있어도 pnpm 이 자기 명령을 실행한다.
  //
  // 예를 들어 `scripts.audit` 을 만들고 README 에 `pnpm audit` 이라 적으면 실제로 실행되는 것은
  // 의존성 취약점 감사다. 스크립트는 있고 `pnpm run audit` 으로는 실행되므로 "없는 이름"
  // 검사로는 잡히지 않는다. 이름은 있는데 다른 것이 실행되는 어긋남이다.
  //
  // `test`·`start`·`restart`·`stop` 은 여기 넣지 않는다. pnpm 이 같은 이름의 스크립트를
  // 부르는 단축 경로라서 가로채는 것이 아니다.
  const SHADOWED = new Set(["audit", "list", "ls", "why", "outdated", "licenses", "publish", "pack",
    "prune", "root", "bin", "env", "config", "doctor", "dedupe", "init", "setup", "link", "unlink",
    "import", "fetch", "patch", "server", "store", "update", "up", "add", "remove", "rm",
    "create", "deploy", "dlx", "exec", "rebuild", "install", "i", "run"]);
  const bad = [];
  for (const [, block] of rd.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block.split("\n")) {
      const m = /^\s*pnpm\s+([\w:-]+)((?:\s+\S+)*)/.exec(line.replace(/\s+#.*$/, ""));
      if (!m) continue;
      const [, name, rest] = m;
      if (SHADOWED.has(name)) {
        // 스크립트가 있는데 이 이름을 쓰면 이름은 맞지만 다른 명령이 실행된다.
        if (scripts.has(name)) bad.push(`pnpm 자신의 명령과 이름이 겹친다: pnpm ${name}`);
        continue;   // 스크립트가 없으면 그냥 pnpm 명령을 적은 것이다
      }
      if (!scripts.has(name)) { bad.push(`없는 스크립트: pnpm ${name}`); continue; }
      // 스크립트에 넘기는 플래그는 `--` 뒤에 와야 pnpm 이 자기 것으로 가로채지 않는다.
      const args = rest.trim().split(/\s+/).filter(Boolean);
      const dash = args.indexOf("--");
      const early = args.findIndex((a) => a.startsWith("-"));
      if (early >= 0 && (dash < 0 || early < dash)) bad.push(`pnpm 이 가로챈다: pnpm ${name} ${args[early]}`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 저장소 안의 실행 파일을 맨 이름으로 부르는 안내는 그 이름이 PATH 에 있는 기계에서만 맞다.
//
// 예를 들어 two-flows 가 `iris-browser tabs` 를 적어도, 그 명령이 도는 이유가
// 손으로 만든 `~/.local/bin/iris-browser` 심볼릭 링크일 수 있다. package.json 에 `bin` 이
// 없고 `./setup` 도 링크를 만들지 않으므로, 갓 복제한 사용자에게는 "command not found" 가 된다.
// 이 기계에서만 통과하는 안내는 공개본에서 첫 실패가 된다.
check("문서가 저장소 실행 파일을 맨 이름으로 부르지 않는다", () => {
  const pkg = JSON.parse(read("package.json"));
  const onPath = new Set(Object.keys(pkg.bin || {}));   // pnpm 이 링크해 주는 것만 맨 이름이 된다
  const setup = read("scripts/setup.sh");
  const names = [];
  for (const f of readdirSync(path.join(ROOT, "bin")).filter((x) => /\.(?:mjs|cjs|js|sh)$/.test(x))) {
    const base = f.replace(/\.[^.]+$/, "");
    if (!/^[a-z][a-z0-9-]*$/.test(base)) continue;      // graph·importers 같은 흔한 단어도 여기 든다
    if (onPath.has(base)) continue;
    if (new RegExp(`(?:ln -s|/${base}["' ]).*${base}`).test(setup)) continue;   // setup 이 링크해 주면 괜찮다
    names.push(base);
  }
  if (!names.length) cannotMeasure("bin 에서 이름을 하나도 못 뽑았다 — 세는 방식이 깨졌다");
  const docs = [
    ...readdirSync(ROOT).filter((f) => f.endsWith(".md")),
    ...readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ];
  const bad = [];
  for (const d of docs) {
    // 코드 펜스 안만 본다. 산문 줄은 명령이 아니라서, Task.md 의 "smoke 227 → 234 ok" 같은 줄을
    // 명령으로 읽으면 안내가 아닌 것을 잡는다.
    for (const [, block] of read(d).matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)) {
      for (const line of block.split("\n")) {
        const cmd = /^\s*(?:[A-Z_]+=\S+\s+)*([a-z][a-z0-9-]*)\s/.exec(line);
        if (!cmd) continue;
        if (names.includes(cmd[1])) bad.push(`${d}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  if (bad.length) throw new Error(`PATH 에 없는 이름을 부른다 — ${bad.join(" / ")}`);
  return true;
});

// DESIGN.md 는 팔레트의 hex 와 역할 토큰 이름을 그대로 적는다. 사람은 그 표를 보고 색을
// 고르므로, 표가 CSS 와 달라지면 없는 토큰이나 다른 색을 쓰게 된다. 예를 들어 다크
// 기본 절이 `--primary #33C3F5` 로 적혀 있어도 실제 값은 `var(--pal-skype)` 이고, `--ai` 를
// 「바이올렛」이라 적어도 실제는 `--pal-pink` 인 경우가 있었다(팔레트에 바이올렛은 없다).
check("DESIGN.md 가 대는 색·토큰이 CSS 와 같다", () => {
  const doc = read("DESIGN.md");
  const css = allCss;   // 이미 이어붙인 문자열이다
  const bad = [];
  // 1층: 표에 적힌 hex 는 그 이름의 실제 값이어야 한다.
  const rows = [...doc.matchAll(/\|\s*`(--pal-[\w-]+)`\s*\|\s*(#[0-9A-Fa-f]{3,8})\s*\|/g)];
  if (rows.length < 5) cannotMeasure(`팔레트 표에서 ${rows.length}줄밖에 못 읽었다 — 세는 방식이 깨졌다`);
  for (const [, name, hex] of rows) {
    const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
    if (!m) bad.push(`${name} 이 CSS 에 없다`);
    else if (m[1].trim().toLowerCase() !== hex.toLowerCase()) bad.push(`${name} 문서 ${hex} / CSS ${m[1].trim()}`);
  }
  // 2층: 역할 토큰은 이름만 본다(값은 팔레트를 참조하므로 hex 로 비교할 대상이 아니다).
  const roleLine = doc.split("\n").find((l) => l.startsWith("이름 규칙: 기존 역할")) || "";
  const roles = [...roleLine.matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]);
  if (roles.length < 5) cannotMeasure(`역할 토큰을 ${roles.length}개밖에 못 읽었다 — 세는 방식이 깨졌다`);
  for (const r of roles) if (!new RegExp(`${r}\\s*:`).test(css)) bad.push(`${r} 이 CSS 에 없다`);
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 「이 규칙은 저 검사가 막는다」는 문서의 약속이다. 검사 이름이 바뀌거나 사라지면 그 약속은
// 사실과 달라지고, 읽는 사람은 막혀 있다고 믿고 더 확인하지 않는다.
//
// 모든 괄호를 보지는 않는다. 「…괄호가 그 검사 이름이다」라고 직접 밝힌 문서만 이 규칙의 대상이다
// (그 관례를 설명만 하는 문장은 밝힌 것이 아니다. CONTRIBUTING 이 그렇다).
// 밝히지 않은 문서가 인용부호를 다르게 쓰는 것은 이 검사의 대상이 아니다.
check("검사 이름을 대는 문서가 실재하는 이름을 댄다", () => {
  const mdFiles = [
    ...readdirSync(ROOT).filter((f) => f.endsWith(".md")),
    ...readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ];
  const declared = mdFiles.filter((f) => /괄호[^\n]*검사 이름이다/.test(read(f)));
  if (!declared.length) return true;   // 밝힌 문서가 없으면 검사할 대상도 없다
  // 검사 안에서 스위트를 실행할 수 없으므로, 이름은 실행 결과가 아니라 소스에서 정적으로 뽑는다.
  // 템플릿 리터럴로 만든 이름은 잡히지 않지만, 확인하려는 것은 존재 여부뿐이라 상위집합이면 된다.
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const known = new Set();
  for (const f of ["bin/smoke.mjs", ...sourceFiles("smoke")]) {
    for (const m of read(f).matchAll(/check(?:Async)?\(\s*"((?:[^"\\]|\\.)*)"/g)) known.add(flat(m[1]));
  }
  if (known.size < 100) cannotMeasure(`검사 이름을 ${known.size}개밖에 못 뽑았다 — 세는 방식이 깨졌다`);
  const bad = [];
  for (const f of declared) {
    for (const m of read(f).matchAll(/\("([^"]{4,})"/g)) {
      const name = flat(m[1]);
      // 검사 이름은 한글이 든 문장이다. 코드 식별자·경로는 후보가 아니다.
      if (!/\s/.test(name) || !/[가-힣]/.test(name)) continue;
      if (!known.has(name)) bad.push(`${f}: "${name}"`);
    }
  }
  if (bad.length) throw new Error(`그런 검사가 없다 — ${bad.join(" / ")}`);
  return true;
});

// ── 판정 세 종류 ───────────────────────────────────────────
// 위반과 "못 잰 것"은 다른 사실이므로 다른 단어로 출력한다. 사람이 손으로 나누면 진짜 위반이
// "환경 탓"으로 분류될 수 있어서, 검사 층위가 구분한다. 다만 throw 를 곧바로 셋째 칸으로
// 보내면 안 된다. 이 스위트에서 throw 는 단언 관용구라 803건 중 765건이 위반을 뜻하므로,
// cannotMeasure 를 호출한 경우만 셋째 칸이다.
// 소스 패턴으로 검사하지 않는다. 리터럴 대조로 썼을 때는 caught 분기를 전부 bad 로 되돌리는
// 변이를 잡지 못했다. 이름도 클래스도 그대로라 네 리터럴이 모두 통과했기 때문이다.
// 그래서 core 를 새로 import 해서 실제로 실행하고 출력된 줄을 읽는다. 계수기가 모듈 수준이라
// 캐시를 피해 import 하면 이 회차의 집계를 건드리지 않는다.
await checkAsync("계측기가 답을 못 낸 것과 위반이 다른 낱말로 나간다", async () => {
  const fresh = await import(pathToFileURL(path.join(ROOT, "bin/smoke/core.mjs")).href + "?verdict=" + process.pid);
  const said = [];
  const real = console.log;
  console.log = (x) => said.push(String(x));
  try {
    fresh.check("맞는 것", () => true);
    fresh.check("어긋난 것", () => false);
    fresh.check("못 잰 것", () => fresh.cannotMeasure("목록이 0개다"));
    fresh.summary();
  } finally { console.log = real; }
  const line = (head) => said.find((l) => l.startsWith(head));
  return !!line("  ok   맞는 것")
    && !!line("  FAIL 어긋난 것")
    && !!line("  못 잰 것 못 잰 것 — 목록이 0개다")
    && said.some((l) => /결과: 1 ok \/ 1 위반 \/ 1 못 잰 것/.test(l));
});
// 셋째 칸이 종료코드를 0으로 두면 cannotMeasure 가 검사를 우회하는 통로가 된다. 못 잰 것 8건에
// 위반 0건은 통과가 아니라 판정 없음이고, 하류(release-audit)는 문자열이 아니라 종료코드로
// 합격을 판정하므로 둘을 함께 반영한다.
check("못 잰 것만 있어도 종료코드가 0이 아니다", () => {
  const core = read("bin/smoke/core.mjs");
  return /return fail \|\| blind \? 1 : 0;/.test(core)
    && /결과: \$\{pass\} ok \/ \$\{fail\} 위반 \/ \$\{blind\} 못 잰 것/.test(core);
});
// 실패 요약에 못 잰 것이 빠지면 어디를 볼지 모르는 채로 실패를 받게 된다. \b 는 한글 뒤에
// 설 수 없어서(\w 와 그 밖의 경계인데 한글이 \w 가 아니다) 뒤 공백으로 좁힌다.
// /못 잰 것\b/ 는 한 줄도 잡지 못한다.
check("러너의 실패 요약이 못 잰 것도 함께 담는다", () => {
  const runner = read("scripts/run-tests.mjs");
  const m = /if \(!(\/\^[^\n]*?\/)\.test\(lines\[i\]\)\) continue;/.exec(runner);
  if (!m) cannotMeasure("러너의 실패 줄 매처를 못 떼었다 — 세는 방식이 깨졌다");
  const re = new RegExp(m[1].slice(1, -1));
  return re.test("  못 잰 것 어떤 검사")
    && re.test("  못 잰 것 어떤 검사 — 사유")
    && re.test("  FAIL 어떤 검사")
    && !re.test("  ok   어떤 검사");
});

// 공개하면 안 되는 단어 목록이 두 곳에 있으면 서로 달라진다. 위생 검사에 계정 이름 넷을 더했을 때
// 내보내기 쪽은 그대로여서, 스위트는 잡았지만 공개본을 내는 마지막 단계는 잡지 못했다.
// 막는 단계가 검사하는 단계보다 약하면 실제로 막히지 않는다.
// 그래서 판정 함수는 scripts/private-traces.mjs 하나로 두고, 단어 목록은 git 이 추적하지 않는 옆
// 파일에 둔다. 도구는 공개본에 포함되지만 찾는 단어는 포함되지 않는다.
const traceOwner = "scripts/private-traces.mjs";
const privateList = "scripts/private-traces.local.mjs";
const hygieneSrc = read("bin/check-public-hygiene.mjs");
const exporterSrc = read("scripts/export-public.mjs");
const ownerSrc = read(traceOwner);
check("공개 흔적 판정의 자리는 하나다", () => {
  // 두 소비자 어느 쪽도 자기 목록을 새로 선언하지 않고, 판정 함수를 소유 파일에서 받는다.
  const redefines = (src) => /const\s+(TRACES|SKIP|BINARY)\s*=\s*\//.test(src);
  return !redefines(hygieneSrc) && !redefines(exporterSrc)
    && /import \{[^}]*scanLine[^}]*\} from "\.\.\/scripts\/private-traces\.mjs"/.test(hygieneSrc)
    && /import \{[^}]*scanLine[^}]*\} from "\.\/private-traces\.mjs"/.test(exporterSrc);
});
check("아는 낱말 목록은 git 이 모른다", () => {
  // 소유 파일은 목록을 직접 담지 않고 옆 파일에서 불러온다. 그 옆 파일은 .gitignore 에 있어
  // 추적되지 않으므로 공개본에 포함되지 않는다.
  if (/export const TRACES = \//.test(ownerSrc)) return false;
  if (!new RegExp(`PRIVATE_LIST_PATH = "${privateList}"`).test(ownerSrc)) return false;
  const tracked = execFileSync("git", ["ls-files", "--", privateList], { cwd: ROOT, encoding: "utf8" }).trim();
  if (tracked) return false;
  try { execFileSync("git", ["check-ignore", "-q", privateList], { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; }
});
check("목록 없이는 공개본을 내지 않는다", () =>
  // 작성자 트리에서 목록 파일이 없는 채로 내보내면 단어가 하나도 걸러지지 않는다. 그래서 내보내기는
  // 목록이 없으면 명시적 --shape-only 없이 중단한다.
  /TRACES_LOADED/.test(exporterSrc) && /!TRACES_LOADED && !SHAPE_ONLY/.test(exporterSrc) && /--shape-only/.test(exporterSrc));

console.log("[4] 브라우저 정체성 — 엔진 기본값과 인증 호환");
const hard = read("native/electron/browser-hardening.cjs");
check("Electron 런타임은 유지하고 모바일 오인 Iris 토큰만 제거한다", () => {
  const { cleanUserAgent } = require_(path.join(ROOT, "native/electron/browser-hardening.cjs"));
  const out = cleanUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Iris/0.1.0 Chrome/150.0.0.0 Electron/43.2.0 Safari/537.36");
  return /Electron\/43/.test(out) && !/Iris\//.test(out) && /Chrome\/150/.test(out);
});
check("브라우저 API를 위장하는 스크립트를 주입하지 않는다", () => {
  const scripts = [hard, read("native/electron/webview-lifecycle.cjs"), read("native/electron/main-window.cjs")].join("\n");
  return !/ANTI_DETECTION_SCRIPT|antiDetectionScript/.test(scripts)
    && !/Permissions\.prototype\.query\s*=|Object\.defineProperty\(navigator/.test(hard);
});
check("일반 Client Hints는 엔진이 소유하고 Google 예외만 공통 담당 모듈에 맡긴다", () =>
  /rewriteGoogleAuthHeaders\(details\.requestHeaders, details\.url, details\)/.test(hard)
  && !/Google Chrome|sec-ch-ua-mobile/.test(hard));

function servedWebAppOk(fetchSource, base = new URL("http://127.0.0.1:4271/")) {
  const root = fetchSource(base);
  if (root.status !== "200" || !/^text\/html(?:\s*;|$)/i.test(root.contentType)) return false;
  const scripts = [...root.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match) => ({ attrs: match[1], body: match[2] }));
  const moduleEntry = scripts.find((script) =>
    /\btype\s*=\s*(?:["']module["']|module(?:\s|$))/i.test(script.attrs)
    && /\bsrc\s*=\s*["'][^"']+["']/i.test(script.attrs));
  if (!moduleEntry) {
    return scripts.some((script) => !/\bsrc\s*=/i.test(script.attrs)
      && /\bwindow\.__orcaSet\s*=\s*function\s*\(/.test(script.body)
      && /\bwindow\.__orcaSet\s*\(/.test(script.body));
  }
  const src = moduleEntry.attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  const entryUrl = new URL(src, base);
  if (entryUrl.origin !== base.origin) return false;
  const entry = fetchSource(entryUrl);
  if (entry.status !== "200" || !/^text\/javascript(?:\s*;|$)/i.test(entry.contentType)) return false;
  const imports = new Set();
  for (const match of entry.body.matchAll(/\b(?:import\s+(?:[^"'()]*?\s+from\s*)?|export\s+[^"']*?\s+from\s*)["']([^"']+)["']/g)) imports.add(match[1]);
  for (const match of entry.body.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) imports.add(match[1]);
  for (const specifier of imports) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
    const importedUrl = new URL(specifier, entryUrl);
    if (importedUrl.origin !== base.origin) return false;
    const imported = fetchSource(importedUrl);
    if (imported.status !== "200" || !/^text\/javascript(?:\s*;|$)/i.test(imported.contentType)) return false;
  }
  return true;
}

check("라이브 진입점 판정은 인라인·모듈과 네 실패 경계를 구분", () => {
  const base = new URL("http://127.0.0.1:4271/");
  const scenario = (rootBody, files = {}, rootType = "text/html; charset=utf-8") => (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/") return { body: rootBody, status: "200", contentType: rootType };
    return files[pathname] || { body: "", status: "404", contentType: "text/plain" };
  };
  const inline = '<script>window.__orcaSet = function (on) {}; window.__orcaSet(true);</script>';
  const moduleHtml = '<script type="module" src="/js/main.js"></script>';
  const modules = {
    "/js/main.js": { body: 'import "./a.js"; import "./b.js";', status: "200", contentType: "text/javascript" },
    "/js/a.js": { body: "export const a = 1;", status: "200", contentType: "text/javascript" },
    "/js/b.js": { body: "export const b = 1;", status: "200", contentType: "text/javascript" },
  };
  const missingImport = { ...modules, "/js/b.js": { body: "", status: "404", contentType: "text/plain" } };
  return servedWebAppOk(scenario(inline), base)
    && servedWebAppOk(scenario(moduleHtml, modules), base)
    && !servedWebAppOk(scenario("<main>Iris</main>"), base)
    && !servedWebAppOk(scenario("<script>/* __orcaSet */</script>"), base)
    && !servedWebAppOk(scenario(moduleHtml, missingImport), base)
    && !servedWebAppOk(scenario(inline, {}, "text/plain"), base);
});

if (LIVE) {
  console.log("[5] 라이브 — 서버·브라우저 경로");
  check("서버 200", () => execFileSync("/usr/bin/curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:4271/"], { encoding: "utf8" }).trim() === "200");
  // 두 게이트는 응답 본문이 다르다. AC6(전역 IP 필터)는 "forbidden", AC5(/browser-cmd 루프백 전용)는
  // "local only (AC5)". 그래서 본문을 정확히 대조하면 어느 쪽이 걸렸는지 구분되고, 한쪽을 지웠을 때
  // 다른 쪽이 대신 막아도 검사가 통과해버리는 일이 없다.
  const lanIp = (() => {
    try { return execFileSync("/usr/sbin/ipconfig", ["getifaddr", "en0"], { encoding: "utf8" }).trim(); } catch { return ""; }
  })();
  const post = (host, iface) => execFileSync("/usr/bin/curl", [
    ...(iface ? ["--interface", iface] : []), "-s", "--max-time", "4", "-X", "POST",
    "-H", "content-type: application/json", "-d", '{"cmd":"url","args":{}}', `http://${host}:4271/browser-cmd`,
  ], { encoding: "utf8" });

  check("비루프백 원격은 전역 필터에서 차단(AC6 실동작)", () => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(lanIp)) { console.log("       (LAN 주소 없음 — 건너뜀)"); return true; }
    let reach = "";
    try { reach = execFileSync("/usr/bin/curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", `http://${lanIp}:4271/`], { encoding: "utf8" }).trim(); } catch {}
    if (!reach || reach === "000") { console.log("       (루프백 전용 바인딩 — 원격 경로 자체가 없음)"); return true; }
    const body = post(lanIp).trim();
    // AC6가 사라지면 AC5가 대신 막으면서 본문이 "local only (AC5)"로 바뀐다 → 이 검사는 실패한다.
    return body === "forbidden";
  });
  check("Tailscale 대역도 /browser-cmd는 거부(AC5 실동작)", () => {
    let ts = "";
    try { ts = execFileSync("/opt/homebrew/bin/tailscale", ["ip", "-4"], { encoding: "utf8" }).trim().split("\n")[0].trim(); } catch {}
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ts)) { console.log("       (Tailscale 주소 없음 — 건너뜀)"); return true; }
    // 전역 필터는 100.64/10을 허용하므로 여기서 거부하는 것은 AC5뿐이다. AC5를 지우면 명령이 실행돼 통과한다.
    const body = post(ts, ts).trim();
    return /local only \(AC5\)/.test(body);
  });
  check("서버가 현재 index.html 서빙", () => {
    const base = new URL("http://127.0.0.1:4271/");
    const fetchSource = (url) => {
      const marker = "\n__IRIS_SMOKE_RESPONSE__";
      const out = execFileSync("/usr/bin/curl", ["-sS", "-w", `${marker}%{http_code}\t%{content_type}`, String(url)],
        { encoding: "utf8", maxBuffer: 32e6 });
      const split = out.lastIndexOf(marker);
      if (split < 0) throw new Error("curl 응답 메타데이터가 없음");
      const [status, contentType = ""] = out.slice(split + marker.length).split("\t");
      return { body: out.slice(0, split), status, contentType };
    };
    return servedWebAppOk(fetchSource, base);
  });
  // 스페이스 격리 이후 이 검사들은 "실행하는 세션의 스페이스에 브라우저 탭이 있을 때"만 성립한다.
  // 탭이 없는 건 제품 결함이 아니라 전제 미충족이므로 왜 못 돌았는지 남기고 넘어간다.
  // 다른 오류는 그대로 실패시킨다. 건너뛰기가 실제 고장을 감추면 계측기가 아니다.
  const NO_TAB = /열린 브라우저 탭이 없습니다|제어할 브라우저 탭이 없습니다/;
  const evalCheck = (name, expr, test) => check(name, () => {
    let out;
    try { out = execFileSync(process.execPath, [path.join(ROOT, "bin/iris-browser.mjs"), "eval", expr], { encoding: "utf8", timeout: 20000 }); }
    catch (e) {
      const msg = String((e.stderr || "") + (e.stdout || "") + (e.message || ""));
      if (NO_TAB.test(msg)) { console.log("       (이 세션의 스페이스에 브라우저 탭 없음 — 건너뜀)"); return true; }
      throw new Error(msg.slice(0, 160));
    }
    return test(out);
  });
  evalCheck("활성 브라우저 탭 응답(iris-browser eval)", "1+1", (o) => /2/.test(o));
  // userAgentData는 보안 컨텍스트(https·localhost)에서만 존재한다. 평문 http 페이지가 열려 있으면
  // 값이 비는데 이는 하드닝 결함이 아니라 검사 전제 미충족이다. 둘을 섞으면 계측기가 못 된다.
  evalCheck("brands 위장(Google Chrome 포함)",
    "window.isSecureContext + '@' + (navigator.userAgentData&&navigator.userAgentData.brands||[]).map(function(b){return b.brand}).join('|')",
    (o) => {
      const [secure, brands] = String(o).trim().split("@");
      if (secure !== "true") { console.log("       (현재 탭이 보안 컨텍스트 아님 — userAgentData 자체가 없음, 건너뜀)"); return true; }
      return /Google Chrome/.test(brands || "");
    });
}

console.log("[9] 보관함 — 접기·되살리기");
const arc = read("server/archive.js");
// 복원 키가 없는 세션을 보관하면 그대로 사라지므로, 그 경계가 이 기능의 안전장치다.
check("열쇠 없는 세션은 접지 않는다", () => /sessionUuid/.test(archiveHandlers) && /되살릴 수 없습니다/.test(archiveHandlers));
check("모르는 종류는 접지 않는다", () => /canResume/.test(arc) && /canResume/.test(archiveHandlers));
check("claude·codex 재개 명령을 안다", () => /"claude", "--resume"/.test(arc) && /"codex", "resume"/.test(arc));
check("보관은 로컬만(AC5)", () => {
  const handler = fnBody(archiveHandlers, "handleArchive");
  return /!ws\._local/.test(handler);
});
// 닫은 뒤에는 화면을 읽을 수 없다. 순서가 뒤바뀌면 마지막 100줄이 비어 버린다.
check("마지막 화면은 닫기 전에 읽는다", () => {
  const m = archiveHandlers.match(/const tail = await readTail[\s\S]{0,300}/); if (!m) return false;
  return m[0].indexOf("archive.add") < m[0].indexOf("paneClose");
});
check("마지막 내용을 200줄 저장한다", () => /TAIL_LINES = 200/.test(arc) && /readTail/.test(archiveHandlers));
// pane.read는 화면에 보이는 만큼(약 55줄)만 준다. 200줄은 세션 기록에서 가져와야 한다.
check("내용은 세션 기록에서 뽑는다", () => /export function transcriptTail/.test(arc) && /archive\.transcriptTail/.test(archiveHandlers));
check("claude·codex 기록 위치를 안다", () => /claudeHome\("projects"\)/.test(arc) && /codexHome\("sessions"\)/.test(arc));
// 홈을 옮긴 사용자(CLAUDE_CONFIG_DIR·CODEX_HOME)는 경로를 직접 조합한 파일에서 기록·인증을
// 읽지 못한다. 그래서 경로 해석은 server/agent-homes.js 한 곳에 두고, 다른 서버 파일이
// `".claude"`·`".codex"` 를 경로 조각으로 직접 쓰지 못하게 한다.
check("claude·codex 홈 경로는 agent-homes 한 곳이 푼다", () => {
  const homes = read("server/agent-homes.js");
  if (!/CLAUDE_CONFIG_DIR/.test(homes) || !/CODEX_HOME/.test(homes)) return false;
  const offenders = readdirSync(path.join(ROOT, "server"))
    .filter((f) => /\.(js|cjs|mjs)$/.test(f) && f !== "agent-homes.js")
    .filter((f) => /["'`]\.(claude|codex)["'`]/.test(read(`server/${f}`)));
  return offenders.length === 0;
});
// codex 기록은 931MB에 이른다. 전체를 읽으면 문자열 길이 한계에 걸려 실패한다.
check("기록은 끝에서만 읽는다", () => /function tailBytes/.test(arc) && /fs\.readSync\(fd, buf, 0, len, size - len\)/.test(arc) && !/readFileSync\([^)]*jsonl/.test(arc));
check("기록이 없으면 화면이라도 남긴다", () => /paneRead\(paneId, "recent"/.test(archiveHandlers));

console.log("[10] 개발자 도구(F12)");
// <webview>는 요소 쪽 API로 열어야 한다. 메인에서 게스트 webContents.openDevTools()는 열리지 않는다.
check("webview 요소 API로 연다", () => /r\.el\.openDevTools\(\)/.test(touchDragPanel) && /r\.el\.isDevToolsOpened\(\)/.test(touchDragPanel));
check("F12는 수식키 없이 단독", () => /"devtools": \{ key: "F12" \}/.test(mainWindowSource)
  && /def: \{ key: "F12" \}/.test(read("web/js/core/keymap.js")));
check("webview 포커스 시 main이 넘긴다", () => /const hit = matchRelay\(input\);\s*\n\s*if \(hit\) return send\(hit\);/.test(mainWindowSource) && /case "devtools": toggleDevTools/.test(dock));
check("앱 UI 포커스에서도 F12", () => /matchBinding\(e, bindingOf\("devtools"\)\)/.test(keynav));
check("브라우저 탭이 아니면 알린다", () => /개발자 도구는 브라우저 탭에서 열립니다/.test(touchDragPanel));
check("버튼과 F12가 같은 함수를 쓴다", () => /#wv-devtools"\)\.addEventListener\("click", \(\) => toggleDevTools\(\)\)/.test(mainJs)
  && /function toggleDevTools/.test(touchDragPanel));

console.log("[10b] 탭 화면 크기");
// devtools 기기 툴바는 <webview> 대상에 버튼이 표시되지 않으므로, 같은 동작을 CDP로 수행한다.
{
  // 기기 성격·크기 적용의 소유자는 cdp-device-emulation 이고, cdp0(=cdp-control)에는 명령 등록만 있다.
  // 항목마다 어느 쪽이 소유자인지 확인해 검사 대상을 정한다.
  const pre2 = read("native/electron/preload.cjs"), cdp0 = read("native/electron/cdp-control.cjs");
  const devEmu = read("native/electron/cdp-device-emulation.cjs");
  // 주소줄에서 호출하든 AI가 호출하든 적용은 한 함수(applyViewportTo)가 한다. 나뉘면 한쪽이 최신이 아니게 된다.
  check("메인이 CDP로 크기를 지정한다", () => /ipcMain\.handle\("ac-viewport"/.test(main)
    && /applyViewportTo\(target, arg/.test(main) && /Emulation\.setDeviceMetricsOverride/.test(devEmu)
    && /Emulation\.clearDeviceMetricsOverride/.test(devEmu));
  // 원격·게스트가 자기 권한을 넓히지 못하도록 앱 UI origin에서만 허용한다.
  check("크기 지정은 신뢰된 발신자만", () => /ac-viewport"[\s\S]{0,200}?isTrustedSender\(e\)/.test(main));
  check("대상은 webview 게스트만", () => /ac-viewport"[\s\S]{0,400}?getType\(\) !== "webview"/.test(main));
  check("다리에 setViewport가 있다", () => /setViewport: \(opts\) => ipcRenderer\.invoke\("ac-viewport", opts\)/.test(pre2));
  check("주소줄에 크기 버튼", () => /id="wv-size"/.test(web) && /#wv-size"\)\.addEventListener\("click"/.test(web));
  check("프리셋과 직접 입력·해제", () => /VIEWPORT_PRESETS/.test(viewportPanel) && /직접 입력…/.test(touchDragPanel) && /해제\(원래 크기\)/.test(touchDragPanel));
  check("탭마다 따로 기억한다", () => /const viewportByTab = \{\}/.test(viewportPanel) && /viewportByTab\[tabId\] = vp/.test(viewportPanel));
  // 게스트가 새로 만들어지면 지정이 사라지므로, 버튼에 없는 크기를 표시하면 안 된다.
  check("webview가 사라지면 표시도 지운다", () => /delete viewportByTab\[tid\]/.test(webviewFactory));
  check("탭을 바꾸면 버튼이 따라온다", () => /updateSizeBtn\(\);/.test(webviewFactory) && /function updateSizeBtn/.test(viewportPanel));
  // AI도 같은 동작을 할 수 있어야 한다. 사람과 AI가 다른 방법을 쓰면 한쪽이 최신이 아니게 된다.
  const acb = read("bin/iris-browser.mjs"), mcp2 = read("bin/iris-mcp.mjs");
  check("AI도 크기를 바꾼다", () => /async viewport\(_send, wc, args\)/.test(cdpCmdPageSource) && /case "viewport"/.test(acb)
    && /name: "browser_viewport"/.test(mcp2));
  check("AI가 바꾸면 버튼도 따라간다", () => /setViewportNotify/.test(cdp0) && /setViewportNotify\(\(wcId, vp\)/.test(main)
    && /ac-viewport-changed/.test(pre2) && /onViewportChanged/.test(web));

  // Chrome 기기 모드와 같다. 화면 자체가 그 크기가 되고 가운데 놓인다. 배율은 적용하지 않는다.
  // 배율을 적용하면 크기 조절이 아니라 확대·축소가 된다.
  check("화면이 실제로 그 크기가 된다", () => /\.wv-wrap\.sized webview\.active \{ inset:auto/.test(css("18-browser"))
    && /width:var\(--vw\); height:var\(--vh\)/.test(css("18-browser")));
  check("배율(확대·축소)은 걸지 않는다", () => !/--vscale/.test(allCss));
  check("작아진 화면은 가운데", () => /wrap\.clientWidth - vp\.w\) \/ 2/.test(viewportPanel) && /wrap\.clientHeight - vp\.h\) \/ 2/.test(viewportPanel));
  check("가장자리 손잡이로 직접 끈다", () => /id="wvh-r"/.test(web) && /id="wvh-b"/.test(web) && /id="wvh-c"/.test(web)
    && /function startSizeDrag/.test(touchDragPanel) && /addEventListener\("mousedown", \(e\) => startSizeDrag/.test(mainJs));
  // .wv-handle{display:flex}가 UA의 [hidden]{display:none}보다 우선해, 숨긴 손잡이가 공간만 차지하고
  // 다른 탭에서도 크기 조절 커서를 가져갔다.
  check("손잡이는 크기 지정한 탭에만 있다", () => /\.wv-handle \{ display:none/.test(css("18-browser"))
    && /\.wv-wrap\.sized \.wv-handle:not\(\[hidden\]\) \{ display:flex/.test(css("18-browser")));
  // webview는 별도 프로세스라 덮지 않으면 끄는 동안 마우스를 페이지가 가져간다.
  check("끄는 동안 덮개를 씌운다", () => /wv-dragmask/.test(touchDragPanel) && /d\.mask\.remove\(\)/.test(touchDragPanel));
  check("끌기는 프레임마다 한 번만 반영", () => /requestAnimationFrame\(\(\) => \{\s*d\.pending = 0/.test(touchDragPanel));

  console.log("[10c] 크기에 따라 기기 성격이 따라간다");
  // 페이지는 폭만 보지 않으므로, UA·터치·클라이언트 힌트가 함께 바뀌어야 모바일로 인식된다.
  check("폭으로 기기를 가른다", () => /function deviceClassFor\(width\)/.test(devEmu)
    && /width <= 480 \? "phone" : width <= 840 \? "tablet" : "desktop"/.test(devEmu));
  check("경계가 화면 쪽과 같다", () => /w <= 480 \? "모바일" : w <= 840 \? "패드" : "데스크톱"/.test(viewportPanel));
  // ★ mobile:true면 뷰포트 meta 없는 페이지는 레이아웃 폭이 980에 고정되고 축소돼 그려진다.
  // 어떤 크기를 줘도 데스크톱 뷰가 작아진 결과만 나오고 미디어 쿼리가 적용되지 않는다.
  check("레이아웃 폭이 지정한 폭 그대로", () => /deviceScaleFactor: dpr, mobile: false/.test(devEmu));
  check("억지 배율을 넣지 않는다", () => /Number\(args\.dpr\) > 0 \? Number\(args\.dpr\) : 0/.test(devEmu));
  check("터치도 같이 켜진다", () => /Emulation\.setTouchEmulationEnabled/.test(devEmu) && /maxTouchPoints/.test(devEmu));
  // 끌 때 maxTouchPoints:0을 함께 주면 명령이 거부돼 터치가 켜진 채 남는다.
  check("데스크톱으로 가면 터치가 꺼진다", () => /cls === "desktop" \? \{ enabled: false \}/.test(devEmu));
  // 서버가 UA로 다른 페이지를 주는 사이트는 다시 받아야 모바일 뷰가 나온다. naver.com의 뷰포트
  // meta는 width=1190이라 폭만 줄이면 데스크톱 페이지가 좁아진다.
  check("기기가 바뀌면 다시 받는다", () => /const reloaded = prev !== cls && !args\.live/.test(devEmu) && /wc\.reload\(\)/.test(devEmu));
  // 사이트가 전용 모바일 주소로 이동하면 UA를 되돌려도 복원되지 않으므로, 돌아갈 주소를 보관한다.
  check("데스크톱으로 오면 원래 주소로", () => /function backToDesktop\(wc\)/.test(devEmu)
    && /cur === e\.to/.test(devEmu) && /wc\.loadURL\(e\.from\)/.test(devEmu));
  // did-stop-loading은 하위 리소스를 기다리느라 늦어, 그 사이 사용자가 이동하면 그 주소가
  // "사이트가 옮긴 주소"로 기록된다. 그래서 커밋 시점에 잡는다.
  check("넘어간 주소는 커밋 시점에 잡는다", () => /wc\.once\("did-navigate", \(_ev, url\)/.test(devEmu)
    && !/once\("did-stop-loading"/.test(cdp0));
  check("끄는 중엔 다시 받지 않는다", () => /live: !!quiet/.test(viewportPanel));
  // 터치 없는 모바일 설정은 의미가 없다. 드래그 스크롤·스와이프가 동작해야 모바일 반응을 확인한다.
  check("드래그로 스크롤된다(마우스→터치)", () => /Emulation\.setEmitTouchEventsForMouse/.test(devEmu)
    && /configuration: "mobile"/.test(devEmu));
  // ★ 이 명령만은 탭 범위에 머물지 않는다. <webview>는 OS 마우스가 감싸는 창의 위젯을 거쳐 오므로
  // 켜 두면 앱 헤더·다른 탭 커서까지 터치가 된다. 크기 지정과 함께 켜면 안 된다.
  check("크기 지정이 터치 변환을 켜지 않는다", () => {
    const cdpAll = sourceFiles("native").filter((rel) => /\/cdp-[^/]*\.cjs$/.test(rel));
    if (cdpAll.length < 2) throw new Error(`CDP 파일을 ${cdpAll.length}개만 찾았다 — 훑는 방식을 확인하라`);
    // 음성 조건은 CDP 경로 전체를 본다. 크기 지정이 어느 모듈에서든 마우스→터치를 켜면 안 된다.
    return /const dragOk = cls !== "desktop";/.test(devEmu)
      && !/ok\("Emulation\.setEmitTouchEventsForMouse", \{ enabled: true/.test(cdpAll.map((rel) => read(rel)).join("\n"));
  });
  check("포인터가 그 화면 위일 때만 켠다", () => /function setTouchDrag\(wc, on\)/.test(devEmu)
    && /mouseenter", \(\) => syncTouchDrag\(true\)/.test(mainJs) && /mouseleave", \(\) => syncTouchDrag\(false\)/.test(mainJs)
    && /function syncTouchDrag/.test(touchDragPanel));
  // 해제 신호를 하나라도 놓치면 켜진 채 남는다. 실제로 그런 상태가 발생했다.
  check("나가는 신호가 여러 겹", () => /window\.addEventListener\("blur", \(\) => syncTouchDrag\(false\)\)/.test(mainJs)
    && /visibilitychange/.test(mainJs) && /viewportLayout\(\); syncTouchDrag\(false\)/.test(dock));
  // 명령이 거부돼도 조용히 넘어가면 "폰인데 손가락 없음"이 그대로 남는다(실제 전례 있음).
  check("적용 실패를 결과에 싣는다", () => /touch: cls !== "desktop" && touchOk/.test(devEmu));
  check("UA도 같이 바뀐다", () => /sendDeviceUserAgentOverride/.test(devEmu) && /Android 15; Pixel 9/.test(devEmu));
  // UA만 바꾸고 헤더를 그대로 두면 UA는 안드로이드, 힌트는 맥이 되어 불일치가 드러난다.
  check("기기 힌트는 세션 헤더 대신 해당 탭의 CDP metadata가 소유한다", () =>
    /userAgentMetadata/.test(devEmu) && /mobile: d.uaMobile/.test(devEmu)
    && !/setDeviceLookup/.test(read("native/electron/browser-hardening.cjs")));

  // 해제하면 원래 UA로 되돌린다. CDP에는 UA 덮어쓰기를 지우는 명령이 없다.
  check("해제하면 원래 UA로 되돌린다", () => /baseUserAgents/.test(devEmu) && /restoreUa/.test(devEmu));
}

// agent.start에 tab_id를 주면 그 탭에 pane이 하나 더 생겨 빈 셸이 남는다.
check("되살리기는 탭의 pane에 직접 친다", () => /paneSendText\(slot\.paneId, cmd \+ "\\r"\)/.test(archiveHandlers) && !/agentStart/.test(archiveHandlers));
// 이름 있는 키로 제출하면 글자만 입력되고 실행되지 않는다.
check("탭에서 세션을 띄울 때도 \\r 로 제출한다", () =>
  /LAUNCHERS\[msg\.launch\] \+ "\\r"/.test(workspaceHandlers) && !/paneSendKeys/.test(workspaceHandlers));
// 스페이스를 새로 만들면 herdr가 기본 탭을 함께 만든다. 첫 세션이 그 탭을 써야 빈 탭이 남지 않는다.
check("저장해둔 이름으로 탭 이름을 붙인다", () => /tabRename\(slot\.tabId, label\)/.test(archiveHandlers));
check("기본 탭을 재사용해 빈 탭을 남기지 않는다", () => /spareRef\.spare/.test(archiveHandlers) && /spare: null/.test(archiveHandlers));
check("세션 없는 탭도 저장·복구한다", () => /tabs: Array\.isArray\(tabs\)/.test(arc) && /takeTab\(wsId, space, p\.label\)/.test(archiveHandlers));
// herdr는 실경로(/private/tmp/…)를, 사용자·저장값은 심링크 경로(/tmp/…)를 준다. 같은 폴더를 놓치면
// 살아 있는 스페이스를 못 알아보고 중복으로 만든다.
check("폴더 비교는 심링크를 푼다", () => /fs\.realpathSync\(path\.resolve\(p\)\)/.test(archiveHandlers));
check("폴더가 다르면 옮긴 뒤 잇는다", () => /cd \$\{shq\(e\.cwd\)\}/.test(archiveHandlers));
check("셸에 넘기는 값은 인용한다", () => /function shq\(/.test(archiveHandlers) && /argv\.map\(shq\)/.test(archiveHandlers));
check("보관함 페이지가 있다", () => /data-rail="archive"/.test(web) && /id="ar-body"/.test(screenMarkup));

// 스타일을 여러 파일로 가를 때 규칙 하나가 파일 경계를 넘으면, 이어붙인 결과는 원본과 똑같은데
// 각 파일은 문법이 깨진다. 브라우저는 파일 단위로 파싱하므로 그 파일에서 규칙이 적용되지 않는다.
// 확인 결과: `:root[data-theme="light"] {` 가 00-tokens 끝에서 열리고 본문·닫는 괄호가
// 01-base 앞에 있었다 → `* { box-sizing:border-box }` 가 죽고 .app 이 창보다 30px 길어져
// 터미널 아래 두 줄이 잘렸다. 이어붙여 비교하는 검사로는 잡을 수 없어 파일마다 따로 검사한다.
check("CSS 파일은 각자 문법이 성립한다", () => {
  const bad = [];
  for (const rel of sourceFiles("web").filter((f) => f.startsWith("web/css/") && f.endsWith(".css"))) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0, under = false;
    for (const ch of src) {
      if (ch === "{") depth++;
      else if (ch === "}" && --depth < 0) { under = true; break; }
    }
    if (under || depth !== 0) bad.push(`${rel}(${depth})`);
  }
  if (bad.length) throw new Error(`중괄호가 파일 안에서 닫히지 않음: ${bad.join(", ")}`);
  return true;
});


  // 폰 폭 규칙(19-terminal.css)은 콘솔의 3열을 접으려고 가운데를 숨긴다. 그 창에서는 우측
  // 터미널이 중심이라 맞다. 분리 브라우저 창은 3열이 아니라 가운데가 창 전체라, 같은 규칙이
  // 적용되면 창이 빈다. 확인 결과 폭 821에서 821x642, 폭 819에서 0x0이었다.
  // 두 화면의 폭 값이 갈라지면 다시 빈다. 리터럴을 쓰지 않고 두 값을 대조한다.
  check("좁아진 분리 브라우저 창은 가운데를 잃지 않는다", () => {
    const phone = read("web/css/19-terminal.css");
    const browser = read("web/css/18-browser.css");
    const media = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{([\s\S]*?)\n\}/g;
    const hides = [...phone.matchAll(media)]
      .filter((m) => /^\s*\.center\s*\{[^}]*display\s*:\s*none/m.test(m[2]))
      .map((m) => Number(m[1]));
    if (!hides.length) {
      cannotMeasure("19-terminal.css 에서 가운데를 내리는 폰 폭 규칙을 못 찾았다 — 세는 방식이 깨졌다");
    }
    const bad = [];
    for (const px of hides) {
      const block = [...browser.matchAll(media)].find((m) => Number(m[1]) === px);
      if (!block) { bad.push(`${px}px 을 되살리는 규칙이 18-browser.css 에 없다`); continue; }
      if (!/body\.browser-mode\s+\.center\s*\{[^}]*display\s*:\s*(?!none)[a-z-]+/.test(block[2])) {
        bad.push(`${px}px 규칙이 body.browser-mode .center 의 display 를 세우지 않는다`);
      }
    }
    if (bad.length) throw new Error(bad.join(" · "));
    return true;
  });

  // 하단 상태바가 선 뒤로 창 아래에 붙는 것들이 그 띠와 겹친다. 상태바는 24px 을 차지하고
  // z-index 도 위라, 아래에 있는 요소는 잘린 채 표시된다. 확인 결과 복사 토스트가
  // bottom:20px 이라 아래 4px 이 상태바에 먹혔고, 사용자에게는 "토스트가 일부 가려진다" 로
  // 보였다. 여백을 직접 다시 적으면 상태바 높이가 바뀔 때 그 값만 일치하지 않으므로,
  // 앱 셸이 정의한 --statusbar-h 를 쓰는지 본다. 상태바보다 위에 있는 요소(z 가 더 큰 것)는
  // 가려지지 않으므로 면제한다.
  check("상태바에 가릴 수 있는 하단 고정 요소는 --statusbar-h 를 탄다", () => {
    const cssRels = sourceFiles("web").filter((rel) => rel.startsWith("web/css/") && rel.endsWith(".css"));
    if (cssRels.length < 5) cannotMeasure(`web/css 를 ${cssRels.length} 개만 셌다 — 목록을 못 읽었다`);
    let barZ = null;
    const fixedAtBottom = [];
    for (const rel of cssRels) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = rule[2];
        if (!/position\s*:\s*fixed/.test(body)) continue;
        const sel = rule[1].trim().split("\n").pop().trim();
        const zRaw = /z-index\s*:\s*(-?\d+)/.exec(body);
        const z = zRaw ? Number(zRaw[1]) : 0;
        // 상태바 자신이 기준이다. 높이·z 를 여기 다시 적지 않고 그 규칙에서 떼어 온다.
        if (/(^|[\s,])\.statusbar(?![\w-])/.test(sel) && /(^|[;\s])bottom\s*:\s*0/.test(body)) { barZ = z; continue; }
        // border-bottom 은 위치 규칙이 아니다. 앞 글자가 `-` 라 이 패턴에 걸리지 않는다.
        const bottom = /(^|[;\s])bottom\s*:\s*([^;]+)/.exec(body);
        if (bottom) fixedAtBottom.push({ rel, sel, bottom: bottom[2].trim(), z });
      }
    }
    if (barZ === null) cannotMeasure(".statusbar 의 자리 규칙을 못 찾았다 — 기준이 없다");
    if (!fixedAtBottom.length) cannotMeasure("창 아래에 붙는 고정 요소를 하나도 못 셌다");
    const bad = fixedAtBottom
      .filter((r) => r.z < barZ && !/--statusbar-h/.test(r.bottom))
      .map((r) => `${r.rel} ${r.sel} (bottom:${r.bottom}, z:${r.z} < 상태바 ${barZ})`);
    if (bad.length) throw new Error(`상태바에 먹히는 자리: ${bad.join(" · ")}`);
    return true;
  });

}
