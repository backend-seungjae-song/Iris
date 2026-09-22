// 소유 범위: 채팅 링크 인식과 주소창 검색. 무엇을 링크로 보고 무엇을 검색어로 보는지 정한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/link-and-omnibox.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2j] 채팅 링크 인식 · 주소창 검색");
// 채팅으로 오는 링크는 대부분 `[라벨](file:///…)`이다. 예전엔 맨 경로 하나만 잡아서 라벨·괄호가
// 링크 밖으로 떨어졌고, 사실상 눌리지 않았다.
check("md 링크·맨 URL·맨 경로 세 종류를 잡음", () => {
  const seg = sliceBetween(xtermWiring, "const links = [], taken = [];", "cb(links.length ? links : undefined);", "md 링크·맨 URL·맨 경로 세 종류를 잡음");
  return /const MD = /.test(seg) && /const URLRE = /.test(seg) && /const PATHRE = /.test(seg);
});
check("md 링크는 라벨~닫는 괄호가 한 덩어리", () => {
  const seg = sliceBetween(xtermWiring, "const links = [], taken = [];", "cb(links.length ? links : undefined);", "md 링크는 라벨~닫는 괄호가 한 덩어리");
  return /add\(mm\.index, mm\[0\]\.length, mm\[1\], "md"\)/.test(seg);
});
check("겹치면 더 구체적인 쪽이 이김", () => {
  const seg = sliceBetween(xtermWiring, "const links = [], taken = [];", "cb(links.length ? links : undefined);", "겹치면 더 구체적인 쪽이 이김");
  // md → URL → 경로 순서로 자리를 잡고, 이미 잡힌 구간은 다시 잡지 않는다.
  return /const overlaps = /.test(seg) && /if \(overlaps\(start, end\)\) return;/.test(seg)
    && seg.indexOf("const MD = ") < seg.indexOf("const URLRE = ")
    && seg.indexOf("const URLRE = ") < seg.indexOf("const PATHRE = ");
});
// 예전에는 세 종류 모두 그냥 클릭이면 링크였다. 지금은 수식키를 누르고 있는 동안에만 링크다.
// 남아 있는 계약은 그때와 같다: 종류별로 규칙이 다르면
// 안 된다. 누르는 사람에게 "이건 md 링크라 되고 저건 맨 경로라 안 된다"는 보이지 않는다.
check("md·URL·맨 경로가 종류별로 다른 규칙을 갖지 않는다", () => {
  // 판정 함수만 정확히 자른다. initXterm 까지 포함되면 linkHandler 의 수식키가 섞여
  // 아래 부정 조건이 항상 거짓이 된다.
  const spans = sliceBetween(xtermWiring, "export function terminalLinkSpans", "return links;\n}", "종류별 규칙 없음");
  // 구간을 잡는 쪽은 수식키를 참조하지 않는다. 수식키 검사는 제공자 첫 줄 한 곳뿐이다.
  const noModifierInSpans = !/metaKey|ctrlKey|linkMode/.test(spans);
  const oneGate = (xtermWiring.match(/if \(!linkModeHeld\(\)\)/g) || []).length === 1;
  // 셋이 한 activate 를 나눠 쓴다.
  const shared = /if \(sp\.kind !== "path"\) \{ openTerminalTarget\(sp\.text, ev\); return; \}/.test(xtermWiring);
  return noModifierInSpans && oneGate && shared;
});
check("한글 맨 경로를 토큰 전체로 잡음", () => {
  const line = xtermWiring.split("\n").find((l) => l.trimStart().startsWith("const PATHRE = "));
  if (!line) return false;
  const equalAt = line.indexOf("="), semicolonAt = line.lastIndexOf(";");
  if (equalAt < 0 || semicolonAt <= equalAt) return false;
  const src = line.slice(equalAt + 1, semicolonAt).trim();
  const re = Function("return (" + src + ")")();
  const samples = [
    "/Users/you/프로젝트/보고서.md:12",
    "docs/한글/안내.md",
    "docs/한글/안내.md", // macOS가 내놓을 수 있는 NFD 한글
  ];
  return samples.every((sample) => { re.lastIndex = 0; const hit = re.exec(sample); return hit && hit.index === 0 && hit[0] === sample; });
});
check("확장자 뒤 한국어 조사는 맨 경로 링크에서 분리", () => {
  const helper = sliceBetween(xtermWiring, "function terminalBarePathToken", "function initXterm", "확장자 뒤 한국어 조사는 맨 경로 링크에서 분리");
  const provider = sliceBetween(xtermWiring, "// 3) 맨 경로", "cb(links.length", "확장자 뒤 한국어 조사는 맨 경로 링크에서 분리");
  const resolver = sliceBetween(fileRouting, "function resolveTerminalPath", "function revealTerminalPath", "확장자 뒤 한국어 조사는 맨 경로 링크에서 분리");
  return /\(\\\.\[A-Za-z0-9\]\{1,10\}\)/.test(helper)
    && /을\|를/.test(helper)
    && /const raw = terminalBarePathToken\(mm\[0\]\)/.test(provider)
    && /let p = terminalBarePathToken\(raw\)/.test(resolver);
});
check("전각 문자가 있어도 링크 셀 범위가 실제 화면 열을 따름", () => {
  const cells = sliceBetween(xtermWiring, "const cellsAt = (ry) =>", "const softWrapped = (ry) =>", "전각 문자가 있어도 링크 셀 범위가 실제 화면 열을 따름");
  const add = sliceBetween(xtermWiring, "const add = (start, len, label, kind) =>", "// 1) 마크다운 링크", "전각 문자가 있어도 링크 셀 범위가 실제 화면 열을 따름");
  return /ln\.getCell\(col\)/.test(cells) && /cell\.getWidth\(\)/.test(cells)
    && /endX/.test(cells) && /end: \{ x: b\.endX, y: b\.y \}/.test(add);
});
check("대상 라우팅이 한 곳", () => /function openTerminalTarget/.test(fileRouting)
  && /\(https\?\|file\)/.test(sliceFrom(fileRouting, "function openTerminalTarget", 400, "대상 라우팅이 한 곳")));
// 주소창에 검색어를 넣으면 https://를 붙여 로드 실패하던 동작 교체.
check("주소창: 링크가 아니면 구글 검색", () => {
  const seg = sliceBetween(webview, "function normalizeUrl", "function activeBrowserId", "주소창: 링크가 아니면 구글 검색");
  return /const looksHost = /.test(seg) && /google\.com\/search\?q=" \+ encodeURIComponent\(u\)/.test(seg);
});
check("주소처럼 보이면 그대로 이동", () => {
  const seg = sliceBetween(webview, "function normalizeUrl", "function activeBrowserId", "주소처럼 보이면 그대로 이동");
  return /localhost\(:\\d\+\)\?/.test(seg) && /return "https:\/\/" \+ u;/.test(seg);
});

// 맨 경로에 ⌘ 를 요구하면 수식키 없이 누른 클릭은 도착해도 아무 동작이 없다.
// 그래서 오인 방지는 수식키가 아니라 대상 자체로 판단한다.
check("맨 경로도 다른 종류와 같은 문을 지난다", () => {
  const act = sliceBetween(xtermWiring, "activate: (ev) => {", "cb(links.length", "맨 경로도 같은 문");
  return /openTerminalPath\(sp\.text\)/.test(act)
    && !/metaKey|ctrlKey/.test(act)                                        // activate 안에 따로 문을 세우지 않는다
    && /if \(wantsReveal\(ev\)\) \{ revealTerminalPath\(sp\.text\); return; \}/.test(act); // ⌘⇧는 그대로 Finder
});
check("뿌리 없는 토큰은 확장자+작업폴더 안일 때만 연다", () => {
  const seg = sliceBetween(fileRouting, "function openTerminalPath", "function consoleSpace", "뿌리 없는 토큰은 확장자+작업폴더 안일 때만 연다");
  return /if \(!rooted\)/.test(seg) && /\\\.\[A-Za-z0-9\]\{1,10\}\$/.test(seg) && /roots\.some/.test(seg);
});
check("열지 못하면 이유를 말한다(조용한 실패 금지)", () => {
  const seg = sliceBetween(fileRouting, "function openTerminalPath", "function consoleSpace", "열지 못하면 이유를 말한다(조용한 실패 금지)");
  const of = sliceBetween(fileRouting, "function openFile", "function fileUrlOf", "열지 못하면 이유를 말한다(조용한 실패 금지)");
  // 거절하는 분기마다 안내 문구가 있어야 한다. 확장자로 보이지 않는 상대 경로가 조용히 반환되면,
  // 눌러도 아무 일이 없어 기능이 동작하지 않는 것으로 보인다.
  const extBranch = /\{1,10\}\$\/\.test\(p\)\) \{[\s\S]{0,300}?showToast\(/.test(seg);
  return (seg.match(/showToast\(/g) || []).length >= 3 && extBranch && /showToast\(/.test(of);
});
check("⌘⇧+클릭은 열지 않고 Finder에서 보여줌", () => {
  const seg = sliceBetween(fileRouting, "function pathOfTarget", "function openTerminalLink", "⌘⇧+클릭은 열지 않고 Finder에서 보여줌");
  return /const wantsReveal = \(ev\) => !!\(ev && ev\.shiftKey && \(ev\.metaKey \|\| ev\.ctrlKey\)\)/.test(fileRouting)
    && /if \(wantsReveal\(ev\)\) \{ const fp = pathOfTarget\(s\); if \(fp\) \{ revealTerminalPath\(fp\); return; \} \}/.test(seg);
});
check("Finder 표시는 파일에만(웹 링크 제외)", () => {
  const seg = sliceBetween(fileRouting, "function pathOfTarget", "function openTerminalTarget", "Finder 표시는 파일에만(웹 링크 제외)");
  return /return null; \/\/ http\(s\)는 파일이 아니다/.test(seg) && /decodeURIComponent/.test(seg);
});
check("열기·Finder가 같은 경로 해석을 씀", () => {
  // 두 동작이 각자 해석하면 한쪽만 동작하는 경로가 생긴다.
  const n = (fileRouting.match(/resolveTerminalPath\(/g) || []).length;
  return /function resolveTerminalPath/.test(fileRouting) && n >= 3; // 정의 + 열기 + Finder
});
check("Finder IPC는 신뢰 렌더러·존재하는 절대경로만", () => {
  const seg = sliceFrom(fsIpcSource, 'ipcMain.on("ac-reveal-in-finder"', 700, "Finder IPC는 신뢰 렌더러·존재하는 절대경로만");
  return /isTrustedSender\(e\)/.test(seg) && /path\.isAbsolute\(abs\)/.test(seg) && /fs\.existsSync\(abs\)/.test(seg);
});
// 렌더러가 임의 경로를 건네는 지점이라 거절이 소스 모양으로만 있으면 안 된다. 실제로 호출해
// 신뢰하지 않는 발신자, 없는 경로, 상대 경로가 각각 무엇을 받는지 확인한다. 휴지통은 삭제가
// 아니므로 어떤 함수가 실제로 호출됐는지도 확인한다.
await checkAsync("파일 IPC는 신뢰 발신자·존재하는 절대 경로만 받고 휴지통으로만 보낸다", async () => {
  const { createFsIpc } = require_("../native/electron/fs-ipc.cjs");
  const fsMod = require_("node:fs");
  const pathMod = require_("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "iris-fs-ipc-"));
  try {
    const target = path.join(dir, "지울 것.txt");
    fsMod.writeFileSync(target, "내용");
    const linkPath = path.join(dir, "별칭.txt");
    symlinkSync(target, linkPath);

    const revealed = [], trashed = [];
    const on = new Map(), handle = new Map();
    let trusted = true;
    createFsIpc({
      ipcMain: { on: (name, fn) => on.set(name, fn), handle: (name, fn) => handle.set(name, fn) },
      shell: {
        showItemInFolder: (p) => revealed.push(p),
        // 진짜 trashItem 은 끝나는 데 시간이 걸린다. 곧바로 밀어 넣는 가짜를 쓰면
        // await 를 지워도 검사가 통과한다(적대 검사가 짚음).
        trashItem: (p) => new Promise((resolve) => setTimeout(() => { trashed.push(p); resolve(); }, 0)),
      },
      fs: fsMod, path: pathMod,
      os: { homedir: () => dir },
      isTrustedSender: () => trusted,
    });
    for (const name of ["ac-trash-item", "ac-path-identity"]) if (!handle.has(name)) throw new Error(name + " 를 안 걸었다");
    if (!on.has("ac-reveal-in-finder")) throw new Error("ac-reveal-in-finder 를 안 걸었다");
    const reveal = on.get("ac-reveal-in-finder"), trash = handle.get("ac-trash-item"), identity = handle.get("ac-path-identity");
    const ev = {};

    // 위치 보기: 존재하는 절대 경로만 받고 `~` 는 홈 경로로 확장한다.
    reveal(ev, target);
    if (revealed.length !== 1 || revealed[0] !== target) throw new Error("있는 경로를 안 열었다");
    reveal(ev, "~/지울 것.txt");
    if (revealed.length !== 2 || revealed[1] !== target) throw new Error("~ 를 홈으로 안 폈다");
    reveal(ev, path.join(dir, "없는 것.txt"));
    reveal(ev, "지울 것.txt");
    if (revealed.length !== 2) throw new Error("없는 경로나 상대 경로를 열었다");

    // 휴지통: 삭제가 아니라 휴지통 이동이다. 실제로 그 함수가 호출되어야 한다.
    const okTrash = await trash(ev, target);
    if (!okTrash || okTrash.ok !== true) throw new Error("있는 경로를 휴지통으로 못 보냈다");
    if (trashed.length !== 1 || trashed[0] !== target) throw new Error("휴지통 경로를 거치지 않았다");
    if (!fsMod.existsSync(target)) throw new Error("휴지통 대신 지웠다");
    const gone = await trash(ev, path.join(dir, "없는 것.txt"));
    if (gone.ok !== false || gone.error !== "경로 없음") throw new Error("없는 경로를 통과시켰다");
    const relative = await trash(ev, "지울 것.txt");
    if (relative.ok !== false) throw new Error("상대 경로를 통과시켰다");

    // identity: 내용이 아니라 경로·stat 만 본다. 심링크는 canonical 로 같은 대상을 가리킨다.
    const id = await identity(ev, linkPath);
    if (id.ok !== true) throw new Error("있는 경로의 identity 를 못 냈다");
    if (id.isSymlink !== true) throw new Error("심링크를 못 알아봤다");
    if (id.canonicalPath !== fsMod.realpathSync(target)) throw new Error("canonical 이 원래 대상을 안 가리킨다");
    if (typeof id.dev !== "string" || typeof id.ino !== "string") throw new Error("dev·ino 를 숫자로 내보냈다");
    // 키가 있는 것과 그 값이 진짜인 것은 다르다. 상수로 굳혀 두면 확인창이 대상이 바뀐 것을 못 본다.
    const truth = fsMod.statSync(fsMod.realpathSync(target));
    if (id.dev !== String(truth.dev) || id.ino !== String(truth.ino)) throw new Error("dev·ino 가 진짜 stat 과 다르다");
    if (id.mtimeMs !== truth.mtimeMs || id.ctimeMs !== truth.ctimeMs || id.size !== truth.size)
      throw new Error("mtime·ctime·size 가 진짜 stat 과 다르다");
    if ("content" in id || "data" in id) throw new Error("내용을 실었다");
    const missing = await identity(ev, path.join(dir, "없는 것.txt"));
    if (missing.ok !== false || missing.missing !== true) throw new Error("없는 경로를 missing 으로 안 표시했다");

    // 신뢰하지 않는 발신자는 셋 다 거절한다.
    trusted = false;
    revealed.length = 0; trashed.length = 0;
    reveal(ev, target);
    const blockedTrash = await trash(ev, target);
    const blockedId = await identity(ev, target);
    if (revealed.length || trashed.length) throw new Error("신뢰하지 않는 발신자가 파일을 건드렸다");
    if (blockedTrash.error !== "신뢰되지 않은 발신자" || blockedId.error !== "신뢰되지 않은 발신자")
      throw new Error("신뢰하지 않는 발신자를 거절하지 않았다");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// `~/Downloads/…` 꼴 산출물 경로가 열기·Finder 둘 다 죽던 것.
check("~ 경로는 서버가 준 홈으로 펴서 해석", () => {
  const seg = sliceBetween(fileRouting, "function resolveTerminalPath", "function revealTerminalPath", "~ 경로는 서버가 준 홈으로 펴서 해석");
  return /p\.startsWith\("~\/"\)/.test(seg) && /hostHome/.test(seg)
    && /if \(!hostHome\) return null/.test(seg)            // 홈을 모르면 짐작하지 않는다
    && /hostHome = m\.home/.test(fnBody(mainJs, "handleCapsMessage"))
    && /"caps": dispatchWs\(handleCapsMessage\)/.test(mainJs)
    && /type: "caps", local: ws\._local, home: os\.homedir\(\)/.test(readAll("server"));
});
check("뿌리 있는 경로는 워크스페이스 밖도 열고, 읽기 경계는 서버가 정함", () => {
  const seg = sliceBetween(fileRouting, "function openTerminalPath", "function consoleSpace", "뿌리 있는 경로는 워크스페이스 밖도 열고, 읽기 경계는 서버가 정함");
  const s = read("server/fs-handlers.js");
  const fr = sliceBetween(s, "export async function handleFsRead", "export async function handleFsWrite", "뿌리 있는 경로는 워크스페이스 밖도 열고, 읽기 경계는 서버가 정함");
  return /const rooted = \/\^\[\/~\]\/\.test/.test(seg) && /if \(!rooted\)/.test(seg)   // 뿌리 없는 토큰만 경계 검사
    && /!ws\._local && !fsPathAllowed\(p\)/.test(fr);                                   // 원격은 종전대로 cwd 하위만
});
check("바이너리는 뷰어 대신 Finder로", () => {
  const s = read("server/fs-handlers.js");
  const fr = sliceBetween(s, "export async function handleFsRead", "export async function handleFsWrite", "바이너리는 뷰어 대신 Finder로");
  return /const BINARY_RE = /.test(fileRouting) && /BINARY_RE\.test\(p\)[\s\S]{0,80}revealTerminalPath\(raw\)/.test(fileRouting)
    && /binary: true/.test(fr) && /if \(m\.binary\)/.test(web);
});

}
