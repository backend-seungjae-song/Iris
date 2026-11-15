// 공유 백그라운드 탭 명령(server/mcp-worker/bg-commands.js)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { assetFileName, imageExt, createBgCommands, expiredOutFiles, figmaAssetListBody, figmaNotReadyReason, sameLabelFiles, figmaDumpBody, figmaFileUrl, figmaNodeId, jobPollExpression, jobStartExpression,
  outFileName } from "../server/mcp-worker/bg-commands.js";

test("node-id 는 url 에서, 없으면 인자에서 읽고 - 를 : 로 바꿈", () => {
  assert.equal(figmaNodeId("https://www.figma.com/design/K/x?node-id=163-17&m=dev"), "163:17");
  assert.equal(figmaNodeId("https://www.figma.com/design/K/x", "47:12"), "47:12");
  assert.equal(figmaNodeId("https://www.figma.com/design/K/x", "I47:12;3:4"), "I47:12;3:4");
  assert.equal(figmaNodeId("https://www.figma.com/design/K/x"), null);
  assert.equal(figmaNodeId("https://x/?node-id=abc"), null);
  assert.equal(figmaNodeId("https://x/?node-id=1-2", "\"); alert(1); (\""), null);
});

test("결과 파일 이름은 경로 문자를 지우고 호출마다 다른 조각을 붙임", () => {
  assert.equal(outFileName("20261113-0300", "ab12", "figma-163:17", "json"), "20261113-0300-ab12-figma-163-17.json");
  assert.equal(outFileName("s", "u", "../../etc", "txt"), "s-u-..-..-etc.txt");
  assert.ok(!outFileName("s", "u", "../../etc", "txt").includes("/"));
  assert.notEqual(outFileName("s", "a", "x", "json"), outFileName("s", "b", "x", "json"));
});

test("같은 파일이면 주소 모양과 관계없이 같은 탭 주소 · 브랜치는 따로 · Figma 주소가 아니면 오류", () => {
  const same = "https://www.figma.com/design/K1/x?m=dev";
  for (const u of ["https://www.figma.com/design/K1/x?node-id=1-2&m=dev#c", "https://www.figma.com/design/K1/%EB%A7%88?node-id=3-4&p=f&t=abc",
    "https://www.figma.com/file/K1/x?node-id=1-2", "https://figma.com/design/K1", "https://www.figma.com/design/K1/x"]) {
    assert.equal(figmaFileUrl(u), "https://www.figma.com/design/K1", u);
  }
  assert.equal(figmaFileUrl(same), "https://www.figma.com/design/K1");
  assert.equal(figmaFileUrl("https://www.figma.com/design/K1/branch/B2/x?node-id=1-2"), "https://www.figma.com/design/K1/branch/B2");
  for (const bad of ["nope", "https://example.com/design/K1/x", "https://www.figma.com/proto/K1/x", "https://figma.com.example.com/design/K1"]) {
    assert.throws(() => figmaFileUrl(bad), /Figma 파일 주소/, bad);
  }
});

test("bg_eval 의 out 은 절대 경로만", async () => {
  const bg = createBgCommands({ open: async () => ({}), evalOn: async () => 1, outDir: "/nope" });
  await assert.rejects(() => bg.bgEval({ url: "https://a", expression: "1", out: "rel.txt" }), /절대 경로/);
});

// 가짜 Figma 문서: 프레임 > (텍스트, 인스턴스 > 사각형), mixed 값 포함
function fakeFigma() {
  const mixed = Symbol("mixed");
  const node = (props, children) => {
    const n = { ...props, async getCSSAsync() { return { width: props.width + "px" }; } };
    if (children) { n.children = children; for (const c of children) c.parent = n; }
    return n;
  };
  const rect = node({ id: "3:1", type: "RECTANGLE", name: "bg", width: 10, height: 10, cornerRadius: mixed, topLeftRadius: 4,
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:1" } } }],
    fillStyleId: "S:red", reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:1", navigation: "NAVIGATE" }] },
      { trigger: { type: "ON_CLICK" }, actions: [{ type: "CONDITIONAL", conditionalBlocks: [{ actions: [{ type: "NODE", destinationId: "2:1" }] }] }] }] });
  const main = { id: "9:9", name: "Button", key: "k1", remote: true, parent: { type: "COMPONENT_SET", id: "9:1", name: "Buttons", key: "ks" } };
  const inst = node({ id: "2:2", type: "INSTANCE", name: "btn", width: 10, componentProperties: { Label: { value: "OK" } },
    async getMainComponentAsync() { return main; } }, [rect]);
  const text = node({ id: "2:1", type: "TEXT", name: "title", width: 20, characters: "안녕", fontSize: mixed,
    getStyledTextSegments: (f) => [{ start: 0, end: 2, characters: "안녕", fontSize: 18, fields: f.length }] });
  Object.defineProperty(text, "lineHeight", { get() { throw new Error("읽기 실패"); }, enumerable: true });
  const cell = node({ id: "4:2", type: "FRAME", name: "cell", width: 10, gridRowSpan: 2, gridRowCount: 0, relativeTransform: [[-1, 0, 10], [0, 1, 0]] });
  const grid = node({ id: "4:1", type: "FRAME", name: "grid", width: 30, layoutMode: "GRID", gridColumnCount: 3, gridRowGap: 24,
    gridRowSpan: 1, strokesIncludedInLayout: true, exportSettings: [{ format: "PNG" }] }, [cell]);
  const frame = node({ id: "1:1", type: "FRAME", name: "screen", width: 440, layoutMode: "VERTICAL", itemSpacing: 8, gridColumnCount: 0 }, [text, inst, grid]);
  const page = { id: "0:1", type: "PAGE", name: "Page 1", children: [frame] };
  frame.parent = page;
  const all = { "1:1": frame, "2:1": text, "2:2": inst, "3:1": rect, "4:1": grid, "4:2": cell };
  return { mixed, root: { children: [page] }, fileKey: "FK", getNodeByIdAsync: async (id) => all[id] || null,
    getStyleByIdAsync: async (id) => (id === "S:red" ? { name: "Primary/Red", type: "PAINT", description: "", remote: false } : null),
    variables: {
      getVariableByIdAsync: async (id) => ({
        "V:1": { name: "color/brand", resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "V:2" } }, codeSyntax: {} },
        "V:2": { name: "red/500", resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } }, codeSyntax: {} },
      })[id] || null,
      getVariableCollectionByIdAsync: async () => ({ name: "Tokens", modes: [{ modeId: "m1", name: "Light" }] }),
    } };
}

async function runInPage(context, expression) {
  return vm.runInContext(expression, context);
}

async function finish(context, id) {
  for (let i = 0; i < 100; i++) {
    const s = await runInPage(context, jobPollExpression(id));
    if (s.state !== "running") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("작업이 끝나지 않음");
}

test("figma 덤프는 하위 전체를 깊이 제한 없이 담고 mixed·읽기 실패를 남김", async () => {
  const context = pageContext();
  assert.equal(await runInPage(context, jobStartExpression("j1", figmaDumpBody("1:1"))), "started");
  const status = await finish(context, "j1");
  assert.equal(status.state, "done", status.error);
  assert.equal(status.meta.nodeCount, 6);
  const out = JSON.parse(context.__irisJobs.j1.text);
  assert.equal(out.nodeCount, 6);
  assert.deepEqual(out.page, { id: "0:1", name: "Page 1" });
  const [t, i] = out.root.children;
  assert.equal(t.fontSize, "mixed");
  assert.match(t.lineHeight.error, /읽기 실패/);
  assert.equal(t.textSegments[0].fontSize, 18);
  assert.equal(i.mainComponent.key, "k1");
  assert.equal(i.mainComponent.set.name, "Buttons");
  assert.equal(i.children[0].cornerRadius, "mixed");
  assert.equal(i.children[0].topLeftRadius, 4);
  assert.deepEqual(i.children[0].css, { width: "10px" });
  assert.equal(out.root.itemSpacing, 8);
});

test("figma 덤프는 스타일·변수·프로토타입 목적지의 이름을 표로 담음", async () => {
  const context = pageContext();
  await runInPage(context, jobStartExpression("j3", figmaDumpBody("1:1")));
  const status = await finish(context, "j3");
  assert.equal(status.state, "done", status.error);
  const out = JSON.parse(context.__irisJobs.j3.text);
  const rect = out.root.children[1].children[0];
  assert.equal(rect.fillStyleId, "S:red");
  assert.equal(rect.reactions[0].actions[0].destinationId, "1:1");
  assert.equal(out.styles["S:red"].name, "Primary/Red");
  assert.equal(out.variables["V:1"].name, "color/brand");
  assert.equal(out.variables["V:1"].collection, "Tokens");
  assert.equal(out.variables["V:2"].name, "red/500");
  assert.equal(out.destinations["1:1"].name, "screen");
  assert.equal(out.destinations["2:1"].name, "title");
});

test("figma 덤프는 그리드 속성을 그리드와 그 자식에서만 담고 뒤집기·내보내기 설정을 담음", async () => {
  const context = pageContext();
  await runInPage(context, jobStartExpression("j4", figmaDumpBody("1:1")));
  const status = await finish(context, "j4");
  assert.equal(status.state, "done", status.error);
  const out = JSON.parse(context.__irisJobs.j4.text);
  const grid = out.root.children[2];
  const cell = grid.children[0];
  assert.equal(grid.gridColumnCount, 3);
  assert.equal(grid.gridRowGap, 24);
  assert.equal(grid.gridRowSpan, undefined);
  assert.equal(grid.strokesIncludedInLayout, true);
  assert.deepEqual(grid.exportSettings, [{ format: "PNG" }]);
  assert.equal(cell.gridRowSpan, 2);
  assert.equal(cell.gridRowCount, undefined);
  assert.deepEqual(cell.relativeTransform, [[-1, 0, 10], [0, 1, 0]]);
  assert.equal(out.root.gridColumnCount, undefined);
});

test("없는 노드는 페이지 목록과 함께 오류", async () => {
  const context = pageContext();
  await runInPage(context, jobStartExpression("j2", figmaDumpBody("7:7")));
  const status = await finish(context, "j2");
  assert.equal(status.state, "error");
  assert.match(status.error, /7:7.*Page 1\(0:1\)/s);
});

// 섹션 영역 안에 있지만 부모가 페이지인 프레임 · 페이지는 loadAsync 전에는 children 이 빔
function sectionFigma() {
  const box = (x, y, w, h) => ({ absoluteBoundingBox: { x, y, width: w, height: h } });
  const section = { id: "5:1", type: "SECTION", name: "스플래쉬", children: [], ...box(0, 0, 800, 1000) };
  const icon = { id: "6:2", type: "VECTOR", name: "logo", isAsset: true, absoluteRenderBounds: {}, ...box(250, 250, 10, 10) };
  const inside = { id: "6:1", type: "FRAME", name: "스플래쉬B", children: [icon], ...box(200, 200, 400, 600) };
  const edge = { id: "6:3", type: "FRAME", name: "걸침", children: [], ...box(700, 900, 300, 300) };
  const away = { id: "6:4", type: "FRAME", name: "다른 화면", children: [], ...box(5000, 0, 400, 600) };
  icon.parent = inside;
  const kids = [section, inside, edge, away];
  const page = { id: "0:2", type: "PAGE", name: "최신", children: [], async loadAsync() { this.children = kids; for (const k of kids) k.parent = page; } };
  section.parent = page;
  const all = { "5:1": section, "6:1": inside, "6:2": icon, "6:3": edge, "6:4": away };
  return { root: { children: [page] }, fileKey: "FK", getNodeByIdAsync: async (id) => all[id] || null,
    getStyleByIdAsync: async () => null, variables: { getVariableByIdAsync: async () => null, getVariableCollectionByIdAsync: async () => null } };
}

function sectionContext() {
  const context = vm.createContext({ figma: sectionFigma(), setTimeout: (fn, ms) => setTimeout(fn, ms).unref() });
  context.window = context;
  return context;
}

test("섹션 덤프는 페이지를 먼저 불러오고 같은 부모 아래 섹션 영역과 겹치는 노드를 overlapping 에 하위 전체로 담음 · 에셋도 받음", async () => {
  const context = sectionContext();
  await runInPage(context, jobStartExpression("s1", figmaDumpBody("5:1")));
  const status = await finish(context, "s1");
  assert.equal(status.state, "done", status.error);
  const out = JSON.parse(context.__irisJobs.s1.text);
  assert.deepEqual(out.root.children, []);
  assert.deepEqual(out.overlapping.map((o) => [o.node.id, o.inside, o.aboveSection]), [["6:1", true, true], ["6:3", false, true]]);
  assert.equal(out.overlapping[0].node.children[0].id, "6:2");
  assert.equal(out.nodeCount, 4);
  const assets = sectionContext();
  await runInPage(assets, jobStartExpression("s2", figmaAssetListBody("5:1")));
  assert.equal((await finish(assets, "s2")).state, "done");
  assert.deepEqual(JSON.parse(assets.__irisJobs.s2.text).items.map((i) => i.id), ["6:2"]);
});

test("섹션이 아닌 노드는 겹치는 형제를 담지 않음", async () => {
  const context = sectionContext();
  await runInPage(context, jobStartExpression("s3", figmaDumpBody("6:1")));
  assert.equal((await finish(context, "s3")).state, "done");
  assert.equal(JSON.parse(context.__irisJobs.s3.text).overlapping, undefined);
});

// 메인 save 흉내: 페이지(vm)의 __irisJobs 결과를 읽어 새 파일로
function fakeSave(context, calls = []) {
  return async ({ tabId, jobId, file, base64 }) => {
    calls.push({ tabId, jobId, file, base64 });
    const job = context.__irisJobs[jobId];
    if (!job || job.state !== "done") throw new Error("끝난 페이지 작업이 없습니다.");
    const buf = base64 ? Buffer.from(job.text, "base64") : Buffer.from(job.text, "utf8");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf, { flag: "wx" });
    delete context.__irisJobs[jobId];
    return { path: file, bytes: buf.length };
  };
}

function pageContext() {
  // 페이지의 결과 정리 타이머(20분)가 테스트 프로세스를 붙잡지 않게 unref
  const context = vm.createContext({ figma: fakeFigma(), btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() });
  context.window = context;
  return context;
}

test("figmaDump 는 준비를 기다리고 메인 save 로 파일을 씀 · node-id 를 뺀 같은 주소로 탭을 엶", async () => {
  const context = pageContext();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  const opens = [], saves = [];
  const bg = createBgCommands({
    open: async (args) => { opens.push(args); return { tabId: "bg:1" }; },
    evalOn: async (_target, expression) => runInPage(context, expression),
    save: fakeSave(context, saves), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", profile: "work" });
  assert.equal(r.nodeCount, 6);
  assert.equal(JSON.parse(fs.readFileSync(r.path, "utf8")).root.id, "1:1");
  assert.ok(opens.every((a) => a.profile === "work" && a.url === "https://www.figma.com/design/K"));
  assert.equal(saves[0].tabId, "bg:1");
  assert.equal(Object.keys(context.__irisJobs).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("export 는 같은 조각 이름으로 이미지 파일을 base64 로 저장", async () => {
  const context = pageContext();
  const fig = context.figma;
  const n = await fig.getNodeByIdAsync("1:1");
  n.exportAsync = async () => new Uint8Array([137, 80, 78, 71]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), evalOn: async (_t, e) => runInPage(context, e),
    save: fakeSave(context), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", export: "png" });
  assert.deepEqual([...fs.readFileSync(r.exportPath)], [137, 80, 78, 71]);
  assert.equal(path.basename(r.exportPath, ".png"), path.basename(r.path, ".json"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("사람 확인 화면이면 같은 profile 로 일반 탭을 열라는 오류", async () => {
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1", challenge: true }), evalOn: async () => false,
    save: async () => { throw new Error("불리면 안 됨"); }, outDir: "/nope", sleep: async () => {} });
  await assert.rejects(() => bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", profile: "p" }), /browser_new_tab/);
  await assert.rejects(() => bg.bgEval({ url: "https://a", expression: "1" }), /사람 확인/);
});

test("저장이 실패하면 페이지 작업을 지움", async () => {
  const context = pageContext();
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), evalOn: async (_t, e) => runInPage(context, e),
    save: async () => { throw new Error("디스크 가득"); }, outDir: "/nope", sleep: () => new Promise((r) => setTimeout(r, 1)) });
  await assert.rejects(() => bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" }), /디스크 가득/);
  assert.equal(Object.keys(context.__irisJobs).length, 0);
});

// 일반 웹 페이지 흉내(vm) · 문서 로드는 끝난 상태
function plainPage() {
  const context = vm.createContext({ document: { readyState: "complete" }, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() });
  context.window = context;
  return context;
}
function pageBg(context, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  const opened = [];
  const bg = createBgCommands({ open: async (a) => { opened.push(a); return { tabId: "bg:1" }; }, evalOn: async (_t, e) => runInPage(context, e),
    save: fakeSave(context), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)), ...extra });
  return { bg, dir, opened };
}

test("bg_eval 은 작은 결과는 그대로, 큰 결과는 새 파일로 · undefined 는 빈 결과", async () => {
  const context = plainPage();
  const { bg, dir } = pageBg(context);
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "1+2" }), { value: 3 });
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "({ a: [1, 'x'] })" }), { value: { a: [1, "x"] } });
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "undefined" }), {});
  const big = await bg.bgEval({ url: "https://a", expression: "'x'.repeat(40000)" });
  assert.equal(big.bytes, 40000);
  assert.match(big.path, /\.txt$/);
  assert.equal(fs.readFileSync(big.path, "utf8"), "x".repeat(40000));
  const big2 = await bg.bgEval({ url: "https://a", expression: "'x'.repeat(40000)" });
  assert.notEqual(big2.path, big.path);
  const obj = await bg.bgEval({ url: "https://a", expression: "Array.from({ length: 9000 }, (_, i) => i)" });
  assert.match(obj.path, /\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(obj.path, "utf8")).length, 9000);
  const out = path.join(dir, "mine.txt");
  const given = await bg.bgEval({ url: "https://a", expression: "({ k: 1 })", out });
  assert.equal(given.path, out);
  assert.equal(fs.readFileSync(out, "utf8"), '{"k":1}');
  assert.equal(Object.keys(context.__irisJobs).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bg_eval 은 오래 걸리는 식도 페이지 작업으로 끝까지 받고 문장 여러 개는 바로 실행", async () => {
  const context = plainPage();
  const { bg, dir } = pageBg(context);
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "new Promise((r) => setTimeout(() => r('늦음'), 30))" }), { value: "늦음" });
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "var a = 1; a + 1" }), { value: 2 });
  await assert.rejects(() => bg.bgEval({ url: "https://a", expression: "Promise.reject(new Error('boom'))" }), /boom/);
  assert.equal(Object.keys(context.__irisJobs).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bg_eval 에 Figma 주소를 주면 figma_dump 와 같은 탭 주소로 열고 Figma 준비를 기다림", async () => {
  const context = pageContext();
  const real = context.figma;
  delete context.figma;
  let polls = 0;
  const { bg, dir, opened } = pageBg(context, { open: async (a) => { opened.push(a); if (++polls === 3) context.figma = real; return { tabId: "bg:1" }; } });
  const r = await bg.bgEval({ url: "https://www.figma.com/design/K/x/?node-id=1-1&m=dev", profile: "p", expression: "figma.fileKey" });
  assert.deepEqual(r, { value: "FK" });
  assert.ok(opened.every((a) => a.url === "https://www.figma.com/design/K" && a.profile === "p"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 가짜 문서에 에셋을 얹음: 이미지 채움(PNG 원본), 내보내기 지정(인스턴스), 아이콘(그리드 칸), 실패하는 아이콘, 숨긴 아이콘
function withAssets(context) {
  const f = context.figma;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  f.getImageByHash = (h) => (h === "H1" ? { getBytesAsync: async () => png } : null);
  const nodes = {};
  const grab = async (id) => (nodes[id] ||= await f.getNodeByIdAsync(id));
  return (async () => {
    const rect = await grab("3:1"), inst = await grab("2:2"), cell = await grab("4:2"), grid = await grab("4:1"), text = await grab("2:1");
    rect.fills = [...rect.fills, { type: "IMAGE", imageHash: "H1", scaleMode: "FILL" }, { type: "IMAGE", imageHash: "GONE" }];
    inst.exportSettings = [{ format: "PNG", constraint: { type: "SCALE", value: 2 }, suffix: "" }];
    inst.exportAsync = async (st) => new Uint8Array([st.format === "PNG" ? 0x89 : 0x3c, 9]);
    // 그리드에 내보내기 지정이 있어도 안쪽 아이콘(칸)은 따로 저장
    grid.exportSettings = [{ format: "SVG", constraint: { type: "SCALE", value: 1 }, suffix: "" }];
    grid.exportAsync = async () => new TextEncoder().encode("<g/>");
    cell.isAsset = true; cell.exportAsync = async () => new TextEncoder().encode("<svg/>");
    text.isAsset = true; text.exportAsync = async () => { throw new Error("내보내기 실패"); };
    return { png, cell };
  })();
}

test("figma 덤프는 이미지 원본·내보내기 지정·아이콘을 에셋 폴더에 저장하고 실패한 항목은 목록에 남김", async () => {
  const context = pageContext();
  await withAssets(context);
  const { bg, dir } = pageBg(context);
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" });
  assert.equal(r.nodeCount, 6);
  assert.equal(r.assetsPath, r.path.replace(/\.json$/, "-assets"));
  assert.deepEqual(r.assets, { images: 1, exports: 2, icons: 1, skipped: 0, errors: 2, bytes: 9 + 2 + 4 + 6 });
  const m = JSON.parse(fs.readFileSync(path.join(r.assetsPath, "assets.json"), "utf8"));
  assert.equal(m.images.H1.file, "images/H1.png");
  assert.deepEqual([...fs.readFileSync(path.join(r.assetsPath, "images/H1.png"))], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  assert.equal(m.exports["2:2"].files[0].file, "exports/2-2@2x.png");
  assert.equal(m.icons["4:2"].file, "icons/4-2.svg");
  assert.equal(fs.readFileSync(path.join(r.assetsPath, "icons/4-2.svg"), "utf8"), "<svg/>");
  assert.deepEqual(m.errors.map((e) => [e.kind, e.hash || e.id]).sort(), [["icon", "2:1"], ["image", "GONE"]]);
  assert.match(m.errors.find((e) => e.id === "2:1").error, /내보내기 실패/);
  assert.deepEqual(fs.readdirSync(r.assetsPath).sort(), ["assets.json", "exports", "icons", "images"]);
  assert.equal(Object.keys(context.__irisJobs).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("그려지는 레이어가 없는 아이콘은 내보내지 않고 skipped 로 남김 · 같은 노드 재덤프는 덤프 이름의 에셋 폴더를 다시 씀", async () => {
  const context = pageContext();
  const { cell } = await withAssets(context);
  cell.absoluteRenderBounds = null;
  let id = 0;
  const { bg, dir } = pageBg(context, { randomId: () => "r" + (++id) });
  const url = "https://www.figma.com/design/K/x?node-id=1-1";
  const first = await bg.figmaDump({ url });
  assert.equal(first.assets.icons, 0);
  assert.equal(first.assets.skipped, 1);
  const m = JSON.parse(fs.readFileSync(path.join(first.assetsPath, "assets.json"), "utf8"));
  assert.deepEqual(m.skipped, [{ kind: "icon", id: "4:2", name: "cell", reason: "그려지는 레이어가 없음" }]);
  const second = await bg.figmaDump({ url });
  const third = await bg.figmaDump({ url });
  assert.equal(second.path, first.path);
  assert.equal(second.assetsPath, first.assetsPath);
  assert.equal(third.assetsPath, first.assetsPath);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(first.path), path.basename(first.assetsPath)].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("이전 덤프에 에셋 폴더가 없으면 새 에셋 폴더를 이전 덤프 이름으로 옮김", async () => {
  const context = pageContext();
  let id = 0;
  const { bg, dir } = pageBg(context, { randomId: () => "r" + (++id) });
  const url = "https://www.figma.com/design/K/x?node-id=1-1";
  const first = await bg.figmaDump({ url, assets: false });
  const second = await bg.figmaDump({ url });
  assert.equal(second.path, first.path);
  assert.equal(second.assetsPath, first.path.replace(/\.json$/, "-assets"));
  assert.ok(fs.existsSync(path.join(second.assetsPath, "assets.json")));
  assert.equal(fs.readdirSync(dir).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("에셋 단계가 통째로 실패해도 덤프 결과는 돌려주고 이유를 남김 · assets false 면 건너뜀", async () => {
  const context = pageContext();
  await withAssets(context);
  let saves = 0;
  const base = fakeSave(context);
  const { bg, dir } = pageBg(context, { save: async (input) => { if (++saves === 2) throw new Error("디스크 꽉 참"); return base(input); } });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" });
  assert.equal(r.nodeCount, 6);
  assert.match(r.assetsError, /디스크 꽉 참/);
  const skip = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", assets: false });
  assert.equal(skip.assetsPath, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("에셋 한 묶음이 실패하면 그 묶음 항목만 실패로 남기고 다음 묶음은 계속", async () => {
  const context = pageContext();
  await withAssets(context);
  let saves = 0;
  const base = fakeSave(context);
  const { bg, dir } = pageBg(context, { save: async (input) => { if (/\.batch-0\.json$/.test(input.file)) { saves++; throw new Error("묶음 저장 실패"); } return base(input); } });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" });
  assert.equal(saves, 1);
  assert.equal(r.assets.errors, 6);
  assert.equal(r.assets.bytes, 0);
  assert.equal(Object.keys(context.__irisJobs).length, 0);
  assert.deepEqual(fs.readdirSync(r.assetsPath), ["assets.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("에셋 폴더도 하루가 지나면 지울 대상 · 이름 규칙", () => {
  const now = Date.parse("2026-11-13T00:00:00Z"), old = now - 25 * 3600 * 1000;
  assert.deepEqual(expiredOutFiles([{ name: "20261111-010101-abc-figma-K-1-1-assets", mtimeMs: old }, { name: "my-assets", mtimeMs: old }], now),
    ["20261111-010101-abc-figma-K-1-1-assets"]);
  assert.equal(assetFileName({ kind: "export", id: "I1:2;3:4", setting: { format: "SVG", constraint: { type: "SCALE", value: 1 }, suffix: "dark" } }), "exports/I1-2-3-4-dark.svg");
  assert.equal(assetFileName({ kind: "export", id: "1:2", index: 0, setting: { format: "PDF" } }), "exports/1-2-0.pdf");
  assert.equal(imageExt(Buffer.from([0xff, 0xd8, 0xff])), "jpg");
  assert.equal(imageExt(Buffer.from("GIF89a")), "gif");
});

test("보관 기간이 지난 결과 파일만, 이 도구가 만든 이름만 지울 대상", () => {
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    { name: "20261113-030000-ab12-figma-K-1-1.json", mtimeMs: 0 },
    { name: "20261113-030000-ab12-figma-K-1-1.png", mtimeMs: 0 },
    { name: "20261114-030000-cd34-bg-eval.txt", mtimeMs: day },
    { name: "notes.json", mtimeMs: 0 },
  ];
  assert.deepEqual(expiredOutFiles(entries, day + 10), ["20261113-030000-ab12-figma-K-1-1.json", "20261113-030000-ab12-figma-K-1-1.png"]);
  assert.deepEqual(expiredOutFiles(entries, day), []);
});

test("figmaDump 는 저장 전에 하루 지난 결과 파일을 지우고 다른 파일은 남김", async () => {
  const context = pageContext();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  const old = path.join(dir, "20200101-000000-aa-figma-K-1-1.json");
  const keep = path.join(dir, "notes.json");
  fs.writeFileSync(old, "x"); fs.writeFileSync(keep, "x");
  const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past); fs.utimesSync(keep, past, past);
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), evalOn: async (_t, e) => runInPage(context, e),
    save: fakeSave(context), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(fs.existsSync(r.path), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("막 연 탭에서 실행 문맥이 아직 없으면 잠시 뒤 다시 실행 · 다른 오류는 바로 실패", async () => {
  const context = plainPage();
  let fails = 0;
  const { bg, dir } = pageBg(context, { evalOn: async (_t, e) => { if (++fails < 3) throw new Error("Cannot find default execution context"); return runInPage(context, e); } });
  assert.deepEqual(await bg.bgEval({ url: "https://a", expression: "7" }), { value: 7 });
  assert.ok(fails >= 3);
  let other = 0;
  const bad = createBgCommands({ open: async () => ({}), outDir: "/nope", sleep: async () => {},
    evalOn: async () => { other++; throw new Error("SyntaxError"); } });
  const t0 = Date.now();
  await assert.rejects(() => bad.bgEval({ url: "https://a", expression: "(" }), /SyntaxError/);
  assert.ok(Date.now() - t0 < 1000, "확인 eval 이 실패해도 60초를 기다리지 않음");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("같은 대상의 이전 결과 파일만 비교 후보", () => {
  const names = ["20261113-030000-aa-figma-K-1-1.json", "20261113-040000-bb-figma-K-1-1.json", "20261113-040000-bb-figma-K-1-1.png",
    "20261113-040000-cc-figma-K-1-12.json", "notes.json"];
  assert.deepEqual(sameLabelFiles(names, "/d/20261113-040000-bb-figma-K-1-1.json"), ["20261113-030000-aa-figma-K-1-1.json"]);
});

test("같은 노드를 다시 덤프해 내용이 같으면 새 파일을 지우고 이전 파일 경로를 줌 · 내용이 바뀌면 새 파일", async () => {
  const context = pageContext();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  let id = 0;
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), evalOn: async (_t, e) => runInPage(context, e),
    save: fakeSave(context), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)), randomId: () => "r" + (++id) });
  const url = "https://www.figma.com/design/K/x?node-id=1-1";
  const first = await bg.figmaDump({ url });
  const second = await bg.figmaDump({ url });
  assert.equal(second.path, first.path);
  assert.equal(second.assetsPath, first.assetsPath);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(first.path), path.basename(first.assetsPath)].sort());
  (await context.figma.getNodeByIdAsync("1:1")).name = "changed";
  const third = await bg.figmaDump({ url });
  assert.notEqual(third.path, first.path);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("페이지가 바빠 상태 조회가 잠시 실패해도 다시 물어 끝까지 받음", async () => {
  const context = pageContext();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  let fails = 0;
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), save: fakeSave(context), outDir: dir,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    evalOn: async (_t, e) => { if (e.includes("state: j.state") && fails < 3) { fails++; throw new Error("결과를 안전하게 가리지 못했습니다."); } return runInPage(context, e); } });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" });
  assert.equal(fails, 3);
  assert.equal(r.nodeCount, 6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("페이지가 계속 응답하지 않으면 그 사실을 알리고 작업을 지움", async () => {
  const context = pageContext();
  let t = 0, polls = 0;
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), save: async () => { throw new Error("불리면 안 됨"); }, outDir: "/nope",
    now: () => t, sleep: async (ms) => { t += ms; },
    evalOn: async (_t, e) => { if (e.includes("state: j.state")) { polls++; throw new Error("timeout"); } return runInPage(context, e); } });
  await assert.rejects(() => bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1" }), /응답하지 않습니다.*하위 노드로 나눠/s);
  assert.ok(polls > 100);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Object.keys(context.__irisJobs).length, 0);
});

test("큰 노드 png 는 긴 변이 8192px 를 넘지 않게 배율을 줄이고 결과에 배율을 적음 · 페이지는 자식 테두리로 잼", async () => {
  const context = pageContext();
  const fig = context.figma;
  const page = fig.root.children[0];
  page.children[0].absoluteBoundingBox = { x: 0, y: 0, width: 20000, height: 3000 };
  let asked = null;
  page.exportAsync = async (opts) => { asked = opts; return new Uint8Array([1]); };
  const getNode = fig.getNodeByIdAsync;
  fig.getNodeByIdAsync = async (id) => (id === "0:1" ? page : getNode(id));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cmd-"));
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), evalOn: async (_t, e) => runInPage(context, e),
    save: fakeSave(context), outDir: dir, sleep: () => new Promise((r) => setTimeout(r, 1)) });
  const r = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=0-1", export: "png" });
  assert.equal(asked.constraint.value, 8192 / 20000);
  assert.equal(r.exportScale, 0.41);
  const frame = await getNode("1:1");
  frame.exportAsync = async (opts) => { asked = opts; return new Uint8Array([2]); };
  const small = await bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", export: "png" });
  assert.equal(asked.constraint.value, 2);
  assert.equal(small.exportScale, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Figma 가 준비되지 않은 이유를 페이지 상태로 고름", () => {
  assert.match(figmaNotReadyReason({ login: true }), /로그인되어 있지 않습니다/);
  assert.match(figmaNotReadyReason({ requestAccess: true }), /접근 권한이 없습니다/);
  assert.match(figmaNotReadyReason({ requestEdit: true }), /볼 수만 있고/);
  assert.match(figmaNotReadyReason({ href: "about:blank", title: "" }), /열리지 않았습니다\. 주소 about:blank/);
  assert.match(figmaNotReadyReason(null), /열리지 않았습니다\./);
});

test("figmaDump 시간 초과는 진단한 이유를 오류로", async () => {
  let t = 0;
  const bg = createBgCommands({ open: async () => ({ tabId: "bg:1" }), outDir: "/nope", now: () => t, sleep: async (ms) => { t += ms; },
    evalOn: async (_t, e) => (e.includes("labels") ? { href: "https://www.figma.com/design/K/x", title: "x – Figma", requestEdit: true } : false) });
  await assert.rejects(() => bg.figmaDump({ url: "https://www.figma.com/design/K/x?node-id=1-1", profile: "p" }), /볼 수만 있고.*60초 기다림/s);
});
