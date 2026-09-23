// 소유 범위: 왼쪽 도구 화면들. 무엇을 보여줄지의 경계와 뷰어를 덮는 화면의 배치 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사 도구. 판정 함수는 소스 모양만 보면 다른 스페이스가 섞여
//   들어온 것을 못 잡으므로 실제로 불러서 실행한다.
// 유지 조건: 뷰어를 덮는 화면 목록의 정본은 devtool/rail.js 의 RAIL_FULL 이다. 손으로
//   옮겨 적으면 목록이 바뀌어도 이 검사만 통과하므로, 소스에서 직접 읽어 쓴다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/tool-screens.mjs
import { runInNewContext } from "node:vm";

import {
  cannotMeasure, check, checkAsync, filesUnder, read, ROOT, sourceFiles,
} from "../core.mjs";
import { capabilitySource } from "../sources.mjs";
// 앵커로 잘라 보는 검사가 쓴다. 못 자르면 그 검사는 통과가 아니라 못 잼으로 내려간다.
import { sliceBetween } from "../../slice-anchor.mjs";

// 짝 없는 태그를 찾는다. 맞으면 null, 어긋나면 사람이 읽을 사유 한 줄.
// 스스로 닫는 것과 내용을 담지 않는 것은 짝을 세지 않는다.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);
function unbalancedTags(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const [, slash, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name)) continue;
    if (slash) {
      if (!stack.length) return `짝 없는 </${name}>`;
      const open = stack.pop();
      if (open !== name) return `<${open}> 를 </${name}> 로 닫는다`;
    } else if (!/\/\s*$/.test(attrs)) {
      stack.push(name);
    }
  }
  if (stack.length) return `안 닫은 <${stack[stack.length - 1]}>`;
  return null;
}

async function withFeatureState(hidden, run, onPut = () => {}) {
  const previousFetch = globalThis.fetch;
  let state = { exists: true, revision: 1, hidden: [...hidden], local: true };
  globalThis.fetch = async (url, options = {}) => {
    if (url !== "/features") throw new Error(`예상하지 않은 요청: ${url}`);
    if ((options.method || "GET") === "PUT") {
      const body = JSON.parse(options.body);
      if (body.baseRevision !== state.revision) throw new Error("상태 revision 없이 저장한다");
      state = { ...state, revision: state.revision + 1, hidden: body.hidden };
      onPut(body.hidden);
    } else if ((options.method || "GET") !== "GET") {
      throw new Error(`예상하지 않은 메서드: ${options.method}`);
    }
    return { ok: true, status: 200, json: async () => ({ ...state, hidden: [...state.hidden] }) };
  };
  try {
    const features = await import(new URL("../../../web/js/core/features.js", import.meta.url).href);
    await features.refreshFeatures();
    return await run(features);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export default async function run() {
console.log("[2r] 도구 화면 — 무엇을 보여주는가");

const rail = read("web/js/devtool/rail.js");
const RAIL_ITEMS_IDS = (await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href)).railItemIds();
const featureModes = read("web/css/03-feature-modes.css");
const cssFiles = sourceFiles("web").filter((rel) => rel.startsWith("web/css/") && rel.endsWith(".css"));

// 스페이스를 전부 검색하면 지금 작업 중인 레포를 찾기까지 다른 스페이스의 레포를 먼저 지나야 한다.
await checkAsync("소스 제어는 지금 머무는 스페이스만 본다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/source-control.js", import.meta.url).href);
  const spaces = [
    { id: "s1", label: "iris", folder: "/w/iris" },
    { id: "s2", label: "shop", folder: "/w/shop" },
  ];
  const agents = [
    { workspaceId: "s1", cwd: "/w/iris/server" },      // 하위 레포 — 들어온다
    { workspaceId: "s1", cwd: "/w/iris" },             // 같은 폴더 — 접힌다
    { workspaceId: "s2", cwd: "/w/shop/app" },         // 다른 스페이스 — 안 들어온다
    { workspaceId: null, cwd: "/w/loose" },            // 스페이스에 안 붙은 pane
  ];
  const got = mod.scCandidatesOf("s1", spaces, agents, null).map((c) => c.dir);
  if (got.join(" / ") !== "/w/iris / /w/iris/server") throw new Error(got.join(" / "));
  // 현재 스페이스가 없으면 후보를 내지 않는다. 스페이스에 속하지 않은 pane 은 workspaceId 가
  // 없어서 null 과 일치하므로 이 조건이 실제로 걸린다.
  if (mod.scCandidatesOf(null, spaces, agents, null).length) throw new Error("스페이스 없이도 후보가 생겼다");
  return true;
});

// pane 이 스페이스 폴더 밖으로 나가 있으면 그것은 "하위"가 아니다. 그 하나가 섞이면 화면이 다시
// 남의 레포를 세운다.
await checkAsync("스페이스 폴더 밖 pane 은 하위가 아니다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/source-control.js", import.meta.url).href);
  const spaces = [{ id: "s1", label: "iris", folder: "/w/iris" }];
  const agents = [{ workspaceId: "s1", cwd: "/w/other" }, { workspaceId: "s1", cwd: "/w/iris-public" }];
  const got = mod.scCandidatesOf("s1", spaces, agents, null).map((c) => c.dir);
  if (got.join(" / ") !== "/w/iris") throw new Error(got.join(" / "));
  // 접두사만 비교하면 /w/iris-public 이 /w/iris 하위로 잡히므로 경계에 / 를 요구한다.
  if (mod.scUnder("/w/iris", "/w/iris-public")) throw new Error("이름이 겹치는 옆 폴더를 안쪽으로 봤다");
  if (!mod.scUnder("/w/iris", "/w/iris/server")) throw new Error("진짜 하위를 밖으로 봤다");
  return true;
});

// 계정 화면의 마크업은 accounts-view.js 가, 이벤트 연결은 accounts-screen.js 가 갖는다.
// 이름 하나가 빠지면 화면은 정상으로 보이고 버튼만 반응하지 않는다. 그래서 연결 쪽 소스에서
// 참조하는 이름을 뽑아 마크업에 있는지 확인한다. 손으로 적은 목록은 연결이 바뀌어도 그대로다.
await checkAsync("새 계정 배치가 배선이 붙잡는 이름을 다 갖고 있다", async () => {
  const mod = await import(new URL("../../../web/js/browser/accounts-view.js", import.meta.url).href);
  const wiring = read("web/js/browser/accounts-screen.js");
  const html = mod.accountsMarkup({
    spaces: [{ id: "s1", label: "iris" }],
    profiles: [{ id: "", name: "기본" }, { id: "p1", name: "손님" }],
    defaults: { s1: "p1" }, defaultProfileId: "",
    creds: { p1: { count: 2, accounts: ["a@b.c"] } },
    chromeProfiles: [{ id: "Default", label: "Chrome — 기본" }],
  });
  const want = new Set();
  for (const m of wiring.matchAll(/closest\("\[data-([a-z-]+)[\]=]/g)) want.add("data-" + m[1]);
  for (const m of wiring.matchAll(/closest\("#(acct-[a-z-]+)"\)/g)) want.add('id="' + m[1] + '"');
  for (const m of wiring.matchAll(/getElementById\("(acct-[a-z-]+)"\)/g)) want.add('id="' + m[1] + '"');
  for (const m of wiring.matchAll(/\$\("#(acct-new-[a-z-]+)"\)/g)) want.add('id="' + m[1] + '"');
  if (want.size < 6) cannotMeasure(`배선에서 뽑은 이름이 ${want.size}개뿐 — 뽑는 방식이 깨졌다`);
  const missing = [...want].filter((k) => !html.includes(k));
  if (missing.length) throw new Error("그림에 없는 것: " + missing.join(", "));
  return true;
});

// 이름변경은 카드 안의 .an 을 편집 요소로 교체한다. 카드에 data-prof 가 있고 그 안에 .an 이
// 있어야 하며, 둘 중 하나만 빠져도 이름변경 버튼이 동작하지 않는다.
await checkAsync("이름변경이 고쳐 쓸 자리가 카드 안에 있다", async () => {
  const mod = await import(new URL("../../../web/js/browser/accounts-view.js", import.meta.url).href);
  const html = mod.accountsMarkup({
    spaces: [], profiles: [{ id: "p1", name: "손님" }], defaults: {}, defaultProfileId: "",
    creds: {}, chromeProfiles: [],
  });
  const at = html.indexOf('data-prof="p1"');
  if (at < 0) throw new Error("프로필 카드를 못 찾음");
  const card = html.slice(at, html.indexOf("data-rename", at));
  return /class="an"/.test(card);
});

// diff 의 줄 번호는 hunk 머리 줄에서만 알 수 있다. 그 값을 놓치면 뒤따르는 줄이 전부
// 잘못된 번호를 달게 되고, 잘못된 번호는 번호가 없는 것보다 나쁘다.
await checkAsync("diff 줄 번호가 옛쪽·새쪽을 따로 센다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/diff.js", import.meta.url).href);
  const patch = [
    "diff --git a/x.js b/x.js",
    "index 111..222 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -10,4 +20,5 @@ function f() {",
    " keep1",
    "-gone",
    "+added1",
    "+added2",
    " keep2",
    "@@ -100,2 +200,2 @@",
    " tail1",
    " tail2",
  ].join("\n");
  const rows = mod.diffRows(patch);
  const at = (t) => rows.find((r) => r.text.slice(1) === t || r.text === t);
  const pair = (t) => { const r = at(t); return r ? `${r.o}/${r.n}` : "없음"; };
  const TABLE = [
    ["keep1", "10/20"],   // 문맥 줄은 양쪽에서 한 칸씩 간다
    ["gone", "11/"],      // 지운 줄은 옛 파일에만 있다
    ["added1", "/21"],    // 더한 줄은 새 파일에만 있다
    ["added2", "/22"],
    ["keep2", "12/23"],   // 지운 하나·더한 둘을 지난 뒤의 자리
    ["tail1", "100/200"], // 두 번째 hunk 에서 번호가 새로 잡힌다
    ["tail2", "101/201"],
  ];
  for (const [text, want] of TABLE) {
    if (pair(text) !== want) throw new Error(`${text}: ${pair(text)} (기대 ${want})`);
  }
  // 머리 줄은 파일의 어느 줄도 아니므로 번호를 달지 않는다.
  for (const r of rows) {
    if ((r.cls === "meta" || r.cls === "hunk") && (r.o || r.n)) throw new Error("머리 줄에 번호가 붙었다: " + r.text);
  }
  return true;
});

// 계산한 번호를 그리지 않으면 의미가 없다. 그리는 코드와 번호를 만드는 규칙을 함께 확인한다.
check("센 번호가 화면에 실제로 선다", () => {
  const diff = read("web/js/devtool/diff.js");
  const body = /function colorizeDiff\(patch\) \{[\s\S]*?\n\}/.exec(diff);
  if (!body) throw new Error("colorizeDiff 를 못 찾음");
  const gutters = (body[0].match(/class="dn"/g) || []).length;
  // 번호 칸은 하나다. 둘을 만들면 번호가 코드보다 먼저 눈에 들어온다.
  if (gutters !== 1) throw new Error(`번호 칸이 ${gutters}개 — 하나여야 한다`);
  // 그 줄이 실제로 있는 파일의 번호를 적는다. 지운 줄에 새 번호를 적으면 없는 줄을 가리킨다.
  if (!/r\.cls === "del" \? r\.o : r\.n/.test(body[0])) throw new Error("지운 줄이 옛 번호를 안 쓴다");
  if (!/class="dt"/.test(body[0])) throw new Error("본문 칸이 없다");
  const css = read("web/css/07b-diff.css");
  // 복사할 때 번호가 딸려오면 붙여넣은 코드가 못 쓰게 된다.
  return /\.dv-body \.dn \{[\s\S]{0,220}user-select:none/.test(css);
});

// pane 을 띄운 적 없는 하위 레포는 후보에 들어오지 못한다. 그래서 스페이스 안에 레포가
// 여럿이어도 하나만 보였다.
await checkAsync("하위 레포를 찾아내고, 훑는 범위가 묶여 있다", async () => {
  const mod = await import(new URL("../../../server/git-handlers.js", import.meta.url).href);
  // 실제 디스크를 검색하면 결과가 기계의 폴더 구성에 따라 달라지므로 가상 트리를 쓴다.
  const TREE = {
    "/w": ["app", "server", "node_modules", ".git", "deep"],
    "/w/app": [], "/w/server": [], "/w/node_modules": ["evil"], "/w/node_modules/evil": [],
    "/w/deep": ["a"], "/w/deep/a": ["b"], "/w/deep/a/b": ["c"], "/w/deep/a/b/c": ["d"], "/w/deep/a/b/c/d": [],
  };
  const REPOS = new Set(["/w/app", "/w/server", "/w/node_modules/evil", "/w/deep/a/b/c", "/w/deep/a/b/c/d"]);
  const found = mod.nestedRepos("/w", {
    readdir: (d) => (TREE[d] || []),
    isDir: (d) => REPOS.has(d),
  });
  if (!found.includes("/w/app") || !found.includes("/w/server")) throw new Error("바로 아래 레포를 놓쳤다: " + found.join(", "));
  // node_modules 를 검색하면 의존 패키지에 포함된 .git 이 목록을 채운다.
  if (found.some((x) => x.includes("node_modules"))) throw new Error("node_modules 를 훑었다");
  // 깊이 제한이 필요하다. 큰 트리에서 검색이 몇 초씩 걸리면 그동안 화면이 비어 있다.
  if (found.includes("/w/deep/a/b/c/d")) throw new Error("깊이 제한이 없다");
  if (!found.includes("/w/deep/a/b/c")) throw new Error("제한 안쪽인데 못 찾았다");
  // 개수 상한도 실제로 먹어야 한다.
  const many = {}; const names = [];
  for (let i = 0; i < 60; i++) { names.push("r" + i); many["/m/r" + i] = []; }
  many["/m"] = names;
  const capped = mod.nestedRepos("/m", { readdir: (d) => (many[d] || []), isDir: () => true });
  if (capped.length > 40) throw new Error(`상한을 넘었다: ${capped.length}`);
  return true;
});

// Base 대비 보기. committed 는 분기점부터 HEAD 까지 커밋된 것만, worktree 는 커밋 전 변경과
// 추적하지 않는 새 파일까지 담아야 두 보기가 서로 다른 것을 보여 준다. base 는 브랜치 목록에
// 있는 값만 git 에 넘긴다. 목록 밖 문자열은 "--output=..." 처럼 옵션으로 해석될 수 있다.
await checkAsync("Base 대비 목록이 보기별로 갈리고, 목록 밖 base 는 거절된다", async () => {
  const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const pathMod = await import("node:path");
  const rs = await import(new URL("../../../server/runtime-state.js", import.meta.url).href);
  const mod = await import(new URL("../../../server/git-handlers.js", import.meta.url).href);
  const dir = realpathSync(mkdtempSync(pathMod.join(tmpdir(), "iris-branchdiff-")));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    g("init", "-q", "-b", "main");
    writeFileSync(pathMod.join(dir, "a.js"), "1\n"); writeFileSync(pathMod.join(dir, "old.js"), "x\ny\nz\n");
    g("add", "-A"); g("commit", "-qm", "base");
    g("checkout", "-qb", "feat");
    writeFileSync(pathMod.join(dir, "b.js"), "2\n"); g("mv", "old.js", "new.js");
    g("add", "-A"); g("commit", "-qm", "feat");
    writeFileSync(pathMod.join(dir, "a.js"), "1 changed\n");   // 커밋 전 수정
    writeFileSync(pathMod.join(dir, "u.js"), "untracked\n");   // 추적 안 함
    rs.replace({ allowedRoots: [dir] });
    const out = [];
    const ws = { _local: false, send: (x) => out.push(JSON.parse(x)) };
    const ask = (extra) => { out.length = 0; mod.handleGit(ws, { type: "git.branchDiff", path: dir, ...extra }); return out[0]; };
    const names = (r) => (r.files || []).map((f) => f.code + ":" + f.rel + (f.oldRel ? "<" + f.oldRel : "")).sort().join(" ");
    const c = ask({ mode: "committed" });
    if (c.base !== "main") throw new Error("기본 base 감지: " + c.base);
    if (names(c) !== "A:b.js R:new.js<old.js") throw new Error("committed: " + names(c));
    const w = ask({ mode: "worktree", base: "main" });
    if (names(w) !== "A:b.js M:a.js R:new.js<old.js U:u.js") throw new Error("worktree: " + names(w));
    for (const bad of ["--output=/tmp/x", "HEAD~1", "nope"]) {
      const r = ask({ mode: "committed", base: bad });
      if (!r.error || (r.files || []).length) throw new Error("목록 밖 base 를 받았다: " + bad);
    }
    // 파일 diff 도 같은 기준을 쓴다. committed 에는 커밋 전 수정이 없다.
    out.length = 0;
    mod.handleGit(ws, { type: "git.diff", path: dir, file: pathMod.join(dir, "a.js"), mode: "committed", base: "main" });
    if (out[0].patch.trim()) throw new Error("committed diff 에 커밋 전 수정이 섞였다");
    out.length = 0;
    mod.handleGit(ws, { type: "git.diff", path: dir, file: pathMod.join(dir, "a.js"), mode: "worktree", base: "main" });
    if (!/\+1 changed/.test(out[0].patch) || out[0].mode !== "worktree") throw new Error("worktree diff: " + out[0].patch);
    return true;
  } finally { rs.replace({ allowedRoots: [] }); rmSync(dir, { recursive: true, force: true }); }
});

// 강조는 옛쪽·새쪽을 따로 토큰화한 뒤 줄에 되돌려 넣는다. 짝이 한 칸 밀리면 모든 줄이 남의 색을 단다.
await checkAsync("강조 줄이 옛쪽·새쪽의 같은 줄과 짝지어진다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/diff.js", import.meta.url).href);
  const rows = mod.diffRows(["--- a/x.js", "+++ b/x.js", "@@ -1,3 +1,3 @@", " k1", "-o1", "+n1", "+n2", " k2"].join("\n"));
  const { oldLines, newLines, at } = mod.diffSides(rows);
  if (oldLines.join(",") !== "k1,o1,k2" || newLines.join(",") !== "k1,n1,n2,k2") throw new Error(oldLines + " / " + newLines);
  const got = rows.map((r, i) => (at[i] ? (at[i].side === "o" ? oldLines : newLines)[at[i].i] : "-")).join(",");
  if (got !== "-,-,-,k1,o1,n1,n2,k2") throw new Error(got);
  return true;
});

// 찾아낸 레포도 후보 목록에 들어가지 않으면 화면에 나오지 않는다. 서버가 준 목록이 후보로 들어가는지 확인한다.
await checkAsync("찾은 하위 레포가 후보에 얹힌다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/source-control.js", import.meta.url).href);
  const spaces = [{ id: "s1", label: "iris", folder: "/w/iris" }];
  const got = mod.scCandidatesOf("s1", spaces, [], null, ["/w/iris/app", "/w/other"]).map((c) => c.dir);
  // 검색 범위가 넓어져도 스페이스 폴더 밖은 후보에 들어오지 않는다.
  if (got.join(" / ") !== "/w/iris / /w/iris/app") throw new Error(got.join(" / "));
  return true;
});

// 검색을 요청하고, 응답을 받고, 다시 그리는 세 지점. 하나만 빠져도 목록이 채워지지 않는데
// 화면은 이전 상태 그대로여서 고장으로 보이지 않는다.
check("훑기를 부탁하고 · 답을 받고 · 다시 그린다", () => {
  const sc = read("web/js/devtool/source-control.js");
  return /wsSend\(\{ type: "git\.repos", path: root \}\)/.test(sc)
    && /if \(m\.type === "git-repos"\)/.test(sc)
    && /scNested\.set\(m\.path, Array\.isArray\(m\.repos\) \? m\.repos : \[\]\)/.test(sc)
    && /scVer\+\+;\s*\n\s*scSync\(\);/.test(sc)
    && /"git-repos": on/.test(sc)   // 배선도 그 기능이 들고 있다
    && !/handleSourceControlMessage/.test(read("web/js/main.js"));
});

// 06-accounts.css 는 계정 화면 뒤에 깃 패널의 머리(.sc-head·.sc-title·.sc-branch)와 커밋
// 상자, 도구 머리 여덟 곳이 함께 쓰는 .sc-ico 를 담고 있다. 그 부분을 잘라 내면 화면은 정상으로
// 뜨고 배치만 무너져서 열어 보기 전에는 드러나지 않는다. 화면에 쓰는 class 이름에 규칙이 없으면
// 이 검사가 잡는다.
check("화면에 쓰는 class 는 규칙을 갖는다", () => {
  const html = read("web/index.html");
  const css = cssFiles.map((rel) => read(rel)).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const t of m[1].split(/\s+/)) if (t) tokens.add(t);
  }
  if (tokens.size < 80) cannotMeasure(`class 를 ${tokens.size}개밖에 못 뽑았다 — 뽑는 방식이 깨졌다`);
  // run 은 .panel.run 처럼 결합 선택자로만 나오고 단독으로 쓰이지 않는다.
  const known = new Set(["run"]);
  const missing = [...tokens].filter((t) =>
    !known.has(t) && !new RegExp("\\." + t.replace(/[-]/g, "\\-") + "(?![\\w-])").test(css));
  if (missing.length) throw new Error("규칙 없는 class: " + missing.join(", "));
  return true;
});

// 끈 도구는 rail 에서 사라지고 단축키도 동작하지 않아야 한다. rail 에서만 사라지고 경로가
// 열려 있으면 순환 단축키 한 번으로 다시 열려서 껐다는 상태가 성립하지 않는다. 세 경로를 모두 본다.
await checkAsync("내린 화면은 rail 에서도 · 순환에서도 · 이름으로도 열리지 않는다", async () => {
  const bare = rail.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 소스 모양이 아니라 실제로 호출해 확인한다. 거절이 화면 변경보다 뒤에 오면 body class 는
  // 이미 바뀐 뒤여서 화면이 통째로 빈다. 그 일이 일어나는지는 호출 후 상태로만 알 수 있다.
  const run = async (view, hidden) => {
    // 거절은 아무 동작도 하지 않는 것이므로, 켜진 것뿐 아니라 호출 횟수 자체를 센다.
    // 켠 것만 세면 body class 가 없는 화면(작업)에서 거절과 통과가 똑같이 0 으로 보인다.
    const toggled = []; toggled.calls = 0;
    const prevDoc = globalThis.document;
    globalThis.document = {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: { toggle: (name, on) => { toggled.calls += 1; if (on) toggled.push(name); } } },
    };
    try {
      await withFeatureState(hidden, async () => {
        const mod = await import(new URL("../../../web/js/devtool/rail.js", import.meta.url).href);
        mod.railSelect(view);
      });
    } finally { globalThis.document = prevDoc; }
    return toggled;
  };
  const ok = await run("archive", []);
  if (!ok.length) throw new Error("켜 둔 화면이 안 열린다");
  const off = await run("archive", ["archive"]);
  if (off.calls) throw new Error("내린 화면이 열린다: " + off.calls + "번 바뀜");
  const unknown = await run("없는화면", []);
  if (unknown.calls) throw new Error("표에 없는 이름으로 화면이 바뀐다: " + unknown.calls + "번 바뀜");
  const locked = await run("workspace", ["workspace"]);
  if (!locked.calls) throw new Error("잠긴 화면까지 거절한다 — 되돌릴 자리가 사라진다");
  if (!/\.rail-ico\[data-rail\]:not\(\[hidden\]\)/.test(bare)) throw new Error("순환이 내린 화면을 지나간다");
  if (!/b\.hidden = off/.test(bare)) throw new Error("rail 버튼을 실제로 내리는 자리가 없다");
  return true;
});

await checkAsync("작업과 설정은 내릴 수 없다", async () => {
  const { RAIL_ITEMS: items } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  const bare = rail.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 잠금은 표가 갖는다. rail.js 는 읽기만 한다.
  const locked = items.filter((f) => f.canDisable === false).map((f) => f.id);
  if (!locked.includes("workspace")) throw new Error("작업이 잠금 목록에 없다");
  if (!locked.includes("keymap")) throw new Error("설정이 잠금 목록에 없다 — 끄면 되돌릴 자리가 사라진다");
  if (!/const RAIL_LOCKED = new Set\(lockedIds\(\)\);/.test(bare)) throw new Error("rail 이 표의 잠금을 안 쓴다");
  // 문구와 정책을 한 칸에 두면 문구를 고치는 일이 권한을 바꾸는 일이 된다.
  for (const f of items) {
    if (f.canDisable === false && !f.disabledReason) throw new Error(f.id + ": 못 내리는데 이유가 없다");
    if (f.canDisable === true && f.disabledReason) throw new Error(f.id + ": 내릴 수 있는데 이유가 붙어 있다");
  }
  // 끄는 길이 실제로 막혀 있는지는 눌러 봐야 안다. 저장된 것이 답이다.
  const press = async (id) => {
    let stored = null;
    const prevDoc = globalThis.document;
    globalThis.document = {
      getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
      body: { classList: { toggle() {} } },
    };
    try {
      await withFeatureState([], async () => {
        const mod = await import(new URL("../../../web/js/devtool/rail.js", import.meta.url).href);
        await mod.setRailScreen(id);
      }, (hidden) => { stored = JSON.stringify(hidden); });
    } finally { globalThis.document = prevDoc; }
    return stored;
  };
  if (await press("archive") === null) throw new Error("끌 수 있는 화면조차 안 꺼진다 — 재는 방식이 깨졌다");
  for (const id of locked) {
    const got = await press(id);
    if (got !== null) throw new Error(`잠긴 화면을 끄는 길이 열려 있다: ${id} → ${got}`);
  }
  if (await press("없는화면") !== null) throw new Error("표에 없는 이름이 저장된다");
  return true;
});

// 설정의 「편의 기능」 분류. 마크업을 실제로 렌더링해 확인한다. 잠긴 항목에는 조작 요소가
// 없어야 하고, 나머지에는 이벤트 연결이 참조하는 이름이 있어야 한다.
await checkAsync("설정의 「편의 기능」이 스위치를 실제로 그린다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/settings-view.js", import.meta.url).href);
  if (!mod.SETTINGS_SECTIONS.some((x) => x.id === "features")) throw new Error("분류에 편의 기능이 없다");
  const screens = [
    { id: "workspace", label: "작업", on: true, lock: "이 화면은 내릴 수 없습니다" },
    { id: "sourcecontrol", label: "깃", on: true, lock: "" },
    { id: "memo", label: "메모", on: false, lock: "" },
  ];
  const html = mod.settingsMarkup({ section: "features", screens, items: [], toggles: [] });
  if (!/data-set-screen="sourcecontrol"/.test(html)) throw new Error("켠 화면에 스위치가 없다");
  if (!/data-set-screen="memo"/.test(html)) throw new Error("끈 화면에 스위치가 없다");
  if (/data-set-screen="workspace"/.test(html)) throw new Error("잠긴 화면에 누를 자리가 생겼다");
  // 켬/끔이 화면에 드러나야 한다. 둘이 같은 모양이면 무엇을 껐는지 알 수 없다.
  const on = /data-set-screen="sourcecontrol"[^>]*aria-checked="true"/.test(html);
  const off = /data-set-screen="memo"[^>]*aria-checked="false"/.test(html);
  if (!on || !off) throw new Error("켬/끔 상태가 안 드러난다");
  if (!/km-sw on/.test(html) || !/서버·네이티브는 재시작 전까지 실행됩니다/.test(html)) throw new Error("표시·안내가 빠졌다");
  return true;
});

await checkAsync("창 전환 등록 실패는 다음·이전·두 방향을 구분해 막힌 키를 적는다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/settings-view.js", import.meta.url).href);
  const base = {
    section: "windows", screens: [], items: [], toggles: [],
    switcher: {
      windows: [{ id: 1, displayApp: "메모", displayTitle: "한 장", picked: true }],
      status: {
        permission: true, pickedMode: true,
        accelerators: { next: "Alt+Tab", prev: "Alt+Shift+Tab" },
      },
    },
  };
  const markup = (registered, conflict, registerError) => mod.settingsMarkup({
    ...base,
    switcher: { ...base.switcher, status: { ...base.switcher.status, registered, conflict, registerError } },
  });

  if (!markup({ next: false, prev: true }).includes("다음 창 키(⌥Tab)를 다른 앱이 쓰고 있습니다")) {
    throw new Error("다음 창 키 실패 문구가 없다");
  }
  if (!markup({ next: true, prev: false }).includes("이전 창 키(⌥⇧Tab)를 다른 앱이 쓰고 있습니다")) {
    throw new Error("이전 창 키 실패 문구가 없다");
  }
  const both = markup({ next: false, prev: false });
  if (!both.includes("다음 창 키(⌥Tab)와 이전 창 키(⌥⇧Tab)를 다른 앱이 쓰고 있습니다")) {
    throw new Error("두 방향 실패 문구가 없다");
  }
  if (!markup({ next: false, prev: false }, "internal:pick-mode").includes("이 키는 요소 지목에 이미 쓰고 있습니다")) {
    throw new Error("요소 지목 충돌 문구가 바뀌었다");
  }
  const unsupported = markup({ next: false, prev: true }, undefined, { next: "unsupported" });
  if (!unsupported.includes("다음 창 키(⌥Tab)는 전역 단축키로 쓸 수 없습니다")) {
    throw new Error("지원하지 않는 키의 사실 문구가 없다");
  }
  if (unsupported.includes("다른 앱이 쓰고 있습니다")) {
    throw new Error("지원하지 않는 키를 다른 앱 충돌로 잘못 알린다");
  }
  return true;
});

// 마크업과 이벤트 연결이 다른 파일에 있어서 이름 하나만 어긋나도 스위치가 동작을 멈춘다.
// 참조 이름을 연결 소스에서 뽑아 마크업에 있는지 확인한다. 손으로 적으면 함께 갱신되지 않는다.
await checkAsync("설정 배선이 붙잡는 이름이 그림에 다 있다", async () => {
  const mod = await import(new URL("../../../web/js/devtool/settings-view.js", import.meta.url).href);
  const wiring = read("web/js/devtool/keymap-page.js").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const hooks = [...wiring.matchAll(/closest\("\[([a-z-]+)\]"\)/g)].map((m) => m[1]);
  if (hooks.length < 4) throw new Error(`배선에서 이름을 ${hooks.length}개밖에 못 뽑았다`);
  const model = {
    items: [{ id: "find", label: "찾기", where: "편집기", lock: "", changed: true, keys: "⌘F", defKeys: "⌘F" }],
    toggles: [{ id: "login-convenience", name: "로그인 편의 기능", desc: "설명", on: false, warn: "" }],
    screens: [{ id: "memo", label: "메모", on: true, lock: "" }],
    switcher: {
      windows: [{ id: 1, cgId: 1, displayApp: "메모", displayTitle: "한 장", picked: true }],
      picked: [{ id: 1 }], status: { permission: true },
    },
    conflicts: [], changed: 1,
  };
  const all = mod.SETTINGS_SECTIONS.map((s) => mod.settingsMarkup({ ...model, section: s.id })).join("\n");
  const missing = hooks.filter((h) => !all.includes(h + "="));
  if (missing.length) throw new Error("그림에 없는 이름: " + missing.join(", "));
  return true;
});

// 표가 정본이고 index.html 의 rail 버튼은 그 사본이다. 둘이 달라지면 화면은 정상으로 뜨고
// 버튼만 다른 것을 가리키는데, 아이콘 svg 한 글자 차이는 눈에 띄지 않는다. 그래서 표에서
// 생성한 마크업과 실제 마크업을 문자열로 대조한다. 마크업을 손으로 고치면 여기서 걸린다.
await checkAsync("rail 마크업이 표에서 그린 것과 같다", async () => {
  const { RAIL_ITEMS } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  const railMod = await import(new URL("../../../web/js/devtool/rail.js", import.meta.url).href);
  const html = read("web/index.html");
  const shown = [...html.matchAll(/<button class="rail-ico(?: active)?" data-rail="[\s\S]*?<\/button>/g)].map((m) => m[0]);
  if (shown.length !== RAIL_ITEMS.length) {
    throw new Error(`마크업 ${shown.length}개 vs 표 ${RAIL_ITEMS.length}줄`);
  }
  const norm = (v) => v.replace(/\s+/g, " ").trim();
  const want = norm(railMod.railButtonsMarkup(RAIL_ITEMS, "workspace"));
  const got = norm(shown.join("\n"));
  if (want !== got) {
    let i = 0; while (i < Math.max(want.length, got.length) && want[i] === got[i]) i++;
    throw new Error(`@${i} 표: ${want.slice(Math.max(0, i - 40), i + 40)} / 마크업: ${got.slice(Math.max(0, i - 40), i + 40)}`);
  }
  // 처음 서 있는 화면은 정확히 하나여야 한다. 없으면 아무 데도 안 서고, 둘이면 두 화면이 함께 켜진다.
  if (shown.filter((b) => /class="rail-ico active"/.test(b)).length !== 1) throw new Error("처음 서는 화면이 하나가 아니다");
  return true;
});

// 표에 한 줄을 더해도 패널 element 와 CSS 규칙이 없으면 버튼만 생기고 빈 화면이 열린다.
// 이 표는 여러 정본을 잇는 키이므로 그 연결을 전부 확인한다.
await checkAsync("표의 각 줄이 실물과 이어져 있다", async () => {
  const { RAIL_ITEMS } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  const { CAPABILITIES: CAPS_RAIL } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const capOfRail = new Map(CAPS_RAIL.filter((c) => c.rail).map((c) => [c.rail, c]));
  if (capOfRail.size < 5) cannotMeasure(`rail 을 가진 기능을 ${capOfRail.size} 개만 셌다 — 표를 못 읽었다`);
  const html = read("web/index.html");
  const css = cssFiles.map((rel) => read(rel)).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const mainJs = read("web/js/main.js");
  const bad = [];
  const seen = new Set();
  for (const f of RAIL_ITEMS) {
    if (seen.has(f.id)) bad.push(`${f.id}: 같은 id 가 두 번`);
    seen.add(f.id);
    if (!f.label || !f.title || !f.icon) bad.push(`${f.id}: 이름·설명·아이콘 중 빈 것`);
    // 패널 마크업의 위치는 그 화면의 소유자가 정한다.
    //   기능 소유: 그 모듈이 panelHtml 로 내부만 제공하고, 바깥 요소는 rail 이 표에서 그린다.
    //   앱 셸 소유: index.html 이 바깥 요소까지 그린다(설정·작업).
    // 둘 다 있으면 패널이 두 벌이 되므로, 기능 소유분은 index.html 에 없어야 한다.
    if (f.panel) {
      const cap = capOfRail.get(f.id);
      if (cap) {
        const src = capabilitySource(cap.id);
        const body = /export const panelHtml\s*=\s*`([\s\S]*?)`;/.exec(src);
        if (!body) bad.push(`${f.id}: ${cap.id} 뭉치가 자기 자리(panelHtml)를 안 들고 온다`);
        else if (body[1].trim().length < 40) bad.push(`${f.id}: 들고 온 자리가 비었다`);
        // 존재와 길이만으로는 부족하다. 여는 태그가 하나 잘려도 그 두 조건은 통과하고,
        // 브라우저는 짝 없는 닫는 태그를 그냥 버려서 화면은 뜨고 머리 줄만 무너진다.
        // 확인 결과: 옮기는 과정에서 잘린 마크업이 검사를 통과했다. 그래서 태그 짝을 센다.
        else {
          const unbalanced = unbalancedTags(body[1]);
          if (unbalanced) bad.push(`${f.id}: 들고 온 자리의 태그 짝이 안 맞는다 — ${unbalanced}`);
        }
        // 모듈 집합 어딘가에 있는 것만으로는 부족하다. 앱 셸이 받아 가는 경로는 표가 부르는
        // 진입 파일 하나뿐이라, 다른 파일이 정의하고 진입 파일이 다시 내보내지 않으면 그 패널만
        // 생기지 않는다(memo 는 memo-admin 이 정의하고 memo-boot 가 진입 파일이다).
        const entry = /import\(\s*"(\.[^"]+)"\s*\)/.exec(String(cap.load));
        if (!entry) bad.push(`${f.id}: ${cap.id} 의 입구를 못 찾았다`);
        else {
          const parts = ("web/js/core/" + entry[1]).split("/");
          const out = [];
          for (const seg of parts) { if (seg === "." || seg === "") continue; if (seg === "..") out.pop(); else out.push(seg); }
          // 주석을 제거한다. 남기면 `// export { panelHtml };` 로 주석 처리해도 이 검사가 통과한다.
          const entrySrc = read(out.join("/")).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
          if (!/export\s+const\s+panelHtml\b/.test(entrySrc) && !/export\s*\{[^}]*\bpanelHtml\b[^}]*\}/.test(entrySrc)) {
            bad.push(`${f.id}: 입구(${out.join("/")})가 자리를 다시 안 내준다 — 그 자리만 조용히 안 생긴다`);
          }
        }
        if (new RegExp(`id="${f.panel}"`).test(html)) bad.push(`${f.id}: 자리가 index.html 에도 남아 있다 — 두 벌`);
      } else {
        if (!new RegExp(`id="${f.panel}"`).test(html)) bad.push(`${f.id}: 패널 ${f.panel} 이 없다`);
        // 앱 셸이 그리는 패널은 공통 class 를 달아야 하고, 없으면 켜도 표시되지 않는다.
        if (!new RegExp(`class="rail-panel ${f.panel}"`).test(html)) {
          bad.push(`${f.id}: 자리 ${f.panel} 에 rail-panel 이 없다`);
        }
      }
    }
    if (f.panel && !f.body) bad.push(`${f.id}: 자리는 있는데 몸말이 없다`);
  }
  // 패널 표시는 CSS 한 줄이 정하고, 그 규칙이 걸리려면 rail 이 두 이름을 달아야 한다.
  // 화면마다 나머지를 열거하던 CSS 를 정리했으므로, 이름을 세는 대신 이름을 다는 코드를 확인한다.
  const railJs = read("web/js/devtool/rail.js");
  if (!/for \(const f of RAIL_ITEMS\) if \(f\.panel\) document\.getElementById\(f\.panel\)\?\.classList\.toggle\("is-open", view === f\.id\);/.test(railJs)) {
    bad.push("rail 이 켠 화면에 is-open 을 안 단다");
  }
  if (!/classList\.toggle\("screen-open", !!railItemById\(view\)\?\.panel\)/.test(railJs)) {
    bad.push("rail 이 자리 열림을 몸에 안 알린다");
  }
  // 기능이 제공한 패널의 바깥 요소는 여기 한 곳에서만 만들어진다. id·class 의 정본은 표이므로
  // 그 둘을 표에서 읽어 다는지 확인한다. 손으로 적으면 표가 정본이 아니게 된다.
  if (!/el\.className = "rail-panel " \+ item\.panel;/.test(railJs)) bad.push("들고 온 자리에 공통 이름을 표에서 안 단다");
  if (!/el\.id = item\.panel;/.test(railJs)) bad.push("들고 온 자리의 id 를 표에서 안 단다");
  if (!/const host = document\.getElementById\("center"\);/.test(railJs) || !/insertBefore\(el, host\)/.test(railJs)) bad.push("들고 온 자리를 가운데 영역 앞에 안 넣는다");
  if (!/\.rail-panel\.is-open \{ display:flex; \}/.test(css)) bad.push("켠 자리를 세우는 규칙이 없다");
  if (!/body\.screen-open \.sidebar \{ display:none; \}/.test(css)) bad.push("자리가 열려도 파일 섹션이 안 내려간다");
  // main 의 화면 콜백 표와 어긋나면 그 화면은 열려도 아무것도 안 불린다.
  const seg = /screens: \{([\s\S]*?)\n    \},/.exec(mainJs);
  if (!seg) throw new Error("main 의 화면 표를 못 찾음");
  const keys = [...seg[1].matchAll(/^\s{6}([a-z]+):/gm)].map((m) => m[1]);
  // 콜백은 두 곳에서 온다. main 의 표(아직 정적으로 로드되는 화면)와 capability 표(켠 것만
  // 로드되는 화면)이며, 둘을 합친 것이 rail 표와 같아야 한다. 한쪽만 보면 capability 로 옮긴
  // 화면이 빠진 것처럼 보이고, 반대로 보면 옮기다 만 화면이 드러나지 않는다.
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  // rail 이 없는 기능은 화면이 아니라 패널만 갖는다. rail 대조에 넣으면 rail 표에 없는 항목으로
  // 잘못 잡히므로 제외하고, 화면을 돌려주면서 rail 이 없는 줄은 아래 검사가 잡는다.
  const byCap = CAPABILITIES.filter((c) => c.rail).map((c) => c.rail);
  const dup = byCap.filter((id) => keys.includes(id));
  if (dup.length) bad.push("두 곳에서 배선되는 화면: " + dup.join(", "));
  const have = [...keys, ...byCap];
  const want = RAIL_ITEMS.filter((f) => f.panel).map((f) => f.id);
  const missing = want.filter((id) => !have.includes(id));
  const extra = have.filter((id) => !want.includes(id));
  if (missing.length) bad.push("배선이 없는 화면: " + missing.join(", "));
  if (extra.length) bad.push("rail 표에 없는 배선: " + extra.join(", "));
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// files 와 css 는 렌더러만 가리킨다. 기능의 절반이 서버에 있는 경우 그 파일은 표에 적히지
// 않아서, archive 를 고치려면 server/archive-handlers.js 를 직접 찾아야 했다. 기능마다
// 병렬 수정이 가능하다는 조건이 여기서 깨진다.
//
// 손으로 적는 목록은 생산자와 갈라지므로 반대 방향에서 강제한다. 서버 파일이 한 기능의 메시지
// 이름을 셋 이상 다루고 그 수가 앱 셸 이름보다 많으면, 그 기능이 그 파일을 적어야 한다.
// 소유자는 렌더러에서 그 이름을 보내는 쪽으로 정한다(앱 셸이 보내면 앱 셸의 것이다).
/* 독립 페이지와 HTTP 경로도 기능이 소유한다.

   소유는 web/js 아래 모듈(files)과 WebSocket 메시지 이름으로만 표현됐다. 자기 HTML 을 갖고
   HTTP 로만 동작하는 기능은 그 둘 중 어느 것으로도 소유를 밝힐 수 없어서 page 와 routes 를
   둔다. 손으로 적은 목록은 실물과 갈라지므로 네 가지를 대조한다.
     그 디렉터리가 실재하고 비어 있지 않은가
     앱 셸이나 다른 기능이 그 안을 정적으로 import 하지 않는가(독립의 조건)
     밝힌 경로가 실제로 라우팅되고 그 처리기가 이 기능의 서버 파일에서 나오는가
     그 페이지가 실제로 그 경로를 호출하는가(아무도 호출하지 않는 경로는 죽은 경로다)
   같은 경로를 둘이 적는 것도 막는다. 나중에 등록된 쪽이 조용히 이긴다. */
/* 면 색을 글자 색으로 쓰지 않는다.

   이 팔레트에서 --muted 는 면(#16293A)이고 글자 보조 등급은 --muted-fg(#8FB0C4)다. 이름이
   한 글자 차이라 다른 화면의 팔레트에서 옮겨 적으면 그대로 통과한다. 「따로 열기」가 그렇게
   사이드바 바탕과 대비 1.3 으로 깔려 거의 보이지 않았던 적이 있다.

   부재를 확인하는 검사라 이름이 바뀌면 아무것도 검사하지 못한다. 그래서 두 이름이 아직 그
   뜻으로 쓰이는지 먼저 확인하고, 확인할 수 없으면 통과가 아니라 측정 불가로 처리한다. */
check("면 토큰을 글자 색으로 쓰지 않는다", () => {
  const tokens = read("web/css/00-tokens.css");
  if (!/--muted:\s*var\(--pal-ink/.test(tokens)) cannotMeasure("--muted 가 더는 면 토큰이 아니다 — 검사 전제가 바뀌었다");
  if (!/--muted-fg:/.test(tokens)) cannotMeasure("--muted-fg 가 없다 — 검사 전제가 바뀌었다");
  const bad = [];
  for (const rel of sourceFiles("web").filter((f) => f.endsWith(".css"))) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/color\s*:\s*var\(\s*--muted\s*\)/g)) {
      bad.push(`${rel}: ${m[0]} — 글자에는 --muted-fg`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("독립 지면과 HTTP 경로도 기능이 소유한다", async () => {
  const { CAPABILITIES: CAPS } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const pages = CAPS.filter((c) => c.page);
  if (!pages.length) cannotMeasure("독립 지면을 가진 기능이 하나도 없다 — 표를 못 읽었다");
  const router = read("server/http-handler.js");
  const { capabilities: serverCaps } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  if (!/capabilityHost(?:\?\.|\.)http\(req, res, pathname\)/.test(router)) {
    throw new Error("HTTP 라우터가 서버 기능 표의 dispatch 를 안 부른다");
  }
  const shell = sourceFiles("web").filter((f) => f.endsWith(".js")).map((f) => [f, read(f)]);
  const bad = [];
  const routeOwner = new Map();

  for (const cap of pages) {
    const files = filesUnder(cap.page, (rel) => /\.(?:html|js|css|mjs)$/.test(rel));
    if (!files.length) { bad.push(`${cap.id}: ${cap.page} 아래에 지면 파일이 없다`); continue; }

    // 독립은 앱 셸도 다른 기능도 그 안을 정적으로 import 하지 않는다는 뜻이다.
    for (const [rel, src] of shell) {
      if (new RegExp(`from\\s+"[^"]*${cap.page.replace("web/", "")}/`).test(src)) {
        bad.push(`${cap.id}: ${rel} 이 ${cap.page} 안을 정적으로 끌어온다 — 독립이 아니다`);
      }
    }

    const handlers = [];
    for (const f of cap.server || []) {
      const module = await import(new URL("../../../" + f, import.meta.url).href);
      handlers.push(...Object.values(module).filter((value) => typeof value === "function"));
    }
    const registered = serverCaps.find((row) => row.id === cap.id)?.http || [];
    const pageSrc = files.map((f) => read(f)).join("\n");
    for (const r of cap.routes || []) {
      if (routeOwner.has(r)) bad.push(`${r} 를 ${routeOwner.get(r)} 와 ${cap.id} 이 함께 적는다`);
      routeOwner.set(r, cap.id);
      const routes = registered.filter((route) => route.path === r);
      if (!routes.length) { bad.push(`${cap.id}: ${r} 가 서버 기능 표에 없다`); continue; }
      if (routes.some((route) => !handlers.includes(route.handler))) {
        bad.push(`${cap.id}: ${r} 의 처리기가 이 기능의 서버 파일에서 안 나온다`);
      }
      if (!pageSrc.includes(r)) bad.push(`${cap.id}: ${cap.page} 가 ${r} 를 안 부른다 — 죽은 경로`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("기능의 서버 쪽 반을 표가 밝힌다", async () => {
  const { CAPABILITIES: CAPS } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const owned = new Map();
  for (const cap of CAPS) for (const f of cap.files || []) owned.set("web/js/" + f, cap.id);
  const nude = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

  const senders = new Map();
  for (const rel of sourceFiles("web").filter((f) => f.endsWith(".js"))) {
    const who = owned.get(rel) || "틀";
    for (const m of nude(rel).matchAll(/type:\s*"([a-z][\w.-]*)"/g)) {
      if (!senders.has(m[1])) senders.set(m[1], new Set());
      senders.get(m[1]).add(who);
    }
  }
  if (senders.size < 40) cannotMeasure(`ws 이름을 ${senders.size} 개만 긁었다 — 훑개가 죽었다`);
  const ownerOf = new Map();
  for (const [n, w] of senders) {
    const caps = [...w].filter((k) => k !== "틀");
    ownerOf.set(n, w.has("틀") ? "틀" : (caps.length === 1 ? caps[0] : "여럿"));
  }

  const bad = [];
  const backend = sourceFiles("server").concat(sourceFiles("native"))
    .filter((f) => f.endsWith(".js") || f.endsWith(".cjs"));
  if (backend.length < 30) cannotMeasure(`서버·네이티브 파일을 ${backend.length} 개만 셌다`);

  const declaredBy = new Map();
  for (const cap of CAPS) for (const f of cap.server || []) {
    if (declaredBy.has(f)) bad.push(`${f} 를 ${declaredBy.get(f)} 와 ${cap.id} 이 함께 적는다`);
    declaredBy.set(f, cap.id);
  }
  /* 적은 파일이 실재하고 실제로 그 기능의 것인가.

     근거는 둘이다: 그 기능의 WebSocket 메시지를 다루거나, 그 기능이 밝힌 HTTP 경로의
     처리기를 내주거나. 메시지 이름만 보면 HTTP 로만 사는 기능은 자기 서버 파일을 정확히
 적어 놓고도 걸린다(독립 HTML 이 싣는 자산과 HTTP 전용
     저장소를 지금 검사가 표현하지 못한다). 경로 쪽 근거는 적은 것만으로는 안 선다:
     라우터가 그 경로를 실제로 받고, 그 자리에서 이 파일이 내준 처리기를 부를 때만 선다. */
  const routerSrc = read("server/http-handler.js");
  const { capabilities: serverCaps } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  const servesRoute = async (file, capId, routes) => {
    if (!/capabilityHost(?:\?\.|\.)http\(req, res, pathname\)/.test(routerSrc)) return false;
    const registered = serverCaps.find((row) => row.id === capId)?.http || [];
    if (!registered.some((route) => routes.includes(route.path))) return false;
    const module = await import(new URL("../../../" + file, import.meta.url).href);
    return registered.some((route) => routes.includes(route.path)
      && typeof route.handler === "function" && Object.values(module).includes(route.handler));
  };
  const tableSrc = read("server/capabilities.js");
  const wiredByTable = (file, capId) => {
    const cap = serverCaps.find((row) => row.id === capId);
    if (!cap) return false;
    const callSites = [cap.init, cap.handle, cap.onConnect, ...(cap.http || []).map((route) => route.handler)]
      .filter((fn) => typeof fn === "function").map(String).join("\n");
    for (const match of tableSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.\/[^"']+)["']/g)) {
      if ("server/" + match[2].slice(2) !== file) continue;
      for (const field of match[1].split(",")) {
        const name = field.trim().split(/\s+as\s+/).pop();
        if (new RegExp(`\\b${name}\\s*\\(`).test(callSites)) return true;
      }
    }
    return false;
  };
  for (const [f, capId] of declaredBy) {
    if (!backend.includes(f)) { bad.push(`${capId}: ${f} 가 없다`); continue; }
    const s2 = read(f);
    const mine = [...ownerOf].filter(([n, c]) => c === capId && (s2.includes(`"${n}"`) || s2.includes(`'${n}'`))).length;
    const routes = (CAPS.find((c) => c.id === capId) || {}).routes || [];
    if (!mine && !await servesRoute(f, capId, routes) && !wiredByTable(f, capId)) {
      bad.push(`${capId}: ${f} 가 그 기능의 메시지도 경로도 안 다룬다`);
    }
  }
  // 적어야 하는데 안 적은 파일이 있는가.
  for (const f of backend) {
    if (declaredBy.has(f)) continue;
    const s2 = read(f);
    const tally = new Map();
    for (const [n, c] of ownerOf) {
      if (!(s2.includes(`"${n}"`) || s2.includes(`'${n}'`))) continue;
      tally.set(c, (tally.get(c) || 0) + 1);
    }
    const shell = tally.get("틀") || 0;
    for (const [c, n] of tally) {
      if (c === "틀" || c === "여럿") continue;
      if (n >= 3 && n > shell) bad.push(`${f} 는 ${c} 의 메시지를 ${n} 개 다룬다(틀 ${shell}) — ${c} 이 server 에 적어야 한다`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("서버 기능 표의 id 는 렌더러 표에도 있다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  if (!capabilities.length) cannotMeasure("서버 기능 표가 비었다");
  const ids = new Set(CAPABILITIES.map((cap) => cap.id));
  const unknown = capabilities.filter((cap) => !ids.has(cap.id)).map((cap) => cap.id);
  if (unknown.length) throw new Error("렌더러에 없는 서버 기능: " + unknown.join(", "));
  return true;
});

await checkAsync("서버·네이티브 표의 행은 렌더러 표에 server·native 로 적혀 있다 — 재시작 안내가 그 표시로 판정한다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  const { createRequire } = await import("node:module");
  const { NATIVE_CAPABILITIES } = createRequire(import.meta.url)("../../../native/electron/capabilities.cjs");
  const rows = new Map(CAPABILITIES.map((cap) => [cap.id, cap]));
  const bad = [];
  for (const cap of capabilities) if (!rows.get(cap.id)?.server?.length) bad.push(`${cap.id}: server 없음`);
  for (const cap of NATIVE_CAPABILITIES) if (rows.get(cap.id)?.native !== true) bad.push(`${cap.id}: native 없음`);
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 기본 꺼짐은 렌더러(설정 목록·확인 창)와 네이티브(부팅 판정)가 각자 표에서 읽는다. 한쪽만 적으면
// 설정은 꺼짐인데 네이티브가 돌거나, 확인 창 없이 켜진다. 서버 부팅 판정은 optIn 을 모른다.
await checkAsync("기본 꺼짐(optIn)은 렌더러·네이티브 표가 같고, 확인 창 문구를 갖고, 서버 쪽 구성 요소가 없다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  const { createRequire } = await import("node:module");
  const { NATIVE_CAPABILITIES } = createRequire(import.meta.url)("../../../native/electron/capabilities.cjs");
  const optIn = CAPABILITIES.filter((cap) => cap.optIn);
  if (!optIn.length) cannotMeasure("렌더러 표에 기본 꺼짐 기능이 없다");
  const native = new Map(NATIVE_CAPABILITIES.map((cap) => [cap.id, !!cap.optIn]));
  const bad = [];
  for (const cap of CAPABILITIES) {
    if (native.has(cap.id) && native.get(cap.id) !== !!cap.optIn) bad.push(`${cap.id}: 렌더러 ${!!cap.optIn} · 네이티브 ${native.get(cap.id)}`);
  }
  for (const [id, on] of native) if (on && !CAPABILITIES.some((cap) => cap.id === id && cap.optIn)) bad.push(`${id}: 네이티브만 optIn`);
  for (const cap of optIn) {
    const o = cap.optIn;
    if (typeof o.title !== "string" || !o.title || !Array.isArray(o.items) || !o.items.length
      || o.items.some((item) => typeof item !== "string" || !item)) bad.push(`${cap.id}: 확인 창 문구(title·items) 없음`);
    if (cap.server?.length || capabilities.some((row) => row.id === cap.id)) bad.push(`${cap.id}: 서버 쪽 구성 요소가 있음`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("서버 진입점에 기능 표가 선언한 WS 접두사·HTTP 경로가 리터럴로 없다", async () => {
  const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  const strip = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const entry = strip("server/index.js") + "\n" + strip("server/http-handler.js");
  const names = capabilities.flatMap((cap) => [...(cap.wsPrefixes || []), ...(cap.http || []).map((route) => route.path)]);
  if (!names.length) cannotMeasure("서버 표가 접두사·경로를 선언하지 않는다");
  const leaked = names.filter((name) => [`"${name}"`, `'${name}'`, "`" + name + "`"].some((literal) => entry.includes(literal)));
  if (leaked.length) throw new Error("기능 표를 우회하는 진입점: " + leaked.join(", "));
  return true;
});

await checkAsync("세 표의 기능 id 는 상태 계약이 받는 이름 규칙을 지킨다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
  const { createRequire } = await import("node:module");
  const { NATIVE_CAPABILITIES } = createRequire(import.meta.url)("../../../native/electron/capabilities.cjs");
  const { FEATURE_ID: rule } = createRequire(import.meta.url)("../../../server/feature-state-read.cjs");
  const bad = [...CAPABILITIES, ...capabilities, ...NATIVE_CAPABILITIES].map((cap) => cap.id).filter((id) => !rule.test(id));
  if (bad.length) throw new Error("상태 계약이 거절할 id: " + bad.join(", "));
  return true;
});

check("서버 진입점이 기능 초기화를 직접 부르지 않는다", () => {
  const table = read("server/capabilities.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const entry = read("server/index.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const names = [...new Set([...table.matchAll(/\b(init[A-Z][\w$]*)\s*\(/g)].map((match) => match[1]))];
  if (!names.length) cannotMeasure("서버 표에서 기능 초기화 이름을 못 찾았다");
  const direct = names.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(entry));
  if (direct.length) throw new Error("기능 표를 우회하는 초기화: " + direct.join(", "));
  return true;
});

check("기능 상태는 이관 표식 외에 localStorage 를 쓰지 않는다", () => {
  const source = read("web/js/core/features.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const markers = new Set(["\"ac.railHidden.migrated\"", "'ac.railHidden.migrated'"]);
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*["']ac\.railHidden\.migrated["']/g)) markers.add(match[1]);
  const keys = [...source.matchAll(/\bconst\s+(\w+)\s*=\s*["']ac\.railHidden["']/g)].map((match) => match[1]);
  for (const key of keys) {
    const expression = new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${key}\\s*\\+\\s*["']\\.migrated["']`, "g");
    for (const match of source.matchAll(expression)) markers.add(match[1]);
  }
  const writes = [...source.matchAll(/\blocalStorage\.(setItem|removeItem|clear)\s*\(\s*([^,)]*)/g)];
  const forbidden = writes.filter((match) => match[1] !== "setItem" || !markers.has(match[2].trim()));
  if (forbidden.length || /\blocalStorage\s*\[|\blocalStorage\.[\w$]+\s*=/.test(source)) {
    throw new Error("기능 상태를 localStorage 에 다시 저장한다");
  }
  return true;
});

// 훅 이름과 같은 종류의 무증상 결함이 조립부에 넘기는 deps 에도 있다. 보내는 쪽이 이름을
// 실어도 받는 쪽이 꺼내지 않으면 아무 경고 없이 그 값이 undefined 로 남는다. 호출하는 순간
// TypeError 가 나는데, 그 위치가 await 뒤이거나 예외를 잡는 곳이 없으면 사용자에게는
// 눌러도 아무 일이 없는 것으로만 보인다.
//
// 확인 결과: text-editor.js 가 보낸 monaco 관련 이름 중 일부를 tab-close.js 의
// bindTabCloseTextEditor 가 꺼내지 않고 있었다. 그래서 되돌리기 커밋(commitDiscardTab)과
// 이름 바꾼 파일의 탭 재조준(retargetFileTabs)이 첫 줄에서 실패했고, 「저장 안 함」을 눌러도
// 아무 일도 일어나지 않았다.
//
// 꺼내는 형태가 셋이라 셋 다 센다: ({a} = deps) · const {a} = deps · deps.a.
// 하나만 보면 나머지 두 형태가 전부 안 받는 것으로 잡혀 오탐이 발생한다.
check("조립부에 보낸 이름은 받는 쪽이 꺼낸다", () => {
  const files = sourceFiles("web").filter((rel) => rel.endsWith(".js"));
  const nude = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const src = new Map(files.map((rel) => [rel, nude(rel)]));
  if (src.size < 60) cannotMeasure(`렌더러 파일을 ${src.size} 개만 읽었다`);

  const consumes = new Map();
  for (const [rel, body0] of src) {
    for (const m of body0.matchAll(/export function ([A-Za-z_$][\w$]*)\s*\(\s*(?:deps|opts)\s*\)\s*\{([\s\S]{0,1400}?)\n\}/g)) {
      const body = m[2];
      const names = new Set();
      const pats = [...body.matchAll(/\(\{([\s\S]*?)\}\s*=\s*(?:deps|opts)\)/g),
        ...body.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:deps|opts)\b/g)];
      for (const d of pats) {
        for (const n of d[1].split(",")) {
          const t = n.trim().split(":")[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        }
      }
      // 셋째 꼴: deps.NAME 을 그대로 읽는다(memo 가 AUX_MODE 를 그렇게 받는다).
      for (const d of body.matchAll(/\b(?:deps|opts)\.([A-Za-z_$][\w$]*)/g)) names.add(d[1]);
      if (names.size) consumes.set(m[1], { rel, names });
    }
  }
  // 이 검사가 조용히 아무것도 안 재는 상태로 낡는 것을 막는다.
  if (consumes.size < 20) cannotMeasure(`deps 를 꺼내는 함수를 ${consumes.size} 개만 찾았다 — 훑개가 죽었다`);

  const bad = [];
  for (const [rel, body] of src) {
    for (const [fn, info] of consumes) {
      for (const m of body.matchAll(new RegExp(fn + "\\(\\{([\\s\\S]*?)\\}\\s*\\)", "g"))) {
        const keys = [];
        for (const k of m[1].split(",")) {
          const t = k.trim().split(":")[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.push(t);
        }
        const dropped = keys.filter((k) => !info.names.has(k));
        if (dropped.length) {
          bad.push(`${rel} 이 ${fn} 에 보내는 ${dropped.join(", ")} 를 ${info.rel} 이 안 꺼낸다`);
        }
      }
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 코어가 화면 모듈을 import 하면 그 기능을 끈 사용자에게도 모듈이 로드되므로 이름으로 호출한다.
// 없는 이름을 호출하면 아무 동작도 하지 않는 것이 이 장치의 설계라서 오타가 드러나지 않는다.
// 그래서 호출하는 이름마다 채우는 쪽이 있어야 하고, 채워 놓고 호출하지 않는 이름도 없어야 한다.
// 채우는 쪽은 기능이어야 한다. 앱 셸이 채우면 기능을 꺼도 그 동작이 남아 훅이 무의미해진다.
await checkAsync("부르는 이름은 채우는 자리가 있다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const capFiles = new Set(CAPABILITIES.flatMap((c) => c.files.map((f) => "web/js/" + f)));
  const files = sourceFiles("web").filter((rel) => rel.endsWith(".js"));
  const called = new Map(), provided = new Map();
  for (const rel of files) {
    const src = read(rel).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // hasHook 도 호출 지점이다. 그 이름이 없으면 항상 거짓이 된다.
    for (const m of src.matchAll(/(?:callHook|hasHook)\(\s*"([^"]+)"/g)) called.set(m[1], rel);
    // 기능 id 를 앞에 붙여 부르는 이름(features.js 가 끌 때 부르는 `${id}.disabling`)은 기본 꺼짐 기능마다
    // 부르는 이름으로 센다. 그래서 기본 꺼짐 기능은 그 이름을 채워야 한다.
    for (const m of src.matchAll(/callHook\(\s*`\$\{\w+\}\.(\w+)`/g)) {
      for (const cap of CAPABILITIES.filter((c) => c.optIn)) called.set(`${cap.id}.${m[1]}`, rel);
    }
    // 채우는 쪽은 여러 곳일 수 있으므로 덮어쓰지 않고 쌓는다. 덮으면 둘이 같은 이름을 채우는
    // 것이 한 곳으로 보여서, 먼저 것이 거절당하는 그 상황을 검사가 못 본다.
    for (const m of src.matchAll(/\bprovide\(\s*"([^"]+)"/g)) {
      if (!provided.has(m[1])) provided.set(m[1], []);
      provided.get(m[1]).push(rel);
    }
  }
  const twice = [...provided].filter(([, rs]) => new Set(rs).size > 1)
    .map(([n, rs]) => `${n}(${[...new Set(rs)].join(" · ")})`);
  if (twice.length) throw new Error("두 곳이 채우는 이름: " + twice.join(", "));
  if (!called.size) cannotMeasure("부르는 자리를 하나도 못 찾았다 — 뽑는 방식이 깨졌다");
  const orphan = [...called].filter(([n]) => !provided.has(n)).map(([n, r]) => `${n}(${r})`);
  const unused = [...provided].filter(([n]) => !called.has(n)).map(([n, rs]) => `${n}(${rs[0]})`);
  if (orphan.length) throw new Error("채우는 자리가 없는 이름: " + orphan.join(", "));
  if (unused.length) throw new Error("아무도 안 부르는 이름: " + unused.join(", "));
  // 이름은 "기능.동작" 꼴이다. 앞부분이 어느 기능이 채우는지를 말한다.
  const shapeless = [...called.keys()].filter((n) => !/^[a-z][a-z0-9]*\.[a-zA-Z]/.test(n));
  if (shapeless.length) throw new Error("기능.동작 꼴이 아닌 이름: " + shapeless.join(", "));
  const inShell = [];
  for (const [name, rs] of provided) for (const rel of rs) {
    if (!capFiles.has(rel)) inShell.push(`${name}(${rel})`);
  }
  if (inShell.length) throw new Error("기능이 아닌 곳이 채우는 이름: " + inShell.join(", "));
  return true;
});

// 이름으로 호출하기로 해 놓고 그 옆에 import 를 남기면 모듈은 그대로 로드되고 검사만 통과한다.
// `docs/iris-screens.json` 은 화면마다 id 를 매기고, 순차 점검표가 그 id 로 항목을 센다.
// 그 id 가 실물과 일치하지 않으면 점검표가 없는 화면을 가리키고, 「점검 완료」를 적을 항목을
// 찾을 수 없다. 완료 판정이 걸린 값이라 최신 상태를 유지해야 한다.
//
// rail 화면만 rail 목록과 대조한다. 창 화면(browser-window·memo-window)은 rail 항목이 아니고
// id 체계도 달라서, rail 에서 찾으면 넷이 항상 실패한다.
check("화면 목록의 rail 항목이 실제 rail 과 같다", () => {
  const screens = JSON.parse(read("docs/iris-screens.json")).screens;
  if (!Array.isArray(screens) || screens.length < 5) cannotMeasure(`화면 목록이 ${screens && screens.length}개 — 세는 방식이 깨졌다`);
  const railIds = new Set([...read("web/js/core/rail-items.js").matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]));
  if (railIds.size < 5) cannotMeasure(`rail id 를 ${railIds.size}개밖에 못 뽑았다 — 세는 방식이 깨졌다`);
  const railScreens = screens.filter((s) => s.kind === "rail");
  if (!railScreens.length) cannotMeasure("rail 종류 화면이 하나도 없다 — 세는 방식이 깨졌다");
  const bad = [];
  for (const s of railScreens) if (!railIds.has(s.entry)) bad.push(`${s.id}(${s.name}) → ${s.entry} 가 rail 에 없다`);
  for (const id of railIds) if (!railScreens.some((s) => s.entry === id)) bad.push(`rail 의 ${id} 가 화면 목록에 없다`);
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

check("코어는 화면 모듈을 정적으로 끌어오지 않는다", () => {
  const SCREENS = ["panel/memo-admin.js", "browser/autofill-allowlist.js", "devtool/source-control.js",
    "devtool/localdev.js", "devtool/keymap-page.js"];
  const OWNER = { "panel/memo-admin.js": ["panel/"], "browser/autofill-allowlist.js": ["browser/autofill"] };
  const bad = [];
  for (const rel of sourceFiles("web").filter((r) => r.endsWith(".js"))) {
    if (rel === "web/js/main.js") continue;   // 조립부. 여기를 가르는 것은 다음 단계다
    const src = read(rel).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const screen of SCREENS) {
      const base = screen.split("/").pop();
      if (!new RegExp(`from "[^"]*${base.replace(".", "\\.")}"`).test(src)) continue;
      const owners = OWNER[screen] || [];
      if (owners.some((o) => rel.includes(o))) continue;   // 같은 기능 안에서는 서로 불러도 된다
      bad.push(`${rel} → ${screen}`);
    }
  }
  if (bad.length) throw new Error("코어가 화면을 끌어온다: " + bad.join(", "));
  return true;
});

// 위 검사는 소스 문자열로 import 를 센다. 형태를 하나 빠뜨리면 그대로 통과한다. 부작용 import ·
// 홑따옴표 · Worker · HTML script 를 차례로 추가해 온 이유다. 그래서 같은 것을 문자열이 아니라
// 번들러가 실제로 푼 그래프로 한 번 더 확인한다. esbuild 는 이미 devDependency 라 새로
// 추가할 것이 없고, 어떤 형태로 적었든 그 도구가 도달한 것이 곧 앱에 로드된다.
//
// 셋을 확인한다.
//   앱 셸에서 기능으로 가는 정적 의존 0. 하나라도 있으면 끄는 의미가 없다
//   기능에서 다른 기능으로 가는 정적 의존 0. 두 사람이 각자 고칠 수 있다는 조건이다
//   기능으로 들어가는 동적 의존의 출발은 등록표 하나. 다른 데서 부르면 표가 정본이 아니게 된다
// 문자열로 세는 위 검사도 유지한다. 이쪽은 main.js 에서 출발하는 모듈 그래프만 보므로
// HTML 이 고전 스크립트로 로드하는 경로는 보지 못한다. 둘이 서로 다른 범위를 덮는다.
await checkAsync("묶어 보면 틀에서 기능으로 가는 정적 길이 없다", async () => {
  const esbuild = (await import("esbuild")).default;
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const built = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ["web/js/main.js"],
    bundle: true, write: false, metafile: true, format: "esm", logLevel: "silent",
  });
  const inputs = built.metafile.inputs;
  const files = Object.keys(inputs);
  if (files.length < 60) throw new Error(`그래프가 먹혔다: 입력 ${files.length} 파일`);

  const ownerOf = new Map();
  for (const cap of CAPABILITIES) for (const f of cap.files || []) ownerOf.set("web/js/" + f, cap.id);
  if (ownerOf.size < 20) cannotMeasure(`기능 소유 파일이 ${ownerOf.size} 개다 — 표를 못 읽었다`);

  const bad = [];
  // 표가 대는 파일이 그래프에 아예 없으면, 그 줄은 아무도 안 부르는 이름이다.
  for (const f of ownerOf.keys()) if (!inputs[f]) bad.push(`${ownerOf.get(f)}: ${f} 에 닿는 길이 없다`);

  let dynamicIntoFeature = 0;
  for (const [from, info] of Object.entries(inputs)) {
    for (const imp of info.imports || []) {
      const to = imp.path;
      if (!inputs[to]) continue;                      // 저장소 밖(vendor·패키지)은 안 본다
      const a = ownerOf.get(from), b = ownerOf.get(to);
      if (!b) continue;                               // 들어가는 곳이 기능이 아니면 이 검사 밖
      if (imp.kind === "dynamic-import") {
        dynamicIntoFeature++;
        if (from !== "web/js/core/capabilities.js") bad.push(`${b}: ${from} 가 동적으로 부른다 — 표 밖의 입구`);
        continue;
      }
      if (!a) bad.push(`${b}: 틀의 ${from} 가 ${to} 를 정적으로 끌어온다`);
      else if (a !== b) bad.push(`${a} 가 ${b} 를 정적으로 끌어온다: ${from} -> ${to}`);
    }
  }
  // 동적 변을 하나도 못 셌다면 이 검사는 아무것도 안 재고 있다.
  if (dynamicIntoFeature < 5) throw new Error(`기능으로 들어가는 동적 변을 ${dynamicIntoFeature} 개만 셌다 — 계측기가 죽었다`);
  if (bad.length) throw new Error(bad.join(" | "));
  return true;
});

// 분리 브라우저 창은 표·문서 탭이 생성되는 창이다(dock.js 의 reconcileDocTabs 는 BROWSER_MODE
// 에서만 동작하고, 등록표에 있는 종류만 만든다). 등록표에 종류를 등록하는 기능이 그 창에
// 로드되지 않으면 아무도 그리지 않는 탭만 생긴다. 뷰어를 main.js 에서 분리할 때 창 목록을
// 적지 않아, 브라우저가 분리형인 사용자에게 표·문서가 표시되지 않은 적이 있다.
await checkAsync("등록표에 종류를 세우는 기능은 분리 브라우저 창에서도 산다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const bad = [];
  for (const cap of CAPABILITIES) {
    const registers = (cap.files || []).some((f) => /registerFileKind\s*\(/.test(read("web/js/" + f)));
    if (!registers) continue;
    if (!(cap.windows || ["main"]).includes("browser")) bad.push(cap.id);
  }
  if (bad.length) throw new Error("분리 창에 안 실리는데 종류를 세운다: " + bad.join(", "));
  return true;
});

// 끈 기능이 로드되지 않는 근거는 하나다. 그 모듈에 이르는 유일한 경로가 동적 import 라는 것이다.
// 정적 import 가 하나라도 남아 있으면 표를 어떻게 짜도 모듈은 로드되고 검사만 통과한다.
await checkAsync("켠 것만 싣는다는 말이 실제로 성립한다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const capSrc = read("web/js/core/capabilities.js");
  if (!CAPABILITIES.length) throw new Error("capability 표가 비었다");
  const bare = capSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 이 파일 자신이 화면을 정적으로 import 하면 표를 읽는 순간 전부 로드된다.
  if (/^\s*import\s+[^(]/m.test(bare)) throw new Error("capability 표가 정적 import 를 갖고 있다");
  const bad = [];
  for (const cap of CAPABILITIES) {
    if (typeof cap.load !== "function") { bad.push(`${cap.id}: load 가 없다`); continue; }
    const body = String(cap.load);
    const m = /import\(\s*"(\.[^"]+)"\s*\)/.exec(body);
    if (!m) { bad.push(`${cap.id}: load 가 동적 import 가 아니다`); continue; }
    const target = "web/js/core/" + m[1];
    const rel = target.replace(/[^/]+\/\.\.\//g, "");
    // 그 모듈에 이르는 다른 경로가 하나라도 있으면 끄는 의미가 없다. from "..." 한 형태만
    // 찾으면 부작용 import·홑따옴표·HTML script·Worker·다른 곳의 동적 import 를 놓친다.
    // 우회 경로를 전부 세지 않는 검사는 통과해도 아무것도 보장하지 않는다.
    // 진입 파일 하나만 확인하는 것도 같은 종류의 누락이었다. 파일이 여럿인 모듈 집합은 내부
    // 파일로 우회된다. 앱 셸이 browser/record.js 를 정적으로 import 하면 pickrec 은 꺼도
    // 로드되는데, 진입 파일(pick-boot.js)에는 문제가 없어서 검사가 통과했다.
    // 그래서 이 모듈 집합의 파일을 전부 확인한다. 진입 파일은 아무도 import 하면 안 되고,
    // 내부 파일은 같은 집합 안에서만 import 할 수 있다.
    const own = new Set(cap.files.map((f) => "web/js/" + f));
    if (!own.has(rel)) bad.push(`${cap.id}: load 가 자기 파일이 아닌 ${rel} 를 부른다`);
    // 파일 이름 끝만 비교하면 viewer/boot.js 를 추가할 때 main 이 부르는 core/capability-boot.js
    // 가 boot.js 로 끝난다는 이유로 걸린다. 이름이 겹치는 날 없는 결함을 만들고, 반대로 같은
    // 이름의 다른 파일을 놓친다. 상대 경로를 실제로 해석해 그 파일인지로 판정한다.
    const resolve = (fromFile, spec) => {
      const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
      const out = [];
      for (const part of (dir + "/" + spec).split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") out.pop(); else out.push(part);
      }
      return out.join("/");
    };
    const specRe = /(?:from\s*|import\s*|import\(\s*|new\s+Worker\(\s*)["'`](\.[^"'`]+)["'`]/g;
    for (const mine of new Set([rel, ...own])) {
      const importers = sourceFiles("web").filter((f) => {
        if (!f.endsWith(".js") || f === mine || f === "web/js/core/capabilities.js") return false;
        if (mine !== rel && own.has(f)) return false;   // 같은 뭉치 안에서는 서로 끌어도 된다
        const src = read(f).replace(/\/\/[^\n]*/g, "");
        for (const m2 of src.matchAll(specRe)) if (resolve(f, m2[1]) === mine) return true;
        return false;
      });
      if (importers.length) bad.push(`${cap.id}: ${importers.join(", ")} 가 ${mine} 를 끌어온다`);
      // HTML 이 고전 스크립트로 로드하면 모듈 표와 상관없이 항상 로드된다.
      // 이름 끝만 비교하면 boot.js 넷이 서로를 가리키므로 앞 경로까지 붙여서 판정한다.
      const tail = mine.split("/").slice(-2).join("/");
      const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const inHtml = sourceFiles("web").filter((f) => f.endsWith(".html")
        && new RegExp(`<script[^>]*src=["'][^"']*${esc}["']`).test(read(f)));
      if (inHtml.length) bad.push(`${cap.id}: ${inHtml.join(", ")} 가 ${mine} 를 script 로 싣는다`);
    }
    if (cap.rail && !RAIL_ITEMS_IDS.includes(cap.rail)) bad.push(`${cap.id}: rail 표에 ${cap.rail} 이 없다`);
  }
  // 같은 메시지 type 을 main 표와 기능이 둘 다 들고 있으면 나중에 꽂힌 쪽이 조용히 이긴다.
  // 그러면 그 기능을 꺼도 main 쪽 처리기가 남아 모듈이 딸려 오고, 켜면 두 벌이 돈다.
  const mainTypes = new Set([...read("web/js/main.js").matchAll(/^\s*"([^"]+)": dispatchWs\(/gm)].map((m) => m[1]));
  const setups = /export const CAPABILITIES = \[([\s\S]*?)\n\];/.exec(capSrc);
  if (!setups) cannotMeasure("capability 표를 못 읽었다");
  // 겹침은 main 과의 사이에서만 생기지 않는다. 두 기능이 같은 메시지를 등록하면 나중에 등록한
  // 쪽이 이긴다. 지금은 부팅이 그것을 거절하지만, 표에 그렇게 적혀 있는 것 자체가 결함이다.
  const owner = new Map();
  for (const cap of CAPABILITIES) {
    const at = capSrc.indexOf(`id: "${cap.id}"`);
    if (at < 0) continue;
    const next = capSrc.slice(at + 1).search(/\n\s*id: "/);
    const block = next < 0 ? capSrc.slice(at) : capSrc.slice(at, at + 1 + next);
    const ws = /ws:\s*\{([\s\S]*?)\n\s*\},/.exec(block) || /ws:\s*\{([^}]*)\}/.exec(block);
    if (!ws) continue;
    for (const t of ws[1].matchAll(/"([a-z][a-z0-9.-]*)"\s*:/g)) {
      const had = owner.get(t[1]);
      if (had && had !== cap.id) bad.push(`${t[1]}: ${had} 와 ${cap.id} 이 둘 다 들고 있다`);
      else owner.set(t[1], cap.id);
    }
  }
  for (const m of setups[1].matchAll(/"([a-z][a-z0-9.-]*)":\s*on\b|ws:\s*\{([^}]*)\}/g)) {
    const chunk = m[2] || m[1] || "";
    for (const t of chunk.matchAll(/"([a-z][a-z0-9.-]*)"\s*:/g)) {
      if (mainTypes.has(t[1])) bad.push(`${t[1]}: main 표와 기능이 둘 다 들고 있다`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 부팅은 순수 함수라 가상 표로 직접 실행한다. 끈 것은 load 를 부르지 않는가, 하나가 실패해도
// 나머지는 로드되는가, 실패를 삼키지 않는가. 셋 다 이 장치의 존재 이유다.
await checkAsync("끈 것은 부르지도 않고, 하나가 터져도 나머지는 실린다", async () => {
  const { bootCapabilities } = await import(new URL("../../../web/js/core/capability-boot.js", import.meta.url).href);
  const called = [], screensGot = [], errs = [];
  const items = [
    { id: "on1", rail: "railone", load: async () => { called.push("on1"); return { v: 1 }; }, setup: () => ({ screen: { enter() {} } }) },
    // rail 이 없는데 화면을 돌려주는 항목. 그 화면에는 진입 경로가 없으므로 등록되면 안 되고,
    // 조용히 넘어가서도 안 되며 그 기능만 실패로 보고돼야 한다. 소스 문자열을 보는 검사는
    // helper 로 돌려주면 보지 못하지만, 이 검사는 실제로 돌려준 값을 본다.
    { id: "doorless", load: async () => { called.push("doorless"); return {}; }, setup: () => ({ screen: { enter() {} } }) },
    { id: "off1", load: async () => { called.push("off1"); return {}; } },
    { id: "boom", load: async () => { called.push("boom"); throw new Error("터짐"); } },
    { id: "on2", rail: "railtwo", load: async () => { called.push("on2"); return {}; },
      setup: () => ({ screen: { enter() {} }, ws: { "a-msg": () => {}, "b-msg": () => {} } }) },
  ];
  const wsGot = [];
  const loaded = await bootCapabilities({
    items, isOn: (id) => id !== "off1", ctx: { x: 1 },
    onScreen: (id) => screensGot.push(id), onError: (id) => errs.push(id),
    onWs: (type, fn, id) => wsGot.push(`${id}:${type}:${typeof fn}`),
  });
  // 서버 메시지 처리기도 기능이 등록한다. 등록되지 않으면 화면만 뜨고 아무것도 받지 못한다.
  if (wsGot.join(",") !== "on2:a-msg:function,on2:b-msg:function") throw new Error("ws 처리기가 안 꽂혔다: " + wsGot.join(","));
  if (called.includes("off1")) throw new Error("끈 것을 실었다");
  if (!called.includes("on1") || !called.includes("on2")) throw new Error("켠 것을 안 실었다");
  if (screensGot.includes("doorless")) throw new Error("문 없는 화면을 등록했다");
  if (!called.includes("boom")) throw new Error("터지는 것을 시도조차 안 했다");
  if (loaded.join(",") !== "on1,on2") throw new Error("실은 목록이 틀렸다: " + loaded.join(","));
  if (errs.join(",") !== "doorless,boom") throw new Error("실패를 안 올렸다: " + errs.join(","));
  if (screensGot.join(",") !== "railone,railtwo") throw new Error("화면 자리를 틀리게 꽂았다: " + screensGot.join(","));
  return true;
});

// 안내 문구가 실제 조합과 다르면 사용자는 엉뚱한 키를 누르고 동작하지 않는 것으로 판단한다.
// 메인 창의 ⌘R 은 이름 변경이고 앱을 다시 읽는 것은 ⌘⇧R 이다. 문구와 그 동작을 하는 코드를
// 함께 확인한다.
check("다시 읽으라는 안내가 실제 조합과 같다", () => {
  const keynav = read("web/js/core/keynav.js").replace(/\/\/[^\n]*/g, "");
  const page = read("web/js/devtool/keymap-page.js").replace(/\/\/[^\n]*/g, "");
  // 메인 창에서 앱을 다시 읽는 지점이 shift 를 요구하는지 확인한다.
  const seg = /if \(!BROWSER_MODE && e\.metaKey && e\.shiftKey && [^)]*k === "r"\) \{([\s\S]{0,300}?)\n    \}/.exec(keynav);
  if (!seg) throw new Error("앱 재로딩 자리를 못 찾음");
  if (!/appReload|location\.reload/.test(seg[1])) throw new Error("그 자리가 다시 읽는 일을 안 한다");
  const features = read("web/js/core/features.js").replace(/\/\/[^\n]*/g, "");
  const note = sliceBetween(features, "export function featureRestartNote(id)", "export function featureIsKnown");
  if (!/showToast\([^;]*featureRestartNote\(id\)/.test(page)) throw new Error("설정이 기능별 다시 읽기 안내를 안 쓴다");
  const toast = /"([^"]*다시 읽으면[^"]*)"/.exec(note);
  if (!toast) throw new Error("안내 문구를 못 찾음");
  if (!/⌘⇧R/.test(toast[1])) throw new Error("안내가 ⌘⇧R 이 아니다: " + toast[1]);
  // ⌘R 만 적혀 있으면 그것은 이름 변경이다.
  if (/(^|[^⇧])⌘R/.test(toast[1])) throw new Error("⌘R 은 이름 변경이다: " + toast[1]);
  return true;
});

// 기능은 main 이 준 ctx 로만 연결한다. 없는 이름을 꺼내면 앱은 뜨고 그 화면만 동작하지 않으며
// 검사는 모두 통과한다. 그래서 쓰는 이름과 주는 이름을 대조한다.
await checkAsync("기능이 꺼내 쓰는 이름을 main 이 실제로 준다", async () => {
  // 연결은 각 기능 파일에 있고 표에는 선언만 남았으므로 기능 파일 전부를 확인한다.
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  // ctx 는 initCapability(ctx) 로만 들어온다. 기능 파일 전부를 검사하면 같은 이름의 다른 지역
  // 변수까지 세게 된다. 표의 수식이 { book, cache, busy } 를 ctx 로 부르고 있어서 main 이 그
  // 셋을 주지 않는다고 실패한 적이 있다. 실제로 ctx 를 받는 파일만 확인한다.
  const capSrc = [read("web/js/core/capabilities.js"),
    ...CAPABILITIES.flatMap((c) => c.files.map((f) => read("web/js/" + f)))
      .filter((src) => /function\s+initCapability\s*\(/.test(src))]
    .join("\n").replace(/\/\/[^\n]*/g, "");
  const mainSrc = read("web/js/main.js");
  const used = new Set([...capSrc.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  if (!used.size) cannotMeasure("ctx 를 쓰는 자리를 하나도 못 찾았다 — 뽑는 방식이 깨졌다");
  const block = /\n {4}ctx: \{([\s\S]*?)\n {4}\},/.exec(mainSrc);
  if (!block) throw new Error("main 의 ctx 블록을 못 찾았다");
  const given = new Set();
  for (const m of block[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) given.add(m[1]);
  for (const m of block[1].matchAll(/(^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=[,\n])/g)) given.add(m[2]);
  const missing = [...used].filter((n) => !given.has(n));
  if (missing.length) throw new Error("main 이 안 주는 이름: " + missing.join(", "));
  return true;
});

// 기능마다 병렬 수정이 가능한지는 문장으로 검사할 수 없다. 성립 조건은 하나다. 기능 하나만 쓰는
// 파일이 그 기능의 것이고, 두 기능이 같은 파일을 쓰지 않는 것이다. 그래야 둘이 동시에 작업해도
// 같은 파일에서 만나지 않는다. 여기서 그 배타성을 실제로 확인한다.
await checkAsync("기능은 자기 파일을 배타로 갖는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const files = new Set(sourceFiles("web").filter((f) => f.endsWith(".js") && f.startsWith("web/js/")));
  const staticEdges = (rel) => {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    const out = [];
    for (const m of read(rel).matchAll(/from\s+"(\.[^"]+)"/g)) {
      const t = (dir + "/" + m[1]).split("/").reduce((acc, part) => {
        if (part === ".") return acc;
        if (part === "..") { acc.pop(); return acc; }
        acc.push(part); return acc;
      }, []).join("/");
      if (files.has(t)) out.push(t);
    }
    return out;
  };
  const reach = (roots) => {
    const seen = new Set(), stack = [...roots];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of staticEdges(cur)) stack.push(n);
    }
    return seen;
  };
  // 항상 로드되는 앱 셸은 main 에서 정적으로 도달하는 것 전부다. 기능이 이것을 함께 쓰는 것은 정상이다.
  const shell = reach(["web/js/main.js"]);
  const owned = new Map();     // 파일 → 그 파일을 끌어오는 기능들
  const roots = new Map();
  for (const cap of CAPABILITIES) {
    const m = /import\(\s*"(\.[^"]+)"\s*\)/.exec(String(cap.load));
    if (!m) throw new Error(`${cap.id}: load 가 동적 import 가 아니다`);
    const root = ("web/js/core/" + m[1]).replace(/[^/]+\/\.\.\//g, "");
    if (!files.has(root)) throw new Error(`${cap.id}: ${root} 이 없다`);
    roots.set(cap.id, root);
    for (const f of reach([root])) {
      if (shell.has(f)) continue;                       // 틀과 함께 쓰는 것은 소유가 아니다
      if (!owned.has(f)) owned.set(f, []);
      owned.get(f).push(cap.id);
    }
  }
  const shared = [...owned].filter(([, ids]) => ids.length > 1);
  if (shared.length) {
    throw new Error("두 기능이 같은 파일을 쓴다: " + shared.map(([f, ids]) => `${f}(${ids.join("+")})`).join(", "));
  }
  // 기능의 진입 파일이 앱 셸에 들어와 있으면 그 기능은 이미 항상 로드된다는 뜻이다.
  const inShell = [...roots].filter(([, f]) => shell.has(f));
  if (inShell.length) {
    throw new Error("틀이 이미 끌어오는 기능: " + inShell.map(([id, f]) => `${id}(${f})`).join(", "));
  }
  if (![...owned.keys()].length) cannotMeasure("기능이 가진 파일이 하나도 없다 — 세는 방식이 깨졌다");
  return true;
});

// 병렬 수정은 파일만 겹치지 않으면 되는 것이 아니다. 두 사람이 각자 기능 하나를 고칠 때 만날 수
// 있는 지점은 여섯이다. 파일 · 페이지 · 훅 이름 · 서버 메시지 · rail 항목 · 패널. 하나라도
// 겹치면 한쪽 수정이 다른 쪽을 덮거나 거절당한다(ws 는 나중에 등록하는 쪽이 거절당하고, 훅은
// 나중 provide 가 경고를 낸다). 여기서 그 여섯을 기능 쌍마다 전부 대조한다.
await checkAsync("두 기능이 같은 자리에 손대지 않는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  // 정규식으로 끝을 찾으면 안쪽 객체에서 먼저 끊기므로 중괄호를 세어 그 블록만 잘라 온다.
  const block = (src, at) => {
    let d = 0, j = src.indexOf("{", at), e = -1;
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") { d--; if (!d) { e = k; break; } }
    }
    return e < 0 ? "" : src.slice(j, e);
  };
  const quotedKeys = (b) => [...b.matchAll(/"([a-z][a-z0-9.\-]*)":/g)].map((m) => m[1]);
  const surface = new Map();
  let hookCount = 0, wsCount = 0;
  for (const cap of CAPABILITIES) {
    const files = cap.files.map((f) => "web/js/" + f);
    const srcs = files.map((f) => read(f));
    const hooks = [];
    for (const s of srcs) for (const m of s.matchAll(/provide\(\s*"([^"]+)"/g)) hooks.push(m[1]);
    // 메시지 표는 두 형태로 적힌다. 그 자리에 바로 쓰거나(ws: { … }), 함수가 돌려주거나
    // (ws: initMemoCapability(ctx)). 앞 형태만 보면 메모의 열넷을 전부 놓친다.
    let ws = [], sawWs = false;
    for (const s of srcs) {
      if (/\bws:\s*/.test(s)) sawWs = true;
      const m = /ws:\s*\{/.exec(s);
      if (m) { ws = ws.concat(quotedKeys(block(s, m.index + 3))); continue; }
      const m2 = /ws:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(s);
      if (!m2) continue;
      for (const s2 of srcs) {
        const f = new RegExp("function\\s+" + m2[1] + "\\s*\\(").exec(s2);
        if (!f) continue;
        const r = s2.indexOf("return {", f.index);
        if (r >= 0) ws = ws.concat(quotedKeys(block(s2, r + 6)));
      }
    }
    // 표를 들고 있다고 적혀 있는데 하나도 못 읽었으면 세는 방식이 깨진 것이다. 조용히 0으로
    // 넘어가면 그 기능의 메시지는 이 검사 밖으로 빠진다.
    if (sawWs && !ws.length) cannotMeasure(`${cap.id}: ws 표를 못 읽었다`);
    hookCount += hooks.length; wsCount += ws.length;
    surface.set(cap.id, {
      파일: files, 지면: (cap.css || []).map((n) => "web/css/" + n),
      훅: hooks, 메시지: ws,
      rail: cap.rail ? [cap.rail] : [], 자리: cap.panel ? [cap.panel] : [],
    });
  }
  if (!hookCount || !wsCount) cannotMeasure("훅·메시지를 하나도 못 셌다 — 세는 방식이 깨졌다");
  const ids = [...surface.keys()];
  const bad = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = surface.get(ids[i]), b = surface.get(ids[j]);
      for (const axis of Object.keys(a)) {
        const both = a[axis].filter((x) => b[axis].includes(x));
        if (both.length) bad.push(`${ids[i]}·${ids[j]} 가 같은 ${axis}: ${both.join(", ")}`);
      }
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 훅은 그 기능을 끄면 그 지점이 아무 동작도 하지 않는 것으로 성립한다. 그런데 호출하는 쪽이
// 돌아온 값을 바로 참조하면(callHook(...).foo · [0] · for…of · 스프레드) 끈 순간 그 줄이
// 예외를 던진다. 채워졌을 때만 실행되는 코드라 평소 검사로는 잡히지 않고 그 기능을 끈 사용자만
// 만난다. 값을 변수에 받아 if 로 거르는 형태는 보지 못하지만, 바로 참조하는 형태는 문법으로 잡힌다.
check("훅에서 돌아온 값을 바로 파고들지 않는다", () => {
  const bad = [];
  for (const rel of sourceFiles("web").filter((f) => f.endsWith(".js") && f.startsWith("web/js/"))) {
    if (rel === "web/js/core/hooks.js") continue;
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    const lineOf = (i) => src.slice(0, i).split("\n").length;
    for (const m of src.matchAll(/\bcallHook\s*\(/g)) {
      // [^)]* 로 끝을 찾으면 인자 안의 괄호에서 먼저 끊기므로 괄호를 세어 끝을 찾는다.
      let d = 0, e = -1;
      for (let k = m.index + m[0].length - 1; k < src.length; k++) {
        if (src[k] === "(") d++;
        else if (src[k] === ")") { d--; if (!d) { e = k; break; } }
      }
      if (e < 0) continue;
      const after = src.slice(e + 1).match(/^\s*(.)/);
      if (after && (after[1] === "." || after[1] === "[")) {
        bad.push(`${rel}:${lineOf(m.index)} 돌아온 값을 바로 판다`);
      }
      const before = src.slice(Math.max(0, m.index - 14), m.index);
      if (/\bof\s+$/.test(before) || /\.\.\.\s*$/.test(before)) {
        bad.push(`${rel}:${lineOf(m.index)} 돌아온 값을 바로 펼친다`);
      }
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 이 목록이 곧 뷰어가 사라지는 화면이다. 여기 하나를 더하면 그 화면은 좁은 패널용 배치를 넓은
// 화면에 그대로 늘이므로, 목록과 배치 계약을 같은 곳에서 확인한다.
await checkAsync("뷰어를 덮는 화면 목록이 배치 계약과 같은 것을 가리킨다", async () => {
  const { RAIL_ITEMS: items } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  const views = items.filter((f) => f.layout === "full").map((f) => f.id);
  if (views.length < 5) throw new Error(`뷰어를 덮는 화면이 ${views.length}개뿐`);
  if (!/const RAIL_FULL = new Set\(fullIds\(\)\);/.test(rail)) throw new Error("rail 이 표의 배치를 안 쓴다");
  for (const f of items) {
    if (f.layout !== "full" && f.layout !== "panel") throw new Error(f.id + ": 배치가 full 도 panel 도 아니다");
  }
  // 덮는 동작은 이 규칙 하나로 성립한다. 이 규칙이 빠지면 목록이 맞아도 뷰어가 사라지지 않는다.
  return /body\.util-full \.center \{ display:none !important; \}/.test(featureModes);
});

// 상위 개념은 rail 보다 넓어서 표에는 rail 없이 패널만 갖는 항목이 있다. 그 항목이 성립하려면
// 두 가지가 사실이어야 한다. 이름을 스스로 갖고(설정 목록이 가져올 곳이 거기뿐이다), 화면을
// 돌려주지 않는 것이다. rail 이 없으면 그 화면으로 들어갈 경로가 없어서, 로드돼도 아무도 열 수
// 없는 화면이 된다.
await checkAsync("rail 없는 기능은 이름을 갖고 화면을 갖지 않는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const src = read("web/js/core/capabilities.js");
  const bad = [];
  for (const cap of CAPABILITIES) {
    // 그 항목의 원문만 다음 id 줄 직전까지 잘라서 본다.
    const at = src.indexOf(`id: "${cap.id}"`);
    if (at < 0) { bad.push(`${cap.id}: 표에서 그 줄을 못 찾음`); continue; }
    if (cap.rail) continue;
    if (!cap.label) bad.push(`${cap.id}: rail 이 없는데 label 이 없다`);
    // 화면을 돌려주는 것은 표가 아니라 그 기능의 진입 파일이다. 표의 그 항목에서
    // "return { … screen:"을 찾던 조건은 표에 return 이 하나도 없어서(확인 결과: 0건) 참이 될
    // 수 없었다. 항상 통과하면서 아무것도 검사하지 않았다.
    const m = /import\(\s*"(\.[^"]+)"\s*\)/.exec(String(cap.load));
    const entry = m ? ("web/js/core/" + m[1]).replace(/[^/]+\/\.\.\//g, "") : null;
    if (!entry) { bad.push(`${cap.id}: load 가 동적 import 가 아니다`); continue; }
    const es = read(entry);
    const at2 = es.indexOf("export function initCapability");
    const body = at2 < 0 ? "" : es.slice(at2);
    if (/return \{[\s\S]*?\bscreen[:,\s}]/.test(body)) bad.push(`${cap.id}: rail 이 없는데 화면을 돌려준다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 패널만 갖는 기능을 끄면 그 패널이 사라져야 한다. 남으면 아무도 채우지 않는 안내문
// ("스페이스를 선택하면 스크립트가 열립니다")만 있는 빈 칸이 보여서 껐다는 상태가 화면과
// 일치하지 않는다. 소스에 그렇게 적혀 있는지가 아니라 실제로 사라지는지를 확인한다.
// 설정 화면은 끈 것이 화면에서 사라진다고 안내한다. 그 약속을 지키는 방법은 하나뿐이다.
// 그 기능이 자기 패널을 panel 로 밝히는 것이다. 밝히지 않으면 앱 셸은 사라지게 할 대상을 몰라서,
// 꺼도 그 버튼이 화면에 남고 눌러도 아무 일이 없다.
await checkAsync("한 기능만 쓰는 자리는 그 기능이 밝힌다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const owned = new Map();
  for (const cap of CAPABILITIES) for (const f of cap.files || []) owned.set("web/js/" + f, cap.id);
  const js = sourceFiles("web").filter((f) => f.startsWith("web/js/") && f.endsWith(".js"));
  const html = read("web/index.html");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  if (htmlIds.size < 40 || js.length < 60) cannotMeasure(`id ${htmlIds.size} · 파일 ${js.length} — 훑개가 죽었다`);
  const nude = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const idRe = /(?:\$\(\s*["'`]#([\w-]+)|getElementById\(\s*["'`]([\w-]+))/g;
  const touch = new Map();
  for (const rel of js) {
    const who = owned.get(rel) || "틀";
    for (const m of nude(rel).matchAll(idRe)) {
      const id = m[1] || m[2];
      if (!htmlIds.has(id)) continue;
      if (!touch.has(id)) touch.set(id, new Set());
      touch.get(id).add(who);
    }
  }
  if (touch.size < 30) cannotMeasure(`코드가 만지는 id 를 ${touch.size} 개만 찾았다 — 훑개가 죽었다`);
  // 면제한 기능. 메모는 패널이 열일곱이라 panel 한 칸으로 담을 수 없고, 창 마크업까지 옮겨야 한다.
  const SPARE = { memo: "이 회차의 범위 밖" };
  const bad = [];
  const seen = new Set();
  for (const [id, who] of touch) {
    if (who.has("틀") || who.size !== 1) continue;      // 틀도 만지면 틀의 자리다
    const capId = [...who][0];
    const cap = CAPABILITIES.find((c) => c.id === capId);
    if (!cap || cap.panel === id) continue;
    seen.add(capId);
    if (SPARE[capId]) continue;
    bad.push(`${capId} 만 쓰는 ${id} 를 ${capId} 이 panel 로 안 밝힌다 — 끄면 그 자리가 남는다`);
  }
  for (const capId of Object.keys(SPARE)) {
    if (!seen.has(capId)) bad.push(`${capId} 은 이미 그런 자리가 없다 — 면제 목록에서 뺀다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 파일·css·마크업을 분리해도 두 기능이 같은 이름을 쓰면 거기서 다시 만난다. 파일이 겹치지 않아서
// 드러나지 않는 채로 서로의 값을 덮어쓴다. 이름이 쓰이는 세 곳을 확인한다.
// 소유자는 보내는 쪽으로 정하고, 앱 셸도 보내는 이름은 앱 셸의 서비스이므로 제외한다.
// 터미널 입력(pty.input)처럼 여러 기능이 함께 쓰는 것이 정상인 이름이 있다.
await checkAsync("두 기능이 같은 이름을 쓰지 않는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const owned = new Map();
  for (const cap of CAPABILITIES) for (const f of cap.files || []) owned.set("web/js/" + f, cap.id);
  const js = sourceFiles("web").filter((f) => f.startsWith("web/js/") && f.endsWith(".js"));
  if (js.length < 60 || owned.size < 20) cannotMeasure(`파일 ${js.length} · 기능 소유 ${owned.size} — 훑개가 죽었다`);
  const nude = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

  // 전역은 쓰는 쪽만 세면 절반만 보는 것이다. 남이 설정한 값을 읽기만 해도 그 기능의 내부를
  // 아는 것이고, 그쪽이 이름을 바꾸면 조용히 깨진다. 그래서 전역을 읽기만 하는 곳도 함께 센다.
  // 단 읽기는 이미 누군가 쓰는 이름에만 더한다. 그러지 않으면 window.location 같은 내장
  // 속성이 전부 딸려 와 의미 없는 실패가 된다.
  const axes = [
    { 이름: "ws 메시지", re: /type:\s*"([a-z][\w.-]*)"/g, 바닥: 40 },
    { 이름: "localStorage 열쇠", re: /localStorage\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`]+)/g, 바닥: 8 },
    { 이름: "window 전역", re: /window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g, 바닥: 5,
      읽기: /window\.([A-Za-z_$][\w$]*)/g, 읽기바닥: 12 },
  ];
  // 에뮬레이터는 serve-sim 헬퍼의 소켓에 터치 프레임을 직접 보낸다. begin·move·end 는 그 프로토콜의 값이라
  // Iris 의 이름이 아니고, 바꾸면 기기에 드래그가 들어가지 않는다. 그 값을 에뮬레이터가 더 쓰지 않으면
  // 예외도 필요 없으므로 아래에서 실제로 쓰는지 확인한다.
  const FOREIGN_PROTOCOL = { "ws 메시지": { emulator: ["begin", "move", "end"] } };
  const bad = [];
  for (const ax of axes) {
    const who = new Map();
    const foreign = FOREIGN_PROTOCOL[ax.이름] || {};
    for (const rel of js) {
      const cap = owned.get(rel) || "틀";
      for (const m of nude(rel).matchAll(ax.re)) {
        if (!who.has(m[1])) who.set(m[1], new Set());
        who.get(m[1]).add(cap);
      }
    }
    for (const [cap, names] of Object.entries(foreign)) {
      for (const n of names) {
        if (!who.get(n)?.has(cap)) bad.push(`${ax.이름} 예외 "${n}" 을 ${cap} 가 더 쓰지 않는다 — 예외를 지운다`);
        else who.get(n).delete(cap);
      }
    }
    if (who.size < ax.바닥) cannotMeasure(`${ax.이름} 이름을 ${who.size} 개만 찾았다 — 훑개가 죽었다`);
    if (ax.읽기) {
      // 읽기 검색이 동작하지 않으면 이 검사는 쓰는 쪽만 보던 상태로 돌아간다. 그래서 일치
      // 횟수를 세고 하한을 둔다. 확인 결과: 26 회.
      let hits = 0;
      for (const rel of js) {
        const cap = owned.get(rel) || "틀";
        for (const m of nude(rel).matchAll(ax.읽기)) {
          if (!who.has(m[1])) continue;
          hits++;
          who.get(m[1]).add(cap);
        }
      }
      if (hits < ax.읽기바닥) cannotMeasure(`${ax.이름} 읽는 자리를 ${hits} 번만 맞혔다 — 훑개가 죽었다`);
    }
    for (const [n, s2] of who) {
      if (s2.has("틀")) continue;               // 틀이 쓰는 이름은 틀의 서비스다
      const caps = [...s2];
      if (caps.length >= 2) bad.push(`${ax.이름} "${n}" 을 ${caps.join(", ")} 가 함께 쓴다`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 기능의 마크업이 앱 셸의 index.html 에 남아 있으면, 기능 둘을 각자 고치는 두 사람이 그 한 파일
// 에서 만나고 병렬 수정이 끊긴다. 패널이 사라지는가(아래 검사)와 패널이 그 파일에 있는가는 다른
// 사실이다. 여기서는 뒤엣것을 확인한다.
await checkAsync("기능의 마크업이 틀의 index.html 에 없다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const all = sourceFiles("web").filter((f) => f.startsWith("web/css/") && f.endsWith(".css")).map((f) => f.slice("web/css/".length));
  const capCss = new Map();
  for (const cap of CAPABILITIES) for (const c of cap.css || []) capCss.set(c, cap.id);
  const frameCss = all.filter((f) => !capCss.has(f));
  if (frameCss.length < 5 || capCss.size < 5) cannotMeasure(`틀 css ${frameCss.length} · 기능 css ${capCss.size} — 훑개가 죽었다`);
  const sel = (f) => new Set([...read("web/css/" + f).matchAll(/[.#]([a-zA-Z][\w-]{2,})/g)].map((m) => m[1]));
  // 앱 셸이 아는 이름은 앱 셸의 것이다. 기능 css 가 그 위에 규칙을 얹어도 그 기능의 것이 아니다.
  // 제외하지 않으면 panel·meta·open 같은 흔한 이름이 모두 걸려 의미 없는 실패가 된다.
  const frameNames = new Set();
  for (const f of frameCss) for (const n of sel(f)) frameNames.add(n);
  const owner = new Map();
  for (const [f, cap] of capCss) {
    for (const n of sel(f)) {
      if (frameNames.has(n)) continue;
      if (!owner.has(n)) owner.set(n, new Set());
      owner.get(n).add(cap);
    }
  }
  if (owner.size < 50) cannotMeasure(`기능만 아는 이름이 ${owner.size} 개다 — 훑개가 죽었다`);
  const html = read("web/index.html");
  // 면제한 기능. 사유를 적지 않으면 면제할 수 없다. 메모는 옮기려면 메모 창의 동작을 건드려야
  // 하므로 이번 범위에서 명시적으로 제외한다. 아래에서 이 면제가 아직 유효한지 매번 확인한다.
  const SPARE = { memo: "이 회차의 범위 밖" };
  const found = new Map();
  for (const [n, caps] of owner) {
    if (caps.size !== 1) continue;
    if (!new RegExp(`(id|class)="[^"]*\\b${n}\\b`).test(html)) continue;
    const cap = [...caps][0];
    if (!found.has(cap)) found.set(cap, []);
    found.get(cap).push(n);
  }
  const bad = [];
  for (const [cap, ns] of found) {
    if (SPARE[cap]) continue;
    bad.push(`${cap} 의 마크업 ${ns.length} 개가 아직 index.html 에 있다 (${ns.slice(0, 5).join(" ")})`);
  }
  // 면제가 아직 유효한가. 다 옮겼는데 목록만 남으면 다음 사람이 그 자리를 제약으로 읽는다.
  for (const cap of Object.keys(SPARE)) {
    if (!found.has(cap)) bad.push(`${cap} 은 이미 index.html 에 없다 — 면제 목록에서 뺀다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("끈 기능의 자리는 실제로 내려간다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const panels = CAPABILITIES.filter((c) => c.panel);
  if (!panels.length) cannotMeasure("자리를 갖는 기능이 하나도 없다 — 뽑는 방식이 깨졌다");
  const html = read("web/index.html");
  for (const c of panels) {
    if (!new RegExp(`id="${c.panel}"`).test(html)) throw new Error(`${c.id}: index.html 에 ${c.panel} 이 없다`);
  }
  // 브라우저 없이 rail 을 실행한다. 켜짐 상태는 저장소가, 패널은 document 가 준다.
  // 하나만 끄고 끝내면 두 번째 기능부터는 아무것도 검사하지 않은 채 통과한다. 그래서 패널을
  // 갖는 기능마다 그것 하나만 끄고 실행해, 그것만 사라지고 나머지는 그대로인지 매번 확인한다.
  const bad = [];
  for (const off of panels) {
    const els = new Map(panels.map((c) => [c.panel, { hidden: null }]));
    const prevDoc = globalThis.document;
    globalThis.document = {
      getElementById: (id) => els.get(id) || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: { toggle() {} } },
    };
    try {
      await withFeatureState([off.id], async () => {
        const rail = await import(new URL("../../../web/js/devtool/rail.js", import.meta.url).href);
        rail.applyRailVisibility();
      });
    } finally {
      globalThis.document = prevDoc;
    }
    for (const c of panels) {
      const want = c.id === off.id;
      const got = els.get(c.panel).hidden;
      if (got !== want) bad.push(`${off.id} 를 껐을 때 ${c.id}: ${want} 여야 하는데 ${got}`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 설정 목록은 rail 표 하나만 읽었다. 상위 개념이 rail 밖으로 나가면서 목록이 그것을 놓치면
// 사용자는 그 기능을 끌 방법이 없다. 표에는 있는데 화면에는 없는 기능이 된다.
await checkAsync("표의 모든 기능이 설정 목록에 선다", async () => {
  const rows = await withFeatureState([], (features) => features.featureList());
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const ids = rows.map((r) => r.id);
  const missing = CAPABILITIES.map((c) => c.id).filter((id) => !ids.includes(id));
  if (missing.length) throw new Error("목록에 안 서는 기능: " + missing.join(", "));
  const nameless = rows.filter((r) => !r.label).map((r) => r.id);
  if (nameless.length) throw new Error("이름 없는 줄: " + nameless.join(", "));
  if (rows.length !== new Set(ids).size) throw new Error("같은 id 가 두 번 선다");
  return true;
});

// 기능을 따로 고치려면 그 파일 하나만 열어도 무엇을 소유하고 무엇을 깨면 안 되는지 알아야 한다.
// 이 저장소는 그것을 파일 머리말로 적는 규약이 있고, 규약을 문장으로만 두면 다음 사람이 빠뜨린다.
// 그래서 표가 가리키는 파일마다 그 다섯 항목이 실제로 있는지 확인한다.
await checkAsync("기능 파일은 자기 머리말을 갖는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const WANT = ["소유 범위", "제공 API", "의존 대상", "유지 조건", "영향 범위"];
  const bad = [];
  for (const cap of CAPABILITIES) {
    const m = /import\(\s*"(\.[^"]+)"\s*\)/.exec(String(cap.load));
    if (!m) { bad.push(`${cap.id}: load 에서 파일을 못 읽었다`); continue; }
    const rel = ("web/js/core/" + m[1]).replace(/[^/]+\/\.\.\//g, "");
    const head = read(rel).split("\n").slice(0, 40).join("\n");
    const miss = WANT.filter((w) => !head.includes(w));
    if (miss.length) bad.push(`${rel}: ${miss.join("·")} 없음`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});
// 병렬 수정의 실제 근거는 파일 소유다. 표가 그것을 적고, 여기서 세 방향으로 대조한다. 적은 것이
// 전부 진입 파일에서 도달하는가, 하나도 앱 셸에서 도달하지 않는가, 계산한 것과 같은가.
// 셋 중 둘만 보면 누락이 생긴다. 앱 셸이 기능의 파일 하나를 정적으로 import 하기 시작하면 그
// 파일은 앱 셸로 분류되어 소유 검사에서 사라진다. memo-window 가 그 상태여서, 메모를 꺼도 그
// 모듈만 로드됐고 진입 파일 하나만 보는 검사는 통과했다.
await checkAsync("기능이 적은 자기 파일이 실제 소유와 같다", async () => {
  const esbuild = (await import("esbuild")).default;
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const all = new Set(sourceFiles("web").filter((f) => f.endsWith(".js") && f.startsWith("web/js/")));

  // 여기서 `from "..."` 를 정규식으로 찾아 소유를 판정하면 부작용 import · 홑따옴표 ·
  // 동적 import · Worker 를 보지 못한다. 소유 판정이 우회되면 기능 파일 하나가 표에서 빠져도
  // 검사가 통과한다. 그래서 여기도 번들러가 해석한 그래프로 확인한다.
  const built = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ["web/js/main.js"],
    bundle: true, write: false, metafile: true, format: "esm", logLevel: "silent",
  });
  const inputs = built.metafile.inputs;
  if (Object.keys(inputs).length < 60) cannotMeasure(`그래프가 먹혔다: 입력 ${Object.keys(inputs).length} 파일`);
  const edges = new Map();
  for (const [f, info] of Object.entries(inputs)) {
    edges.set(f, (info.imports || []).map((i) => i.path).filter((p) => inputs[p] && !p.startsWith("node_modules/")));
  }

  // 경계는 표가 지정하는 동적 import 목적지다. 순회할 때 다른 기능의 경계를 끊지 않으면, 어느
  // 기능이든 등록표에 도달하는 순간 표의 동적 의존을 타고 모든 기능으로 번져 전부가 서로의
  // 소유로 잡힌다. 확인 결과: 끊지 않으면 15개 기능이 42개 파일을 공유로 잡고 실제 공유는 0이었다.
  const boundary = new Map();
  for (const cap of CAPABILITIES) {
    const m = /import\(\s*["']([^"']+)["']\s*\)/.exec(String(cap.load));
    if (m) boundary.set(cap.id, ("web/js/core/" + m[1]).replace(/[^/]+\/\.\.\//g, ""));
  }
  if (boundary.size < 10) cannotMeasure(`기능 경계를 ${boundary.size} 개만 읽었다 — 계측기가 죽었다`);
  const walk = (roots, cut) => {
    const seen = new Set(), stack = [...roots];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of edges.get(cur) || []) { if (!cut.has(n)) stack.push(n); }
    }
    return seen;
  };
  const allBoundaries = new Set(boundary.values());
  const shell = walk(["web/js/main.js"], allBoundaries);
  const bad = [];
  for (const cap of CAPABILITIES) {
    if (!Array.isArray(cap.files) || !cap.files.length) { bad.push(`${cap.id}: 자기 파일을 안 적었다`); continue; }
    const entry = boundary.get(cap.id);
    if (!entry) { bad.push(`${cap.id}: 입구를 못 읽었다`); continue; }
    if (!edges.has(entry)) { bad.push(`${cap.id}: ${entry} 에 닿는 길이 없다`); continue; }
    const declared = cap.files.map((f) => "web/js/" + f);
    const others = new Set([...allBoundaries].filter((b) => b !== entry));
    const computed = [...walk([entry], others)].filter((f) => !shell.has(f));
    for (const f of declared) {
      if (!all.has(f)) bad.push(`${cap.id}: ${f} 이 없다`);
      else if (shell.has(f)) bad.push(`${cap.id}: ${f} 을 틀이 끌어온다`);
    }
    const missing = computed.filter((f) => !declared.includes(f));
    const extra = declared.filter((f) => !computed.includes(f) && all.has(f) && !shell.has(f));
    if (missing.length) bad.push(`${cap.id}: 안 적은 자기 파일 ${missing.join(", ")}`);
    if (extra.length) bad.push(`${cap.id}: 입구에서 안 닿는데 적혀 있음 ${extra.join(", ")}`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 파일을 분리해도 이름을 다른 기능이 쓰면 그 기능이 함께 바뀐다. 확인 결과: 메모 관리 화면이
// 자동완성의 .af-chip·.af-head 를 쓰고 있었다(af- 이름 7종·21곳). 자동완성 칩 모양을 고치는
// 사람이 메모 화면까지 함께 바꾸고 있었던 것이다. 그래서 세 방향으로 확인한다. 표가 페이지를
// 적었는가, 그 페이지가 실제로 로드되는가, 그 페이지가 정의한 이름을 그 기능의 파일만 쓰는가.
// 여러 화면이 함께 쓰는 바깥 요소는 앱 셸 파일이 갖는다.
await checkAsync("기능 지면의 이름을 그 기능만 쓴다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const linked = [...read("web/index.html").matchAll(/<link rel="stylesheet" href="\/css\/([^"]+)"/g)].map((m) => m[1]);
  const jsFiles = sourceFiles("web").filter((f) => f.endsWith(".js") && f.startsWith("web/js/"));
  // 다른 기능의 이름을 쓰는 곳은 JS 만이 아니다. 패널 마크업은 index.html 에 있고, 일곱 패널이
  // 계정의 .acct-head 와 깃의 .sc-ico 를, 세 패널이 자동완성의 .af-body 를 쓰고 있었다. JS 만
  // 보면 그것을 놓친다. 다만 자기 패널 안에서 자기 이름을 쓰는 것은 정상이므로(마크업은 앱 셸에
  // 두기로 했다) 두 패널 이상이 함께 쓰는 이름만 결함으로 본다.
  const asides = [...read("web/index.html").matchAll(/<aside\b[\s\S]*?<\/aside>/g)].map((m) => m[0]);
  const sharedInMarkup = (name) => asides.filter((a) => new RegExp(`["'\\s]${name}["'\\s]`).test(a)).length > 1;
  // 어느 페이지가 정의한 이름인지부터 정한다. 두 페이지에 나오는 이름(body.util-full 같은 앱 셸의
  // class)은 그 기능이 정의한 것이 아니라서 소유를 묻지 않는다.
  const classesOf = (rel) => {
    const sheet = read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    const out = new Set();
    for (const m of sheet.matchAll(/([^{}]+)\{/g)) {
      if (m[1].trim().startsWith("@")) continue;
      for (const c of m[1].matchAll(/\.([A-Za-z][A-Za-z0-9_-]{3,})/g)) out.add(c[1]);
    }
    // 이름은 class 만이 아니다. 보관함이 정의한 @keyframes ar-spin 을 브라우저 인수인계 막대가
    // 인라인 style 로 쓰고 있었고, class 만 보는 검사는 그것을 보지 못했다.
    for (const m of sheet.matchAll(/@keyframes\s+([A-Za-z][A-Za-z0-9_-]*)/g)) out.add(m[1]);
    return out;
  };
  // 이름을 정의하는 곳과 다른 기능의 이름에 의존하는 곳은 다르다. body.memo-mode .memo-window
  // 에서 정의하는 것은 memo-window 이고 memo-mode 는 앱 셸이 붙이는 class 에 의존한 것이다.
  // .memo-window .panel-head 도 정의가 아니라 앱 셸의 바깥 요소를 자기 안에서 조정한 것이다.
  // 그래서 소유자는 조상 선택자 없이 단독으로 정의한 규칙(.wvc-row { … })으로만 정한다.
  const bareNames = (rel) => {
    const sheet = read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    const out = new Set();
    for (const m of sheet.matchAll(/([^{}]+)\{/g)) {
      const sel = m[1].trim();
      if (sel.startsWith("@")) continue;
      for (const oneSel of sel.split(",")) {
        const t = oneSel.trim();
        if (!t || /[\s>+~]/.test(t)) continue;
        for (const c of t.matchAll(/\.([A-Za-z][A-Za-z0-9_-]{3,})/g)) out.add(c[1]);
      }
    }
    return out;
  };
  const allCssFiles = sourceFiles("web").filter((f) => f.startsWith("web/css/") && f.endsWith(".css"));
  const capOf = new Map();
  for (const cap of CAPABILITIES) for (const n of cap.css || []) capOf.set("web/css/" + n, cap.id);
  const capBare = new Map();
  for (const rel of allCssFiles) {
    if (!capOf.has(rel)) continue;
    for (const c of bareNames(rel)) if (/^[a-z]+-/.test(c)) capBare.set(c, capOf.get(rel));
  }
  // 두 페이지에 나오면 소유를 묻지 않는 방식은 우회가 가능했다. 다른 페이지가 이름을 한 번
  // 가져다 쓰기만 해도 수가 2가 되어 검사가 통과한다. 앱 셸 페이지가 정의한 이름을 통째로
  // 제외하는 방식에도 같은 문제가 남아 있었다.
  const shellNames = new Set();
  const bad = [];
  for (const rel of allCssFiles) {
    if (capOf.has(rel)) continue;
    for (const c of classesOf(rel)) if (!capBare.has(c)) shellNames.add(c);
    // 다른 기능의 이름을 앱 셸 페이지에 한 줄 적기만 해도 그 이름이 위 목록에 들어가 소유 검사
    // 전체가 통과했다(변이 확인: 18-browser.css 에 .wvc-row 를 넣어도 걸리지 않았다). 이제는
    // 제외하지 않고, 앱 셸이 그 이름을 단독으로 정의하는 것 자체를 막는다.
    for (const c of bareNames(rel)) {
      if (capBare.has(c)) bad.push(`${rel} 이 ${c} 를 세운다 — 그 이름의 임자는 ${capBare.get(c)}`);
    }
  }
  // 두 기능 이상의 페이지에 나오는 이름은 어느 한쪽의 것이 아니다.
  const capsOfName = new Map();
  for (const rel of allCssFiles) {
    if (!capOf.has(rel)) continue;
    for (const c of classesOf(rel)) {
      if (!capsOfName.has(c)) capsOfName.set(c, new Set());
      capsOfName.get(c).add(capOf.get(rel));
    }
  }
  const crossCap = new Set([...capsOfName].filter(([, ids]) => ids.size > 1).map(([c]) => c));
  for (const cap of CAPABILITIES) {
    if (!Array.isArray(cap.css)) { bad.push(`${cap.id}: 지면을 안 적었다`); continue; }
    // 자기 이름을 하나도 정의하지 않는 기능도 있다. 앱 셸의 바깥 요소만 쓰는 경우다(마크다운
    // 미리보기가 .md-body 를 메모와 함께 쓴다). 그때는 빈 목록을 적는다. 안 적은 것과 없다고
    // 적은 것은 다르므로 앞의 것만 결함이다. 대신 빈 목록이 사실인지 여기서 확인한다.
    // 이 기능이 만드는 접두사 이름이 어느 페이지에도 없으면 정의한 이름이 없는 것이 맞다.
    if (!cap.css.length) {
      const anywhere = new Set(allCssFiles.flatMap((r) => [...classesOf(r)]));
      for (const rel of cap.files.map((f) => "web/js/" + f)) {
        for (const m of read(rel).matchAll(/class="([^"${}]+)"/g)) {
          for (const c of m[1].trim().split(/\s+/)) {
            if (/^[a-z]+-/.test(c) && !anywhere.has(c)) bad.push(`${cap.id}: ${c} 를 만드는데 어느 지면에도 없다`);
          }
        }
      }
      continue;
    }
    const mine = new Set(cap.files.map((f) => "web/js/" + f));
    for (const name of cap.css) {
      if (!linked.includes(name)) { bad.push(`${cap.id}: ${name} 이 index.html 에 없다`); continue; }
      // 일반 단어(on·open·danger…)는 소유를 말하지 않으므로, 접두사를 갖고 앱 셸이 정의하지
      // 않은 이름만 센다.
      // 소유자는 단독으로 정의한 이름이다(위 bareNames 참조). 다른 기능의 class 아래에서 자기
      // 것을 조정하는 것(.picking-tabs .docx-editor-shell)은 정의가 아니라 의존이다. 그것까지
      // 소유로 세면 소유자가 반대로 잡혀, 뷰어 페이지가 픽 모드의 이름을 가진 것으로 잡히고
      // 정작 그 이름의 소유자인 pick.js 가 다른 기능의 이름을 쓴다고 실패한다.
      const owned = [...bareNames("web/css/" + name)].filter((c) => /^[a-z]+-/.test(c) && !shellNames.has(c));
      // 다른 기능의 페이지가 같은 이름을 정의하면 그 둘은 함께 바뀐다.
      for (const other of allCssFiles) {
        if (!capOf.has(other) || capOf.get(other) === cap.id) continue;
        // 여기서도 정의는 단독 이름이다. 다른 기능의 class 아래에서 자기 것을 조정하는 것
        // (.picking-tabs .docx-editor-shell)까지 결함으로 세면, 한 기능이 켜졌을 때 다른 기능이
        // 어떻게 보이는지를 적을 곳이 없어진다.
        const also = owned.filter((c) => bareNames(other).has(c));
        if (also.length) bad.push(`${name} 의 ${also.join(", ")} 를 ${other} 도 세운다`);
      }
      for (const rel of jsFiles) {
        if (mine.has(rel)) continue;
        // 두 표는 기능이 자기 정보를 앱 셸에 선언하는 곳이다. rail 표의 panel 이름과 capability
        // 표의 페이지·패널 이름은 그 기능의 것을 쓰는 것이 아니라 선언한다. 범위를 각
        // 기능의 페이지로 옮기자 rail 표가 acct-panel 을 쓴다고 실패했다.
        if (rel === "web/js/core/rail-items.js" || rel === "web/js/core/capabilities.js") continue;
        // 주석에서 이름을 언급하는 것은 쓰는 것이 아니다. 이 표의 머리말이 memo-window 를
        // 설명한다는 이유로 실패한 적이 있다. 코드만 확인한다.
        const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
        // 앞의 구분 기호에 . 과 : 을 넣는다. 없으면 closest(".sc-file") 같은 선택자 문자열과
        // "animation:scr-spin" 같은 인라인 style 을 놓친다.
        const stolen = owned.filter((c) => new RegExp(`["'\`\\s(.:]${c}["'\`\\s).;]`).test(src));
        if (stolen.length) bad.push(`${name} 의 ${stolen.join(", ")} 를 ${rel} 이 쓴다`);
      }
      const shared = owned.filter(sharedInMarkup);
      if (shared.length) bad.push(`${name} 의 ${shared.join(", ")} 를 패널 여럿이 함께 쓴다`);
    }
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 켜는 것은 즉시 로드할 수 있고, 끄는 것은 다음 재로딩에 반영된다.
// 껐다 다시 켜면 그 모듈은 이미 로드돼 있다. 그것을 모르고 다시 연결하면 listener 가 두 벌 붙고
// 화면·메시지 등록이 거절당한다. 그래서 두 가지를 함께 확인한다. 이미 로드한 것을 기억하는가,
// 연결을 한 곳에서만 적는가(나누어 적으면 처음 켤 때와 나중에 켤 때가 달라진다).
check("한 번 실은 기능을 다시 싣지 않는다", () => {
  const src = read("web/js/main.js").replace(/\/\/[^\n]*/g, "");
  const fn = /async function enableCapabilityNow\(id\) \{([\s\S]*?)\n\}/.exec(src);
  if (!fn) throw new Error("켜는 자리를 못 찾았다");
  if (!/bootedCapabilities\.has\(id\)/.test(fn[1])) throw new Error("이미 실은 것을 안 본다");
  const guard = fn[1].indexOf("bootedCapabilities.has(id)");
  const boot = fn[1].indexOf("bootCapabilities(");
  if (boot >= 0 && guard > boot) throw new Error("확인이 싣는 것보다 뒤에 있다");
  if (!/for \(const one of loaded\) bootedCapabilities\.add\(one\);/.test(fn[1])) {
    throw new Error("새로 실은 것을 안 기억한다");
  }
  // 연결은 한 곳에서만 적는다. 처음 부팅과 나중 켜기가 같은 인자를 쓴다.
  const uses = (src.match(/bootCapabilities\(capabilityBootArgs\(/g) || []).length;
  if (uses !== 2) throw new Error("배선 인자를 한 곳에서 안 만든다: " + uses);
  return true;
});

// 아래 셋은 한 가지를 확인한다. 어딘가에 화면 이름이 나열된 목록이 남아 있는가. 그런 목록은
// 아홉 번째 화면을 추가할 때 고쳐야 하는 줄이고, 두 사람이 각자 기능을 하나씩 추가하면 같은
// 줄에서 만난다. 셋 다 실제로 그렇게 굳어 있던 곳이다.

// 폭은 배치 규칙이 아니라 그 화면 자신의 값이다. 배치 계약 파일이 폭까지 들고 있으면 폭 하나를
// 바꾸려고 여덟 화면이 함께 쓰는 파일을 열어야 한다.
await checkAsync("화면 폭은 그 화면의 지면이 갖는다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const { RAIL_ITEMS } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  const bad = [];
  const widthIn = (rel, cls) => new RegExp(`(^|[^\\w-])\\.${cls}\\b[^{]*\\{[^}]*\\bwidth\\s*:`).test(read(rel));
  for (const f of RAIL_ITEMS) {
    if (!f.panel) continue;
    if (widthIn("web/css/03-feature-modes.css", f.panel)) bad.push(`${f.panel} 의 폭을 자리 계약 파일이 들고 있다`);
    const cap = CAPABILITIES.find((c) => c.rail === f.id);
    if (!cap) continue;                                    // rail 은 있는데 표에 없는 줄은 다른 검사가 본다
    const sheets = (cap.css || []).map((n) => "web/css/" + n);
    if (!sheets.some((rel) => widthIn(rel, f.panel))) bad.push(`${f.panel} 의 폭을 ${cap.id} 의 지면이 안 갖는다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 폭 조절 막대가 화면 이름을 여덟 중 다섯만 담은 채로 세고 있었다. 확인 결과: 화면 동작은
// 달라지지 않는다(빠진 셋은 전체형이라 조절할 것이 없다). 막으려는 것은 패널형 화면이 하나 더
// 추가될 때 아무 경고 없이 그 목록 밖으로 떨어지는 것이다. 지금은 배치 엔진이 도구 화면을 잡는다.
check("폭 조절 막대는 화면을 세지 않는다", () => {
  const src = read("web/js/core/layout-engine.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const named = (src.match(/\b(?!rail-)[a-z]+-panel\b/g) || []);
  if (named.length) throw new Error("배치 엔진이 화면 이름을 센다");
  if (!/const openTool = \(\) => document\.querySelector\("\.rail-panel\.is-open"\);/.test(src)) throw new Error("열린 rail-panel 로 안 잡는다");
  return true;
});

// 프리셋에 포함되는지는 포함되는 쪽이 밝힌다. 프리셋 쪽에 id 목록을 두면 두 사람이 각자 기능을
// 하나씩 추가할 때 같은 줄에서 만난다.
// 가운데 탭이 확장자를 직접 알면, 새 뷰어(그림·PDF 등)를 추가할 때 파일 라우팅·탭 만들기·
// 탭 닫기·텍스트 편집기를 함께 열어야 한다. 두 사람이 각자 뷰어를 하나씩 추가할 때 같은 네
// 파일에서 만난다는 뜻이다. 그래서 앱 셸에는 확장자가 없어야 하고, 등록표에 묻는 코드만 있어야 한다.
await checkAsync("가운데 탭은 확장자를 모른다", async () => {
  const { CAPABILITIES: CAPS_EXT } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const owned = new Set(CAPS_EXT.flatMap((c) => c.files.map((f) => "web/js/" + f)));
  // 네 파일만 이름으로 적으면 그 목록 밖에서 새는 것을 보지 못한다. 그래서 앱 셸 전부를
  // 확인한다(기능 파일은 제외한다. 확장자는 그것을 맡는 기능의 것이다).
  const shell = sourceFiles("web").filter((f) => f.endsWith(".js") && !owned.has(f));
  // 등록표에 묻는 의무는 경로를 정하는 네 파일만 진다. 나머지 앱 셸은 물을 일이 없다.
  const ASKS = ["web/js/center/file-routing.js", "web/js/center/tabs.js",
    "web/js/center/tab-close.js", "web/js/center/text-editor.js"];
  const bad = [];
  // 뷰어가 맡는 확장자. 앱 셸에 이 문자열이 있으면 그 지식이 아직 앱 셸에 있다는 뜻이다.
  const OWNED = /\.\(?\s*(?:xlsx|xlsm|docx|csv|tsv)\b/;
  if (shell.length < 20) bad.push(`틀을 ${shell.length} 개만 셌다 — 거르개가 말뭉치를 먹었다`);
  for (const rel of shell) {
    // 주석은 설명이므로 제외한다. 이 검사의 머리말이 자기 자신에 걸려서는 안 된다.
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    if (OWNED.test(src)) bad.push(`${rel} 이 확장자를 안다`);
    if (/\b(?:DOCX_RE|SHEET_RE|SHEET_TEXT_RE)\b/.test(src)) bad.push(`${rel} 이 옛 형식 정규식을 쓴다`);
  }
  for (const rel of ASKS) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    if (!/fileKindOf\s*\(/.test(src)) bad.push(`${rel} 이 등록표에 묻지 않는다`);
  }
  // 묻기만 하고 아무도 안 적으면 표·문서가 통째로 글자 파일이 된다. 실제로 불러서 센다.
  const { clearFileKinds, fileKindOf, fileKindIds } = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  clearFileKinds();
  registerViewerKinds();
  const got = (path, tab) => { const k = fileKindOf(path, tab); return k ? k.id : null; };
  const want = [["a.docx", "docx"], ["b.xlsx", "sheet"], ["c.csv", "sheet"], ["d.txt", null], ["e.png", null]];
  for (const [path, id] of want) if (got(path) !== id) bad.push(`${path} → ${got(path)} (${id} 여야 한다)`);
  // 탭이 이미 문서라고 밝히면 경로 판정보다 그 값이 우선한다.
  if (got("c.csv", { docxMode: true }) !== "docx") bad.push("탭의 docxMode 가 길보다 앞서지 않는다");
  if (fileKindIds().join(",") !== "docx,sheet") bad.push("등록 순서가 docx → sheet 가 아니다");
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("묶음에 드는 것은 기능이 스스로 밝힌다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const feat = read("web/js/core/features.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const ids = CAPABILITIES.map((c) => c.id);
  const table = /const PRESET_ON = \{([\s\S]*?)\n\};/.exec(feat);
  if (!table) throw new Error("묶음 표를 못 찾았다");
  const listed = ids.filter((id) => new RegExp(`["']${id}["']`).test(table[1]));
  if (listed.length) throw new Error("묶음 표가 기능 이름을 센다: " + listed.join(", "));
  const { PRESETS, presetPlan } = await import(new URL("../../../web/js/core/features.js", import.meta.url).href);
  const { lockedIds } = await import(new URL("../../../web/js/core/rail-items.js", import.meta.url).href);
  if (!PRESETS.some((p) => p.id === "dev")) throw new Error("dev 묶음이 없다");
  // 실제로 호출해 본다. 표 모양만 보면 파생이 빈 목록을 내도 통과한다.
  const locked = new Set(lockedIds());
  const declared = CAPABILITIES.filter((c) => (c.presets || []).includes("dev"))
    .map((c) => c.id).filter((id) => !locked.has(id)).sort();
  if (!declared.length) throw new Error("dev 를 밝힌 기능이 하나도 없다");
  const plan = presetPlan("dev");
  if (!plan) throw new Error("dev 묶음을 못 편다");
  const got = [...plan.on].sort().join(",");
  if (got !== declared.join(",")) throw new Error(`밝힌 것과 켜지는 것이 다르다: ${got} vs ${declared.join(",")}`);
  return true;
});
// 채팅 복붙(가짜 줄바꿈 없는 복사·화면 밖 드래그·자동 복사·파일 드롭 경로 삽입)은 사용자가
// 이름으로 지정한 상위 개념이다. 그런데 그 전부가 xterm 연결과 한 파일에 섞여 있었고,
// terminal.js 가 정리 함수를 그 파일에서 등록받아 들고 있어서 끌 수도, 따로 고칠 수도 없었다.
// 여기서 두 방향을 검사로 강제한다. 앱 셸에 그 지식이 없는가, 각 지점에 훅으로만 연결되는가.
await checkAsync("채팅 복붙을 틀이 모른다", async () => {
  const { CAPABILITIES: CAPS_CC } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const ownedCC = new Set(CAPS_CC.flatMap((c) => c.files.map((f) => "web/js/" + f)));
  // 목록에 없는 파일로 빠져나가면 검사가 보지 못하므로 앱 셸 전부를 확인한다.
  const shell = sourceFiles("web").filter((f) => f.endsWith(".js") && !ownedCC.has(f));
  // 이 이름들은 소스에서 파생할 수 없다. 기능의 내부 이름이라 export 도 아니고, 최상위 선언을
  // 모두 뽑으면 주입받는 이름(showToast·esc·wsSend 등)까지 걸려 잡음이 된다. 그래서 손으로
  // 적고, 반대 방향으로 오래되는 것을 아래에서 막는다. 그 이름이 기능에서 사라지면 그 줄은
  // 아무것도 검사하지 않게 되는데, registerTerminalCopyFormatters 가 실제로 그 상태였다.
  const banned = [
    "edgeDrag", "edgeScroll", "edgeCell", "edgeStart", "edgeFinish", "edgeGuardUntil",
    "rowsToText", "copyIndentWidth", "stripCopyIndent", "cropAwareSelection",
    "drag-hot", "fileDragHotNext", "getDroppedPath",
  ];
  const bad = [];
  const capSrc = (CAPS_CC.find((c) => c.id === "chatcopy").files || []).map((f) => read("web/js/" + f)).join("\n");
  if (!capSrc.length) bad.push("채팅 복붙 뭉치의 소스를 못 읽었다");
  for (const word of banned) {
    // 부분 문자열로 판정하면 이름이 길어지는 것을 잡지 못한다. 확인 결과: cropAwareSelection 을
    // cropAwareSelectionX 로 바꾼 변이가 통과했다.
    if (!new RegExp(`\\b${word}\\b`).test(capSrc)) bad.push(`${word} 은 이 뭉치에 이미 없다 — 이 줄은 아무것도 안 재고 있다`);
  }
  if (shell.length < 20) bad.push(`틀을 ${shell.length} 개만 셌다 — 거르개가 말뭉치를 먹었다`);
  for (const rel of shell) {
    const src = read(rel);
    for (const word of banned) {
      if (word === "getDroppedPath" && rel === "web/js/center/file-drop.js") continue;
      if (src.includes(word)) bad.push(`${rel} 이 ${word} 을 안다`);
    }
  }
  // 앱 셸이 그 기능의 파일을 정적으로 import 하면 위 이름이 없어도 항상 로드된다.
  for (const rel of shell) {
    if (/from\s+"[^"]*chatcopy\//.test(read(rel))) bad.push(`${rel} 이 chatcopy 를 정적으로 끌어온다`);
  }
  // 각 지점에 훅이 있는가. 하나라도 빠지면 그 조작만 동작을 멈춘다.
  const wiring = read("web/js/panel/xterm-wiring.js"), mainSrc = read("web/js/main.js");
  const seams = {
    "chatcopy.wheel": wiring, "chatcopy.dragStart": wiring, "chatcopy.dragMove": wiring,
    "chatcopy.dragEnd": wiring, "chatcopy.selectionChanged": wiring,
    "chatcopy.dragHint": wiring, "chatcopy.dropFiles": wiring,
    "chatcopy.captureAfterWrite": mainSrc,
  };
  const boot = read("web/js/chatcopy/boot.js");
  for (const [name, src] of Object.entries(seams)) {
    if (!src.includes(`callHook("${name}"`)) bad.push(`${name}: 부르는 자리가 없다`);
    if (!boot.includes(`provide("${name}"`)) bad.push(`${name}: 채우는 자리가 없다`);
  }
  // 기능을 꺼도 파일을 놓아 창이 이동하는 것은 앱 셸이 막는다.
  if (!/if \(!hasFiles\(e\.dataTransfer\)\) return;\n\s*e\.preventDefault\(\);/.test(wiring)) {
    bad.push("기능을 꺼도 막아야 할 창 이동 차단이 틀에 없다");
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 앱 셸이 종류 이름을 나열하고 있었다. showActiveTab 과 도킹 렌더가 각각 docx 와 diff 에 쓸
// 페이지를 적었고, main 이 파일처럼 다루는 종류를 따로 세었다. 그래서 페이지 하나를 추가하려면
// 앱 셸 세 파일을 함께 열어야 했다. 이제 추가하는 쪽이 표에 한 줄을 적는다.
// 페이지 이름만 옮기는 것으로는 부족하다. 어느 필드가 비어 있으면 아직 받지 못한 것인가도 앱 셸이
// 알고 있었다(docxData·sheetError). 새 뷰어마다 그 코드를 함께 고쳐야 했으므로 그것도 확인한다.
// 앱 셸이 다른 기능의 종류 이름·필드 이름을 아는가. 확인할 파일도 금지어도 손으로 적지 않는다.
// 손으로 적은 목록은 그 밖을 보지 못해서, 목록에 없는 파일 하나가 규칙을 전부 비껴간다.
// 확인할 파일은 등록표가 아무 기능에도 배정하지 않은 렌더러 파일로 파생하고, 금지어는 등록된
// 종류 이름과 그 뷰어가 소유한 탭 필드 이름으로 파생한다.
//
// 필드 이름의 출처가 둘인 이유. 처음에는 tabFields 선언만 봤다. 그 선언은 새 파일 탭이 생성될 때
// 갖는 필드라는 다른 계약이라(center/tabs.js makeFileTab), 나중에 만들어지는 필드는 적히지 않는
// 것이 옳다. 그래서 뷰어가 실제로 쓰는 필드 57 중 13 만 선언에 있었고, 나머지 44(_sv* 전부
// 포함)는 앱 셸이 수정해도 이 검사가 잡지 못했다. browser/dock.js 가 실제로 _svEd 를 그렇게
// 수정하고 있었다. 이제 선언과 파생을 합쳐서 본다. 선언된 필드 ∪ 그 기능의 파일만 값을 넣는
// 필드다. 소유자를 정할 때 앱 셸이 쓰는지는 보지 않는다. 보면 이미 새고 있는 필드가 둘 다
// 쓰는 것이 되어 그 누락이 스스로를 가린다.
await checkAsync("가운데 지면을 틀이 세지 않는다", async () => {
  const bad = [];
  const { CAPABILITIES: CAPS } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const owned = new Set();
  for (const cap of CAPS) for (const f of cap.files || []) owned.add("web/js/" + f);
  const shell = sourceFiles("web").filter((f) => f.startsWith("web/js/") && f.endsWith(".js") && !owned.has(f));
  if (shell.length < 30 || owned.size < 20) throw new Error(`파생이 말뭉치를 먹었다: 틀 ${shell.length} · 기능 ${owned.size}`);
  const fkm = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  fkm.clearFileKinds();
  registerViewerKinds();
  const kinds = new Set(fkm.fileKinds().map((spec) => spec.id));
  const fields = new Set();
  for (const spec of fkm.fileKinds()) {
    // 선언이 이 검사의 기준이다. 뷰어가 자기 선언을 비우면 그 필드들이 파생에서 빠져 앱 셸이
    // 수정해도 걸리지 않는다. 그래서 종류마다 한 필드라도 선언하는지를 함께 확인한다.
    const own = typeof spec.tabFields === "function" ? Object.keys(spec.tabFields()) : [];
    if (!own.length) throw new Error(`${spec.id} 이 자기 탭 칸을 하나도 선언하지 않는다`);
    for (const k of own) fields.add(k);
  }
  for (const f of owned) {
    for (const m of read(f).matchAll(/registerTabView\(\{\s*kind:\s*"([^"]+)"/g)) kinds.add(m[1]);
  }
  // 선언에 없는 필드는 그 기능의 파일에서 파생한다. 받는 쪽 이름을 탭으로 한정한다. 그러지
  // 않으면 다른 객체의 흔한 이름(root·rel)까지 딸려 와 소유자가 반대로 잡힌다.
  const RECV = "(?:t|tab|target|current|activeTab|tabRef)";
  const WRITE = new RegExp(`\\b${RECV}\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, "g");
  const nude = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  // 앱 셸의 필드. 생성 시점에 만드는 것(makeFileTab)과, 앱 셸이 규약으로 정해 두고 누구나 같은
  // 뜻으로 쓰는 것이다. 기능이 그 위에 값을 넣어도 소유자가 아니다. _saveInFlight 는 앱 셸의
  // 텍스트 편집기가 만들고 닫기 스냅숏이 종류를 가리지 않고 담는 필드라(center/tab-close.js) 앱 셸의 것이다.
  const BORN = new Set(["id", "kind", "label", "path", "content", "hasDiskSnapshot", "_saveInFlight"]);
  const writers = new Map();
  for (const cap of CAPS) {
    for (const f of cap.files || []) {
      for (const m of nude("web/js/" + f).matchAll(WRITE)) {
        if (!writers.has(m[1])) writers.set(m[1], new Set());
        writers.get(m[1]).add(cap.id);
      }
    }
  }
  let derived = 0;
  for (const [name, who] of writers) {
    if (who.size !== 1 || BORN.has(name) || fields.has(name)) continue;
    fields.add(name); derived++;
  }
  // 파생이 통째로 죽으면 이 검사는 선언된 13 칸만 보던 예전으로 조용히 돌아간다.
  if (derived < 20) cannotMeasure(`칸 파생이 ${derived} 개다 — 훑개가 죽었다`);
  if (kinds.size < 2 || fields.size < 8) throw new Error(`파생이 말뭉치를 먹었다: 종류 ${kinds.size} · 칸 ${fields.size}`);
  // 면제할 필드는 사유를 적고 여기 등록한다. 적지 않으면 막힌다. 현재 면제는 없다. 마지막
  // 하나(tab-close 의 sheetMode·sheet)는 그 함수를 통째로 그 기능으로 옮겨 없어졌다.
  // 아래에서 그 사유가 아직 유효한지 매번 확인한다.
  const KEEP = {};
  for (const rel of shell) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    const spared = KEEP[rel] || [];
    for (const kind of kinds) if (src.includes(`"${kind}"`)) bad.push(`${rel} 이 종류 이름 "${kind}" 을 안다`);
    for (const field of fields) {
      if (spared.includes(field)) continue;
      // 찾을 때도 받는 쪽을 탭으로 한정한다. 그러지 않으면 다른 객체의 흔한 이름이 걸려
      // 소유자가 반대로 잡힌다. file-palette 의 지역 변수 root 가 그렇게 잡혔다.
      if (new RegExp(`\\b${RECV}\\.${field.replace("$", "\\$")}\\b`).test(src)) bad.push(`${rel} 이 남의 칸 ${field} 을 만진다`);
    }
    if (/from\s+"[^"]*devtool\/diff\.js"/.test(src)) bad.push(`${rel} 이 diff 를 정적으로 끌어온다`);
  }
  // 면제한 곳이 그 이름을 아직 쓰는가. 다 고쳤는데 목록만 남으면 다음 사람이 그 자리를
  // 여전히 제약으로 읽는다.
  for (const [rel, names] of Object.entries(KEEP)) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    for (const n of names) {
      if (!fields.has(n)) bad.push(`${n} 은 아무 뷰어도 선언하지 않는다 — 봐 주는 것이 아니라 안 보는 것이다`);
      else if (!new RegExp(`\\b${RECV}\\.${n.replace("$", "\\$")}\\b`).test(src)) bad.push(`${rel} 은 ${n} 을 이미 안 쓴다 — 봐 주기 목록에서 뺀다`);
    }
  }
  // 표가 실제로 응답하는가. 모양만 보면 아무도 등록하지 않아도 통과한다.
  const tv = await import(new URL("../../../web/js/core/tab-views.js", import.meta.url).href);
  tv.clearTabViews();
  const drew = [];
  if (!tv.registerTabView({ kind: "k1", panelId: "p1", fileLike: true, render: (t) => drew.push(t) })) bad.push("등록이 안 된다");
  tv.registerTabView({ kind: "k2", panelId: "p2" });
  if (tv.registerTabView({ kind: "k1", panelId: "px" })) bad.push("같은 종류를 두 번 받아 준다");
  if (tv.tabViewKinds().join(",") !== "k1,k2") bad.push("등록 순서가 안 지켜진다: " + tv.tabViewKinds().join(","));
  if (tv.tabViewOf("k2").panelId !== "p2") bad.push("지면 이름을 못 돌려준다");
  if (tv.tabViewOf("없는것") !== null) bad.push("없는 종류에 null 이 아니다");
  if (!tv.isFileLikeTabKind("k1") || tv.isFileLikeTabKind("k2")) bad.push("파일처럼 다루는가를 표가 안 가른다");
  tv.tabViewOf("k1").render("탭");
  if (drew.join() !== "탭") bad.push("그리는 함수를 표가 안 들고 있다");
  tv.clearTabViews();
  if (tv.tabViewKinds().length) bad.push("비우기가 안 된다");
  // 실제로 등록하는 쪽이 있는가. 표만 있고 아무도 적지 않으면 페이지가 통째로 사라진다.
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const declared = [];
  for (const cap of CAPABILITIES) {
    for (const f of cap.files) {
      for (const m of read("web/js/" + f).matchAll(/registerTabView\(\{\s*kind:\s*"([^"]+)",\s*panelId:\s*"([^"]+)"/g)) {
        declared.push({ cap: cap.id, kind: m[1], panelId: m[2] });
      }
    }
  }
  for (const want of [["viewer", "docx", "docxview"], ["sourcecontrol", "diff", "diffview"]]) {
    const hit = declared.find((d) => d.kind === want[1]);
    if (!hit) bad.push(`${want[1]}: 아무도 적지 않는다`);
    else if (hit.cap !== want[0] || hit.panelId !== want[2]) bad.push(`${want[1]}: ${hit.cap}/${hit.panelId} 이 적는다`);
  }
  // 지목 안내의 라벨도 그 뷰어의 것이다. 예전에는 여기 "스프레드시트"가 박혀 있었다.
  const pick = read("web/js/browser/pick-host.js");
  if (!/docLabel/.test(pick)) bad.push("지목 안내가 라벨을 표에 안 묻는다");
  if (/스프레드시트/.test(pick)) bad.push("지목 안내에 뷰어 이름이 박혀 있다");
  // 그 페이지가 실제로 생성되는가. 없는 요소를 만들면 아무 일도 일어나지 않는다. 생성 경로는
  // 둘이다. index.html 이 갖고 있거나(앱 셸 자신의 페이지: fileview·docxview), 앱 셸이 등록표를
  // 보고 #center-body 안에 만들거나(기능이 제공하는 페이지: diffview).
  const html = read("web/index.html");
  const tabsSrc = read("web/js/center/tabs.js");
  // 만드는 코드가 실제로 있는가. 없으면 아래 면제가 그대로 우회로가 된다.
  const builds = /export function ensureTabViewPane\(view\)[\s\S]{0,600}?createElement\("div"\)[\s\S]{0,300}?getElementById\("center-body"\)|export function ensureTabViewPane\(view\)[\s\S]{0,600}?getElementById\("center-body"\)[\s\S]{0,300}?createElement\("div"\)/.test(tabsSrc);
  if (!builds) bad.push("틀이 등록표에서 가운데 지면을 만드는 자리가 없다");
  // 만들 수 있는 것과 실제로 생성되는 것은 다르다. 그리는 곳이 showActiveTab 하나뿐이면 부팅
  // 순서에 의존하게 된다. 그때 등록표가 아직 비어 있으면 아무 요소도 생기지 않고, 그 뒤 서버
  // 응답으로 바로 그리는 경로(devtool/diff.js 의 git 응답)는 showActiveTab 을 거치지 않아 없는
  // 요소에 그린다. 확인 결과: 상태가 빈 새 인스턴스에서 diffview 가 통째로 없었다. 그래서 기능을
  // 로드한 직후 한 번에 생성하는 코드를 요구하고, 로드하는 곳마다 그것을 부르는지 확인한다.
  if (!/export function ensureTabViewPanes\(\)[\s\S]{0,200}?for \(const view of tabViews\(\)\) ensureTabViewPane\(view\)/.test(tabsSrc)) {
    bad.push("실린 직후 지면을 한 번에 세우는 자리가 없다");
  }
  const mainSrc = read("web/js/main.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const bootSites = [...mainSrc.matchAll(/await bootCapabilities\(/g)];
  if (bootSites.length < 2) cannotMeasure(`기능을 싣는 자리를 ${bootSites.length} 개만 찾았다 — 훑개가 죽었다`);
  for (const m of bootSites) {
    if (!/ensureTabViewPanes\(\)/.test(mainSrc.slice(m.index, m.index + 320))) {
      bad.push(`main.js:${mainSrc.slice(0, m.index).split("\n").length} 이 기능을 싣고 지면을 안 세운다`);
    }
  }
  for (const d of declared) {
    if (new RegExp(`id="${d.panelId}"`).test(html)) continue;
    if (builds) continue;
    bad.push(`${d.panelId} 이 index.html 에도 없고 표에서 만들어지지도 않는다`);
  }
  // 요소를 찾기만 하고 없으면 포기하는 형태가 남아 있으면 옮긴 페이지는 표시되지 않는다.
  for (const rel of ["web/js/center/tabs.js", "web/js/browser/dock.js"]) {
    if (/\$\("#" \+ view\.panelId\)/.test(read(rel))) bad.push(`${rel} 이 아직 자리를 찾기만 한다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 아직 내용을 받지 못한 탭을 다시 묻는 곳은 둘이다(탭을 켤 때·재연결 뒤). 두 곳이 각자 필드
// 이름을 세면 한쪽만 고쳐지므로, 판정은 한 곳에서 나오게 하고 실제로 호출해 확인한다.
await checkAsync("아직 못 받은 탭인지를 그 뷰어가 답한다", async () => {
  const fk = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  fk.clearFileKinds();
  registerViewerKinds();
  const bad = [];
  const TABLE = [
    ["글자 파일이 비었다", "a.txt", { content: null }, true],
    ["글자 파일이 왔다", "a.txt", { content: "x" }, false],
    ["문서가 비었다", "b.docx", { docxMode: true, docxData: null, docxError: null }, true],
    ["문서가 왔다", "b.docx", { docxMode: true, docxData: {}, docxError: null }, false],
    ["문서가 오류로 끝났다", "b.docx", { docxMode: true, docxData: null, docxError: "x" }, false],
    ["표가 비었다", "c.xlsx", { sheetMode: true, sheet: null, sheetError: null }, true],
    ["표가 왔다", "c.xlsx", { sheetMode: true, sheet: {}, sheetError: null }, false],
    ["표를 글자로 보는 중이고 글자가 비었다", "d.csv", { sheetMode: false, content: null, sheet: {} }, true],
    ["표를 글자로 보는 중이고 글자가 왔다", "d.csv", { sheetMode: false, content: "a,b" }, false],
  ];
  for (const [name, path, tab, want] of TABLE) {
    const got = fk.tabNeedsContent(path, tab);
    if (got !== want) bad.push(`${name}: ${got} (기대 ${want})`);
  }
  // 아무도 맡지 않으면 텍스트 파일 규칙으로 처리된다. 뷰어를 꺼도 탭이 비지 않는다.
  fk.clearFileKinds();
  if (fk.tabNeedsContent("c.xlsx", { content: null }) !== true) bad.push("아무도 안 맡을 때 글자 규칙으로 안 떨어진다");
  fk.clearFileKinds();
  registerViewerKinds();
  // 앱 셸이 두 곳에서 각자 판정하지 않는지 확인한다.
  const tabs = read("web/js/center/tabs.js").replace(/^\s*\/\/[^\n]*$/gm, "");
  const asks = (tabs.match(/tabNeedsContent\(/g) || []).length;
  if (asks !== 2) throw new Error(`묻는 자리가 ${asks}곳 — 탭을 켤 때와 재연결 뒤 둘이어야 한다`);
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 브라우저 상태에 저장되는 문서 탭이 무엇인지를 앱 셸의 다섯 곳이 각자 판정하고 있었다
// (docx 이거나 sheet 이면). 아이콘과 라벨도 그 코드에 들어 있었다. 새 뷰어를 하나 추가하면 그
// 다섯을 함께 열어야 한다는 뜻이라, 표에 묻는 방식으로 바꿨다. 실제로 호출해 확인한다.
await checkAsync("문서 탭이 무엇인지도 그 뷰어가 답한다", async () => {
  const fk = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  fk.clearFileKinds();
  const bad = [];
  // 아무도 맡지 않으면 문서 탭은 하나도 없다. 뷰어를 끈 상태다.
  if (fk.isFileKindId("docx") || fk.isFileKindId("sheet")) bad.push("등록 전인데 문서 탭이 있다고 한다");
  if (fk.fileKindById("docx")) bad.push("등록 전인데 종류를 돌려준다");
  registerViewerKinds();
  if (!fk.isFileKindId("docx") || !fk.isFileKindId("sheet")) bad.push("등록했는데 문서 탭이 아니라고 한다");
  if (fk.isFileKindId("browser") || fk.isFileKindId("file")) bad.push("틀의 종류를 문서 탭이라고 한다");
  const icons = fk.fileKindIds().map((id) => fk.fileKindById(id).docIcon);
  if (icons.some((i) => !i) || new Set(icons).size !== icons.length) bad.push("그림글자가 없거나 겹친다: " + icons.join(","));
  const labels = fk.fileKindIds().map((id) => fk.fileKindById(id).docLabel);
  if (labels.some((l) => !l)) bad.push("이름표가 없다: " + labels.join(","));
  // 필드는 등록된 전부를 모든 파일 탭이 함께 갖는다. 닫기 확인이 필드의 유무로 갈리면 안 된다.
  const fields = {};
  for (const spec of fk.fileKinds()) Object.assign(fields, spec.tabFields ? spec.tabFields() : {});
  for (const want of ["sheetMode", "sheet", "docxMode", "docxData", "docxError", "docxGeneration"]) {
    if (!(want in fields)) bad.push(`${want} 칸을 아무도 안 적는다`);
  }
  if (fields.sheetMode !== false || fields.docxMode !== false) bad.push("기본값이 켜져 있다 — 새 탭이 표·문서로 태어난다");
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// 이 앱은 창이 셋이다. 본 창·분리 브라우저 창·메모 창. 그런데 부팅이 브라우저 창이면 아무것도
// 로드하지 않는다는 규칙과 메모 창이고 id 가 memo 면 껐어도 로드한다는 규칙을 앱 셸에 적고
// 있었다. 그래서 분리 창에서도 동작해야 하는 기능(로그인 벽은 그 창에서 더 자주 만난다)을 옮길
// 방법이 없었고, 창을 추가할 때마다 앱 셸을 열어야 했다. 이제 동작할 창도 그 기능이 표에 적는다.
await checkAsync("기능이 사는 창을 표가 밝힌다", async () => {
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const mainSrc = read("web/js/main.js").replace(/^\s*\/\/[^\n]*$/gm, "");
  const bad = [];
  // 앱 셸이 창 이름과 기능 이름을 함께 판정하던 두 곳.
  if (/MEMO_MODE && id === "memo"/.test(mainSrc)) bad.push("메모 창의 예외를 틀이 적고 있다");
  if (/if \(!BROWSER_MODE\) \{\s*\n\s*for \(const id of await bootCapabilities/.test(mainSrc)) {
    bad.push("분리 브라우저 창을 틀이 통째로 막고 있다");
  }
  if (!/CAPABILITIES\.filter\(livesHere\)/.test(mainSrc)) bad.push("부팅이 표의 창 목록을 안 본다");
  // 값이 알려진 창 이름인가. 오타는 그 창에서 로드되지 않는 것으로만 나타난다.
  const KNOWN = new Set(["main", "browser", "memo"]);
  for (const cap of CAPABILITIES) {
    for (const w of (cap.windows || [])) if (!KNOWN.has(w)) bad.push(`${cap.id}: 모르는 창 ${w}`);
    for (const w of (cap.alwaysIn || [])) {
      if (!KNOWN.has(w)) bad.push(`${cap.id}: 모르는 창 ${w}`);
      // 안 사는 창에서 "껐어도 싣는다"는 성립하지 않는다.
      if (!(cap.windows || ["main"]).includes(w)) bad.push(`${cap.id}: ${w} 에 안 사는데 거기서 늘 싣는다고 한다`);
    }
  }
  // 실제로 그렇게 갈리는가. 표는 그대로 두고 판정만 호출한다.
  const livesHere = (cap, mode) => (cap.windows || ["main"]).includes(mode);
  const idsIn = (mode) => CAPABILITIES.filter((c) => livesHere(c, mode)).map((c) => c.id);
  if (!idsIn("main").includes("memo")) bad.push("본 창에 메모가 없다");
  if (idsIn("memo").sort().join(",") !== "mdformat,memo") bad.push("메모 창의 메모·서식 구성이 다르다: " + idsIn("memo").join(","));
  if (!idsIn("browser").includes("chromehandoff")) bad.push("분리 브라우저 창에 넘기기가 없다");
  if (idsIn("browser").includes("memo")) bad.push("분리 브라우저 창에 메모가 선다");
  // 껐어도 로드하는 경우. 그 창이 곧 그 기능인 경우만이다.
  const alwaysOn = (id, mode) => {
    const cap = CAPABILITIES.find((c) => c.id === id);
    return !!(cap && (cap.alwaysIn || []).includes(mode));
  };
  if (!alwaysOn("memo", "memo")) bad.push("메모 창에서 메모가 껐으면 안 실린다");
  if (alwaysOn("memo", "main")) bad.push("본 창에서도 메모를 끌 수 없다");
  if (alwaysOn("mdformat", "memo")) bad.push("메모 창에서 서식 도구를 끌 수 없다");
  if (alwaysOn("chromehandoff", "browser")) bad.push("넘기기를 분리 창에서 끌 수 없다");
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

// ── 네이티브 쪽 기능 경계 ─────────────────────────────────────────────────────
//
// 렌더러는 표의 load 가 동적 import 라 경계가 있어서, 어느 파일이 어느 기능의 것인지를 그래프가
// 정한다. 네이티브는 main.cjs 가 전부 최상위에서 require 해서 경계가 없었다. 경계가 없으면
// 소유를 코드에서 뽑을 수 없고, 뽑을 수 없으면 표의 내용을 대조할 대상이 없다.
// native/electron/capabilities.cjs 가 그 경계를 만든다.
//
// 셋을 확인한다. 하나만 빠져도 경계는 선언에만 남는다.
console.log("[2r-n] 네이티브 기능 경계");

const nativeCaps = async () => {
  const mod = await import(new URL("../../../native/electron/capabilities.cjs", import.meta.url).href);
  const table = (mod.default && mod.default.NATIVE_CAPABILITIES) || mod.NATIVE_CAPABILITIES;
  return Array.isArray(table) ? table : [];
};
const relOf = (p) => String(p || "").replace(ROOT + "/", "");

await checkAsync("네이티브 표의 기능은 자기 배선을 들고 온다", async () => {
  const table = await nativeCaps();
  if (!table.length) cannotMeasure("네이티브 표가 비었다");
  const bad = [];
  for (const cap of table) {
    const rel = relOf(cap.module);
    if (!rel.startsWith("native/")) { bad.push(`${cap.id}: module 이 저장소 경로가 아니다`); continue; }
    // 앱 셸이 팩토리를 부르고 IPC 를 연결하던 코드를 기능이 가져간다. 가져오지 않으면 그 연결은
    // 앱 셸에 남아 있다는 뜻이고, 기능을 빼도 앱 셸을 함께 고쳐야 한다.
    if (!/\binitCapability\b/.test(read(rel))) bad.push(`${cap.id}: ${rel} 에 initCapability 가 없다`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("네이티브 기능은 표를 통해서만 실린다", async () => {
  const table = await nativeCaps();
  const { buildGraph } = await import(new URL("../../graph.mjs", import.meta.url).href);
  const g = buildGraph();
  const boundaries = new Map(table.map((c) => [c.id, relOf(c.module)]));
  if (!boundaries.size) cannotMeasure("네이티브 경계가 없다");

  // 무엇을 끊고 순회하느냐가 이 검사의 핵심이다. 경계를 끊고 순회하면 앱 셸이 그 모듈을 직접
  // require 해도 순회가 그 지점을 건너뛰어 영영 잡히지 않는다. 변이로 확인했다. main.cjs 에
  // 최상위 require 를 다시 넣었는데 통과했다. 잡으려는 것을 보지 못하게 만드는 방식이었다.
  // 끊어야 하는 것은 표다. 표를 끊고도 도달하면 그 모듈은 표 없이도 로드된다는 뜻이고,
  // 그러면 기능을 꺼도 사라지지 않는다.
  const TABLE = "native/electron/capabilities.cjs";
  const walk = (roots, skip) => {
    const seen = new Set(), stack = [...roots];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const t of g.edges.get(cur) || []) { if (!skip.has(t)) stack.push(t); }
    }
    return seen;
  };
  // 네이티브 진입점은 main.cjs 하나다. preload 는 진입점이 아니라 경로 문자열로 도달하는
  // 의존이라 여기서 순회하면 함께 딸려 온다. 진입점 수가 아니라 순회로 도달한 앱 셸의 크기로
  // 계측기가 동작하는지 확인한다. 진입점만 세면 preload 의 분류가 바뀔 때 조용히 흔들린다.
  const nativeEntries = g.entries.filter((e) => e.startsWith("native/"));
  if (!nativeEntries.length) cannotMeasure("네이티브 진입점을 하나도 못 찾았다");
  if (!g.files.includes(TABLE)) cannotMeasure(`${TABLE} 이 그래프에 없다`);
  const frame = walk(nativeEntries, new Set([TABLE]));
  const frameNative = [...frame].filter((f) => f.startsWith("native/"));
  if (frameNative.length < 20) cannotMeasure(`틀이 끌어오는 네이티브 파일을 ${frameNative.length} 개만 셌다 — 계측기가 죽었다`);

  const bad = [];
  const cut = new Set(boundaries.values());
  for (const [id, boundary] of boundaries) {
    if (!g.files.includes(boundary)) { bad.push(`${id}: ${boundary} 이 없다`); continue; }
    if (frame.has(boundary)) { bad.push(`${id}: 틀이 ${boundary} 를 표 없이도 끌어온다`); continue; }
    const others = new Set([...cut].filter((b) => b !== boundary));
    const owned = [...walk([boundary], others)].filter((f) => f.startsWith("native/"));
    const leaked = owned.filter((f) => f !== boundary && frame.has(f));
    if (leaked.length) bad.push(`${id}: 경계 뒤인데 틀도 끌어온다 — ${leaked.join(", ")}`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return true;
});

await checkAsync("네이티브 기능 id 는 렌더러 표의 id 와 같은 낱말이다", async () => {
  const table = await nativeCaps();
  const { CAPABILITIES } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const ids = new Set(CAPABILITIES.map((c) => c.id));
  // 같은 기능이 두 이름을 가지면 렌더러 쪽과 네이티브 쪽을 연결해 볼 수 없다. 끄는 스위치가
  // 한쪽만 끄게 되고, 그것을 잡을 방법이 없다.
  const bad = table.filter((c) => !ids.has(c.id)).map((c) => c.id);
  if (bad.length) throw new Error(`렌더러 표에 없는 id: ${bad.join(", ")}`);
  return true;
});

// ── 탭 분리 창은 자기 탭 하나가 전부다 ──────────────────────────────────────
//
// 빼낸 창에 원래 창의 그룹 띠가 따라오면 분리했는데 소속은 그대로인 것으로 보인다. 그룹은 원래
// 창의 정리 도구다. 분리한 탭은 옮긴 것이 아니라 감춘 것이라 원래 창에서는 그대로 유지된다.
check("탭 하나짜리 창은 그룹 띠를 안 그린다", () => {
  const src = read("web/js/browser/tabs.js");
  const seg = sliceBetween(src, "export function renderBmTabs()", "\n}\n",
    "탭 하나짜리 창은 그룹 띠를 안 그린다");
  // 그룹을 순회하는 코드가 onlyTab 이 아닐 때로 제한돼 있어야 한다.
  const guard = seg.indexOf("if (!onlyTab) {");
  const loop = seg.indexOf("for (const g of groups)");
  if (guard < 0) throw new Error("그룹 띠를 묶는 조건이 없다");
  if (loop < 0 || loop < guard) throw new Error("그룹을 도는 자리가 그 조건 밖에 있다");
  if (!/class="tgroup"/.test(seg)) cannotMeasure("그룹 띠 마크업을 못 찾았다 — 이 검사가 무엇을 재는지 모른다");
  return true;
});

// ── 탭 끌기는 크롬의 것을 옮긴 것이다 ──────────────────────────────────────
//
// 정본은 크롬 소스의 chrome/browser/ui/views/tabs/dragging/tab_drag_controller.cc 다.
// 거기서 읽은 것.
//   ContinueDragging 이 이동마다 커서 아래 띠를 다시 구하고, 지금 붙은 띠와 다르면 그 자리에서
//   옮긴다. 띠가 없으면 창으로 분리하고(DetachIntoNewBrowserAndRunMoveLoop), 있으면 그 띠에 붙인다.
//   놓기(EndDrag)는 상태를 끝낼 뿐이다.
//   담는지는 DoesTabStripContain 이 보고, 세로는 kVerticalDetachMagnetism(15) 만큼 넓힌다.
//
// HTML5 드래그앤드롭으로 만들면 창 밖 좌표를 받을 수 없고 창을 옮길 수도 없어서, 크롬의 동작을
// 재현할 수 없다.
check("세로 자석 수를 크롬에서 그대로 가져왔다", () => {
  const src = read("native/electron/tab-drag.cjs");
  if (!/const VERTICAL_DETACH_MAGNETISM = 15;/.test(src)) {
    throw new Error("kVerticalDetachMagnetism(15) 과 다른 수를 쓴다");
  }
  // 담는지 보는 식이 그 수를 실제로 쓰는가. 상수만 두고 안 쓰면 아무 뜻이 없다.
  const seg = sliceBetween(src, "function stripContains(", "\n  }",
    "세로 자석 수를 크롬에서 그대로 가져왔다");
  if (!/y >= rect\.y - VERTICAL_DETACH_MAGNETISM/.test(seg)) throw new Error("위쪽에 자석을 안 쓴다");
  if (!/y < rect\.y \+ rect\.h \+ VERTICAL_DETACH_MAGNETISM/.test(seg)) throw new Error("아래쪽에 자석을 안 쓴다");
  return true;
});

check("분리는 놓을 때가 아니라 경계를 넘을 때다", () => {
  const src = read("native/electron/tab-drag.cjs");
  const seg = sliceBetween(src, "function continueDragging(", "\n  }",
    "분리는 놓을 때가 아니라 경계를 넘을 때다");
  // 크롬: if (target_context != attached_context_) { ... }
  if (!/targetWc !== drag\.attachedWc/.test(seg)) throw new Error("붙은 띠와 대상을 안 견준다");
  if (!/detachIntoNewWindow\(pt\)/.test(seg)) throw new Error("띠가 없을 때 창으로 떼어내지 않는다");
  if (!/attachTo\(target\)/.test(seg)) throw new Error("다른 띠일 때 붙이지 않는다");
  // 놓기가 옮기는 일을 하면 크롬과 다른 손맛이 된다.
  const endSeg = sliceBetween(src, 'ipcMain.handle("ac-tabdrag-end"', "});",
    "분리는 놓을 때가 아니라 경계를 넘을 때다");
  if (/detachIntoNewWindow|attachTo\(/.test(endSeg)) throw new Error("놓을 때 옮기고 있다");
  return true;
});

check("끌기 판정은 렌더러가 하지 않는다", () => {
  const src = read("web/js/browser/tab-drag.js");
  // 렌더러는 자기 창 밖을 못 본다. 여기서 흉내 내면 두 판정이 갈린다.
  if (/VERTICAL_DETACH_MAGNETISM|stripContains|stripAt/.test(src)) {
    throw new Error("렌더러가 경계를 스스로 판정한다");
  }
  // HTML5 드래그앤드롭을 쓰면 창 밖 좌표가 사라진다. 반대로 그것을 막는 것은 필요하다.
  // 칩에 draggable="true" 가 남아 있어서, 막지 않으면 네이티브 드래그가 포인터 이벤트를
  // 취소하고 끌기가 동작하지 않는다.
  if (/dataTransfer|effectAllowed/.test(src)) throw new Error("HTML5 드래그앤드롭으로 돌아갔다");
  if (!/addEventListener\("dragstart", \(e\) => e\.preventDefault\(\)\)/.test(src)) {
    throw new Error("네이티브 드래그를 안 막는다 — 포인터 경로가 죽는다");
  }
  // 포인터 캡처를 걸면 그 뒤의 click 대상이 띠 자신이 되어 탭 클릭이 죽는다.
  if (/setPointerCapture/.test(src)) throw new Error("포인터 캡처를 쓴다 — 탭 클릭이 죽는다");
  // 화면 좌표로 보내야 main 이 다른 창의 띠와 견줄 수 있다.
  if (!/window\.screenX/.test(src) || !/window\.screenY/.test(src)) {
    throw new Error("커서를 화면 좌표로 안 보낸다");
  }
  return true;
});

check("탭 하나짜리 창에 되돌리기 단추를 두지 않는다", () => {
  const tabs = read("web/js/browser/tabs.js");
  const feat = read("web/js/browser/detach-tab.js");
  // 되돌리는 방법은 크롬과 같다. 끌어다 붙이거나 창을 닫는다. 별도 버튼은 그 둘을 흐린다.
  if (/data-reattach|reattachChip/.test(tabs + feat)) throw new Error("되돌리기 단추가 남아 있다");
  return true;
});

check("끌기 배선을 기능이 들고 온다", () => {
  const tabs = read("web/js/browser/tabs.js");
  const feat = read("web/js/browser/detach-tab.js");
  if (!/callHook\("detach\.stripReady"/.test(tabs)) throw new Error("코어가 띠를 안 넘긴다");
  if (!/provide\("detach\.stripReady"/.test(feat)) throw new Error("기능이 띠를 안 받는다");
  // 기능이 없어도 기존 방식의 순서 변경은 동작해야 한다. 끄면 재정렬까지 멈추면 안 된다.
  if (!/if \(!wired\) wireReorder\(/.test(tabs)) throw new Error("기능을 끄면 재정렬도 죽는다");
  return true;
});

// ── 크기 조절 손잡이: 도구 화면 위에서 끌어도 끊기지 않는다 ──────────────────────────
// 메모랩은 <iframe>, 서버는 <webview> 로 화면을 채운다. 둘 다 마우스 이벤트를 자기가 받으므로,
// 덮개 없이 document 로 끌면 포인터가 그 위에 들어서는 순간 끌기가 멈추고 그 안에서 버튼을 놓으면
// mouseup 도 오지 않는다. 그 뒤로는 누르지 않은 크기 조절이 포인터를 따라다닌다. 덮개가 그 두
// 창을 가려 좌표를 이 문서 안에 유지한다.

// 덮개 없이 document 로 끄는 코드가 다시 생기지 않도록, 세 손잡이는 공용 경로로만 끈다.
// 파일에 beginDrag 가 한 번 나오는 것으로 판정하면 한 손잡이만 되돌려도 통과한다. 손잡이마다
// 그 코드를 잘라서 확인한다.
check("크기 조절 손잡이는 손잡이마다 덮개 경로로 끈다", () => {
  const shield = read("web/js/core/drag-shield.js");
  const mainSrc = read("web/js/main.js");
  const engine = read("web/js/core/layout-engine.js");
  const base = read("web/css/01-base.css");
  if (!/\.drag-shield \{ position:fixed; inset:0;/.test(base)) throw new Error("덮개가 화면을 안 덮는다");
  if (!/z-index:9998/.test(base)) throw new Error("덮개가 iframe·webview 위에 안 선다");
  if (!/export function beginDrag/.test(shield)) throw new Error("공용 경로가 없다");
  // 영역 경계(폭·높이)와 편집 모드의 영역 옮기기가 끄는 곳의 전부다.
  const sites = [
    ["영역 경계", sliceBetween(engine, "function startResize(", "\n}\n", "영역 경계 손잡이")],
    ["영역 옮기기", sliceBetween(engine, "function startMove(", "\n}\n", "영역 옮기기 손잡이")],
  ];
  for (const [name, body] of sites) {
    if (!/beginDrag\(\{/.test(body)) throw new Error(name + " 손잡이가 덮개를 안 씌운다");
    if (!/e\.button !== 0/.test(body)) throw new Error(name + " 손잡이가 오른쪽 버튼으로도 끌린다");
  }
  for (const [name, src] of [["main.js", mainSrc], ["layout-engine.js", engine]]) {
    if (/document\.addEventListener\("mousemove"/.test(src)) throw new Error(name + " 이 아직 document 로 직접 끈다");
  }
  return true;
});

// 소스 모양으로는 버튼을 놓친 경우에 끝나는지 확인할 수 없으므로 실제로 실행해 확인한다.
const slot = (type, capture) => type + (capture ? "|capture" : "");

function dragShieldRuntime() {
  const src = read("web/js/core/drag-shield.js").replace(/\bexport /g, "");
  const names = [...src.matchAll(/(?:^|\n)function (\w+)/g)].map((m) => m[1]);
  const docHandlers = new Map(), winHandlers = new Map();
  const shields = [];
  const body = {
    style: {},
    appendChild(el) { shields.push(el); },
  };
  const document = {
    body,
    createElement: () => {
      const el = { className: "", style: {}, remove() { const i = shields.indexOf(el); if (i >= 0) shields.splice(i, 1); } };
      return el;
    },
    // 등록과 해제는 capture 까지 같아야 지워진다. 한쪽만 바꾸면 리스너가 남는데, 표가 type 만
    // 보면 그 누락이 드러나지 않는다.
    addEventListener: (type, fn, capture) => { docHandlers.set(slot(type, capture), fn); },
    removeEventListener: (type, fn, capture) => { docHandlers.delete(slot(type, capture)); },
  };
  const sandbox = {
    console, document,
    addEventListener: (type, fn, capture) => { winHandlers.set(slot(type, capture), fn); },
    removeEventListener: (type, fn, capture) => { winHandlers.delete(slot(type, capture)); },
  };
  const api = runInNewContext(src + `\n;({${names.join(",")}})`, sandbox, { filename: "web/js/core/drag-shield.js" });
  return { api, shields, body, docHandlers, winHandlers };
}

check("끄는 동안 덮개가 서고 손을 놓으면 걷힌다", () => {
  const rt = dragShieldRuntime();
  const moved = [];
  let ended = 0;
  rt.body.style.userSelect = "text";
  rt.api.beginDrag({ cursor: "col-resize", onMove: (e) => moved.push(e.clientX), onEnd: () => { ended += 1; } });
  if (rt.shields.length !== 1) throw new Error("덮개가 안 섰다");
  if (rt.shields[0].className !== "drag-shield") throw new Error("덮개 이름이 다르다");
  if (rt.shields[0].style.cursor !== "col-resize") throw new Error("끄는 동안 커서가 안 바뀐다");
  if (rt.body.style.userSelect !== "none") throw new Error("끄는 동안 글이 선택된다");
  rt.docHandlers.get(slot("mousemove", true))({ buttons: 1, clientX: 10 });
  if (moved.length !== 1) throw new Error("끌기가 안 따라온다");
  rt.docHandlers.get(slot("mouseup", true))();
  if (rt.shields.length !== 0) throw new Error("덮개가 안 걷혔다 — 화면 전체가 클릭을 안 받는다");
  if (ended !== 1) throw new Error("끝났다고 안 알린다");
  if (rt.body.style.userSelect !== "text") throw new Error("끄기 전 선택 설정으로 안 돌아간다");
  if (rt.docHandlers.size !== 0 || rt.winHandlers.size !== 0) throw new Error("듣던 자리가 남았다");
  return true;
});

// iframe 안에서 버튼을 놓아 mouseup 을 놓친 경우.
check("mouseup 을 놓쳐도 다음 이동에서 끝난다", () => {
  const rt = dragShieldRuntime();
  const moved = [];
  let ended = 0;
  rt.api.beginDrag({ onMove: (e) => moved.push(e.clientX), onEnd: () => { ended += 1; } });
  const onMove = rt.docHandlers.get(slot("mousemove", true));
  onMove({ buttons: 1, clientX: 10 });
  onMove({ buttons: 0, clientX: 40 });          // 손은 iframe 안에서 놓였다
  if (ended !== 1) throw new Error("놓친 mouseup 을 못 알아챈다");
  if (moved.length !== 1) throw new Error("손을 놓은 이동까지 끌기로 셌다");
  if (rt.shields.length !== 0) throw new Error("덮개가 남았다");
  if (rt.api.isDragging()) throw new Error("아직 끌고 있다고 본다");
  return true;
});

// 왼쪽 버튼을 놓은 뒤 오른쪽을 누른 채 움직이면 buttons 는 0 이 아니다. 아무 버튼이나로 판정하면
// 이 경우가 그대로 끌기로 이어진다.
check("끌기를 시작한 버튼을 놓으면 끝난다", () => {
  const rt = dragShieldRuntime();
  const moved = [];
  let ended = 0;
  rt.api.beginDrag({ onMove: (e) => moved.push(e.clientX), onEnd: () => { ended += 1; } });
  const onMove = rt.docHandlers.get(slot("mousemove", true));
  onMove({ buttons: 1, clientX: 10 });
  onMove({ buttons: 2, clientX: 40 });          // 왼쪽은 놓였고 오른쪽만 눌려 있다
  if (ended !== 1) throw new Error("왼쪽을 놓은 것을 못 알아챈다");
  if (moved.length !== 1) throw new Error("왼쪽을 놓은 뒤의 이동까지 끌기로 셌다");
  return true;
});

check("창이 포커스를 잃으면 끌기가 끝난다", () => {
  const rt = dragShieldRuntime();
  let ended = 0;
  rt.api.beginDrag({ onMove: () => {}, onEnd: () => { ended += 1; } });
  rt.winHandlers.get(slot("blur", false))();
  if (ended !== 1 || rt.shields.length !== 0) throw new Error("⌘Tab 뒤에도 손이 붙어 있다");
  return true;
});

}
