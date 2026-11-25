// 대화 모드 A2UI 파서·상태 적용·액션 포맷·HTTP 엔드포인트 경계 검증
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import {
  A2UI_BASIC_CATALOG,
  A2UI_CATALOG_ID,
  applyA2uiMessages,
  extractA2uiBlocks,
  extractSurfacesFromMessages,
  formatA2uiAction,
  normalizeA2uiMessage,
  stripA2uiBlocks,
  stripA2uiFromMessages,
} from "../server/agent-chat-a2ui.js";
import { handleAgentChatA2ui } from "../server/agent-chat.js";

test("extractA2uiBlocks 는 a2ui 펜스 블록만 JSON 파싱하고 깨진 블록이나 일반 코드 블록은 무시한다", () => {
  const md = [
    "설명입니다.",
    "```json",
    "{\"ignored\": true}",
    "```",
    "```a2ui",
    "{ invalid json }",
    "```",
    "```a2ui",
    JSON.stringify({
      surfaceId: "deploy",
      title: "배포 확인",
      components: [{ type: "Button", label: "배포", action: "deploy" }],
    }),
    "```",
  ].join("\n");

  const blocks = extractA2uiBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].surfaceId, "deploy");
});

test("extractA2uiBlocks 는 큰 블록과 과도한 블록 수를 제한한다", () => {
  const huge = "```a2ui\n" + "x".repeat(256 * 1024 + 1) + "\n```";
  const many = Array.from({ length: 80 }, (_, i) => "```a2ui\n" + JSON.stringify({ surfaceId: String(i), components: [] }) + "\n```").join("\n");
  assert.deepEqual(extractA2uiBlocks(huge), []);
  assert.equal(extractA2uiBlocks(many).length, 64);
});

test("normalizeA2uiMessage 는 표준 4종과 단축 형식을 정규화하고 layout 을 제한한다", () => {
  const short = normalizeA2uiMessage({
    title: "비교표",
    layout: "invalid-layout",
    components: [{ type: "Table", columns: ["항목", "값"], rows: [["A", "1"]] }],
  });
  assert.equal(short.type, "createSurface");
  assert.equal(short.surfaceId, "default");
  assert.equal(short.layout, "dock");
  assert.equal(short.components[0].type, "Table");

  const enveloped = normalizeA2uiMessage({
    updateDataModel: { surfaceId: "s1", data: { env: "prod" } },
  });
  assert.deepEqual(enveloped, {
    type: "updateDataModel",
    surfaceId: "s1",
    path: "",
    data: { env: "prod" },
  });

  const del = normalizeA2uiMessage({ type: "deleteSurface", surfaceId: "s1" });
  assert.deepEqual(del, { type: "deleteSurface", surfaceId: "s1" });
});

test("extractSurfacesFromMessages 는 대화 흐름의 생성·데이터 갱신·삭제를 순서대로 반영한다", () => {
  const msgs = [
    {
      role: "assistant",
      blocks: [{
        type: "text",
        text: "```a2ui\n" + JSON.stringify([
          { type: "createSurface", surfaceId: "s1", title: "폼", layout: "center", components: [{ type: "TextField", id: "name", bind: "name" }], dataModel: { name: "초기" } },
          { type: "createSurface", surfaceId: "s2", title: "임시", components: [{ type: "Text", text: "hi" }] },
        ]) + "\n```",
      }],
    },
    {
      role: "assistant",
      blocks: [{
        type: "text",
        text: "```a2ui\n" + JSON.stringify([
          { type: "updateDataModel", surfaceId: "s1", dataModel: { name: "변경됨" } },
          { type: "deleteSurface", surfaceId: "s2" },
        ]) + "\n```",
      }],
    },
  ];

  const surfaces = extractSurfacesFromMessages(msgs);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].surfaceId, "s1");
  assert.equal(surfaces[0].layout, "center");
  assert.deepEqual(surfaces[0].dataModel, { name: "변경됨" });
});

test("formatA2uiAction 은 액션 이름과 입력 데이터를 한 줄 명령으로 만든다", () => {
  const text = formatA2uiAction({
    surfaceId: "s1",
    title: "배포 설정",
    action: "confirm",
    payload: { target: "prod" },
    dataModel: { dryRun: false },
  });
  assert.equal(text, '[A2UI:배포 설정] confirm payload={"target":"prod"} data={"dryRun":false}');
});

test("handleAgentChatA2ui 는 로컬 요청만 허용하고 잘못된 입력을 거부한다", async () => {
  function invoke(remoteAddress, rawBody, headers = {}) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      req.socket = { remoteAddress };
      req.headers = { host: "127.0.0.1:4290", ...headers };
      let destroyed = false;
      req.destroy = () => { destroyed = true; };
      let status = 200;
      let out = "";
      const res = {
        headersSent: false,
        writeHead(code) { status = code; res.headersSent = true; return res; },
        end(chunk = "", callback) { out += String(chunk); callback?.(); resolve({ status, body: out, destroyed }); },
      };
      handleAgentChatA2ui(req, res);
      if (rawBody !== null) req.emit("data", Buffer.from(rawBody, "utf8"));
      req.emit("end");
    });
  }

  for (const headers of [{ origin: "https://example.test" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await invoke("127.0.0.1", "{}", headers)).status, 403);
  }
  assert.equal((await invoke("127.0.0.1", "{}", { "content-type": "text/plain" })).status, 403);
  assert.equal((await invoke("127.0.0.1", "{}", { "content-type": "application/json; charset=utf-8" })).status, 400);
  const remote = await invoke("10.0.0.5", "{}");
  assert.equal(remote.status, 403);

  const missing = await invoke("127.0.0.1", JSON.stringify({ paneId: "" }));
  assert.equal(missing.status, 400);

  const ok = await invoke("127.0.0.1", JSON.stringify({
    paneId: "w1:p1",
    message: { type: "createSurface", surfaceId: "x", components: [{ type: "Text", text: "ok" }] },
  }));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, updated: 0 });

  const oversized = await invoke("127.0.0.1", "x".repeat(256 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.destroyed, true);
});

test("A2UI 본문 초과는 실제 IncomingMessage의 413 응답을 끝낸 뒤 요청 스트림을 정리한다", async (t) => {
  const state = {};
  const server = http.createServer((req, res) => {
    state.req = req;
    state.res = res;
    const pause = req.pause.bind(req);
    req.pause = (...args) => { state.requestPaused = true; return pause(...args); };
    const destroy = req.destroy.bind(req);
    req.destroy = (...args) => {
      state.destroyAfterResponse = state.responseFinished === true;
      return destroy(...args);
    };
    req.on("close", () => { state.requestClosed = true; });
    req.on("end", () => { state.requestEnded = true; });
    res.on("finish", () => { state.responseFinished = true; });
    handleAgentChatA2ui(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const payload = Buffer.alloc(256 * 1024 + 1, "x");
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: "/agentchat-a2ui",
      headers: { "content-type": "application/json", "content-length": payload.length },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });

  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, "close");
  assert.deepEqual(JSON.parse(result.body), { ok: false, error: "payload too large" });
  assert.equal(state.responseFinished, true);
  assert.equal(state.requestPaused, true);
  assert.equal(state.destroyAfterResponse, true);
  assert.equal(state.requestClosed, true);
  assert.equal(state.req.destroyed, true);
  assert.equal(state.requestEnded, undefined, "초과 뒤에는 전체 요청 스트림의 end까지 읽지 않는다");
});

test("A2UI v0.9 Basic Catalog 평면 인접 리스트와 JSON Pointer 경로·순환 참조를 안전하게 정규화한다", () => {
  assert.equal(A2UI_CATALOG_ID, "https://a2ui.org/specification/v0_9/basic_catalog.json");
  for (const name of ["Tabs", "Modal", "ChoicePicker", "Slider", "DateTimeInput", "CheckBox", "Image", "Icon", "List"]) {
    assert.ok(A2UI_BASIC_CATALOG.includes(name), `${name} missing from catalog`);
  }

  const msg = normalizeA2uiMessage({
    createSurface: {
      surfaceId: "v09",
      title: "배포 승인",
      layout: "center",
      components: [
        { id: "root", component: "Column", children: ["tabs1", "modal1", "cycA"] },
        {
          id: "tabs1",
          component: "Tabs",
          tabItems: [
            { title: "설정", child: "slider1" },
            { title: "일정", child: "dt1" },
          ],
        },
        { id: "slider1", component: "Slider", label: "트래픽", min: 0, max: 100, step: 10, unit: "%", value: { "@path": "/rollout/pct" } },
        { id: "dt1", component: "DateTimeInput", label: "배포 시각", enableDate: true, enableTime: true, value: { path: "/rollout/at" } },
        { id: "modal1", component: "Modal", title: "상세", entryPointChild: "openBtn", contentChild: "modalTxt" },
        { id: "openBtn", component: "Button", primary: true, action: { event: { action: "open_detail", context: { stage: "canary" } } }, child: "openTxt" },
        { id: "openTxt", component: "Text", text: "상세 보기" },
        { id: "modalTxt", component: "Text", usageHint: "code", text: "canary=10%" },
        { id: "cycA", component: "Column", children: ["cycB"] },
        { id: "cycB", component: "Column", children: ["cycA"] },
      ],
      dataModel: { rollout: { pct: 20, at: "2026-11-24T12:00" } },
    },
  });

  assert.equal(msg.catalogId, A2UI_CATALOG_ID);
  assert.equal(msg.components.length, 1);
  const root = msg.components[0];
  assert.equal(root.type, "Column");
  assert.equal(root.children.length, 3);

  const [tabs, modal, cycA] = root.children;
  assert.equal(tabs.type, "Tabs");
  assert.equal(tabs.tabs[0].children[0].type, "Slider");
  assert.equal(tabs.tabs[0].children[0].value, "@rollout.pct");
  assert.equal(tabs.tabs[1].children[0].type, "DateTimeInput");
  assert.equal(tabs.tabs[1].children[0].value, "@rollout.at");

  assert.equal(modal.type, "Modal");
  assert.equal(modal.entryPointChild.variant, "primary");
  assert.equal(modal.entryPointChild.action, "open_detail");
  assert.deepEqual(modal.entryPointChild.payload, { stage: "canary" });
  assert.equal(modal.entryPointChild.children[0].text, "상세 보기");
  assert.equal(modal.contentChild.variant, "code");

  // 순환 참조(cycB -> cycA)는 조상 집합에서 끊긴다
  assert.equal(cycA.children[0].children.length, 0);
});

test("Image URL 스킴 필터와 별칭 컴포넌트(Checkbox·Select·MultipleChoice)를 정제한다", () => {
  const msg = normalizeA2uiMessage({
    components: [
      { type: "Checkbox", label: "동의" },
      { type: "Select", variant: "dropdown", options: ["a", "b"] },
      { type: "MultipleChoice", multiple: true, maxAllowedSelections: 2, options: ["x", "y"] },
      { type: "Icon", name: "check", tone: "ok" },
      { type: "Image", url: "javascript:alert(1)", alt: "bad" },
      { type: "Image", src: "data:text/html,<h1>xss</h1>" },
      { type: "Image", url: "https://example.com/preview.png", fit: "contain" },
    ],
  });

  assert.equal(msg.components[0].type, "CheckBox");
  assert.equal(msg.components[1].type, "ChoicePicker");
  assert.equal(msg.components[1].variant, "dropdown");
  assert.equal(msg.components[2].type, "ChoicePicker");
  assert.equal(msg.components[2].maxAllowedSelections, 2);
  assert.equal(msg.components[3].type, "Icon");
  assert.equal(msg.components[4].url, undefined);
  assert.equal(msg.components[5].url, undefined);
  assert.equal(msg.components[6].url, "https://example.com/preview.png");
});

test("stripA2uiBlocks 와 stripA2uiFromMessages 는 유효한 a2ui 블록만 대화 글에서 제거한다", () => {
  const withProse = "앞 안내\n\n```a2ui\n{\"title\":\"패널\",\"components\":[{\"type\":\"Text\",\"text\":\"ok\"}]}\n```\n\n뒤 안내";
  assert.equal(stripA2uiBlocks(withProse), "앞 안내\n\n뒤 안내");

  const onlyUi = "```a2ui\n{\"surfaceId\":\"s1\",\"title\":\"설정 확인\",\"components\":[{\"type\":\"Button\",\"label\":\"적용\"}]}\n```";
  assert.equal(stripA2uiBlocks(onlyUi), "[A2UI: 설정 확인]");

  const invalidOnly = "설명\n```a2ui\n{ broken }\n```";
  assert.equal(stripA2uiBlocks(invalidOnly), invalidOnly);

  const stripped = stripA2uiFromMessages([
    { role: "assistant", blocks: [{ type: "text", text: withProse }] },
    { role: "user", blocks: [{ type: "text", text: "```a2ui\n{\"components\":[{\"type\":\"Text\",\"text\":\"x\"}]}\n```" }] },
  ]);
  assert.equal(stripped[0].blocks[0].text, "앞 안내\n\n뒤 안내");
  assert.match(stripped[1].blocks[0].text, /```a2ui/);
});

test("임베디드·공유 Codex 스냅샷 재전송이 닫힌 surface를 다시 열지 않는다", async () => {
  const { createSnapshotA2ui } = await import("../server/paseo-ui/managed-a2ui.js");
  for (const rows of [true, false]) {
    const surfaces = new Map();
    const update = createSnapshotA2ui(surfaces, () => {});
    const item = { type: "assistant_message", text: '```a2ui\n{"surfaceId":"s","components":[{"type":"Text","text":"ok"}]}\n```' };
    const frame = rows ? { timelineRows: [{ item }] } : { timeline: [item] };
    update(frame);
    assert.equal(surfaces.has("s"), true);
    surfaces.clear();
    update(frame);
    assert.equal(surfaces.size, 0);
  }
});

test("긴 스냅샷이 새 항목을 추가해도 이전에 닫은 화면을 다시 열지 않는다", async () => {
  const { createSnapshotA2ui } = await import("../server/paseo-ui/managed-a2ui.js");
  const surfaces = new Map(), update = createSnapshotA2ui(surfaces, () => {});
  const item = id => ({ type: "assistant_message", text: "```a2ui\n" +
    JSON.stringify({ surfaceId: id, components: [{ type: "Text", text: "ok" }] }) + "\n```" });
  const timeline = Array.from({ length: 150 }, (_, index) => item("s" + index));
  update({ timeline });
  surfaces.clear();
  update({ timeline: [...timeline, item("new")] });
  assert.deepEqual([...surfaces.keys()], ["new"]);
});
