import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTranscriptService } from "../server/remote/transcript.js";

const AGENT = "a".repeat(32);

function line(value) { return `${JSON.stringify(value)}\n`; }

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-remote-transcript-"));
  const claude = path.join(root, "claude");
  const state = path.join(root, "state");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(claude, "projects", "session.jsonl");
  fs.writeFileSync(file, line({ type: "user", uuid: "u1", timestamp: "2026-09-27T00:00:00Z",
    message: { content: "첫 질문" } }) + line({ type: "assistant", uuid: "a1", timestamp: "2026-09-27T00:00:01Z",
    message: { content: [{ type: "text", text: "첫 답" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/private/x" } }] } }));
  const source = { paneId: "private-pane", transcriptFile: file };
  const agents = { resolve: (ref) => ref === AGENT ? { ref, kind: "claude", source } : null };
  let random = 1;
  const timers = [];
  const service = createTranscriptService({ agents, stateDir: state, randomBytes: (size) => Buffer.alloc(size, random++),
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; } });
  t.after(() => service.close());
  return { file, service, timers };
}

test("대화 페이지는 최신순 Item만 내보내고 커서는 연결별 불투명 값이다", (t) => {
  const { service } = harness(t);
  const page = service.page("conn-1", AGENT);
  assert.equal(page.ok, true);
  assert.deepEqual(page.items.map((item) => [item.role, item.text, item.tool]), [
    ["tool", '{"file_path":"[Mac 경로]"}', "Read"],
    ["assistant", "첫 답", undefined],
    ["user", "첫 질문", undefined],
  ]);
  assert.equal(Buffer.byteLength(JSON.stringify(page.items)) <= 48 * 1024, true);
  const encoded = JSON.stringify(page);
  assert.equal(encoded.includes("private-pane"), false);
  assert.equal(encoded.includes("session.jsonl"), false);
  assert.deepEqual(service.page("conn-1", "f".repeat(32)), { ok: false, error: "forbidden" });
});

test("transcript.watch는 새 완성 줄을 1초 폴링으로 append한다", async (t) => {
  const { file, service, timers } = harness(t);
  const sent = [];
  assert.deepEqual(service.watch("conn", AGENT, (value) => sent.push(value)), { ok: true });
  assert.equal(timers[0].delay, 1000);
  assert.deepEqual(service.watch("conn", AGENT, (value) => sent.push(value)), { ok: true });
  assert.equal(timers[0].cleared, true, "새 watch가 이전 polling을 정리한다");
  fs.appendFileSync(file, line({ type: "assistant", uuid: "a2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: "새 답" } }));
  await timers[1].fn();
  assert.deepEqual(sent, [{ type: "transcript.append", agent: AGENT,
    items: [{ role: "assistant", text: "새 답", at: Date.parse("2026-09-27T00:00:02Z") }] }]);
  service.closeConnection("conn");
});

test("대화 페이지는 50개씩 나누고 커서를 다른 연결에서 받지 않는다", (t) => {
  const { file, service } = harness(t);
  for (let index = 0; index < 60; index++) fs.appendFileSync(file, line({ type: "user", uuid: `u${index + 2}`,
    message: { content: `질문 ${index}` } }));
  const first = service.page("conn-1", AGENT);
  assert.equal(first.items.length, 50);
  assert.match(first.before, /^[0-9a-f]{32}$/);
  assert.deepEqual(service.page("conn-2", AGENT, first.before), { ok: false, error: "invalid-request" });
  const second = service.page("conn-1", AGENT, first.before);
  assert.equal(second.items.length, 13);
  assert.equal(second.before, null);
});

test("끝나지 않은 2MiB 초과 줄은 페이지에 넣지 않는다", (t) => {
  const { file, service } = harness(t);
  fs.writeFileSync(file, "x".repeat((2 * 1024 * 1024) + 1));
  const originalRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => {
    const read = originalRead(...args);
    bytes += read;
    return read;
  };
  try {
    assert.deepEqual(service.page("conn", AGENT), { ok: true, items: [], before: null });
  } finally {
    fs.readSync = originalRead;
  }
  assert.equal(bytes <= 2 * 1024 * 1024, true, `읽은 바이트: ${bytes}`);
});

test("대화 속 이미지는 iris-image 주소로 바뀌고 media.image 로 나눠 받는다", async (t) => {
  const { file, service } = harness(t);
  const { fitsRemoteOutboundPayload } = await import("../server/remote/contract/ipc.js");
  const { projectMediaImage } = await import("../server/remote/projection.js");
  const shot = Buffer.alloc(500 * 1024, 7);
  const pasted = Buffer.from("pasted-png");
  fs.appendFileSync(file, line({ type: "user", uuid: "u2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: [{ type: "text", text: "이 화면" }, { type: "image", source: { type: "base64", media_type: "image/png", data: pasted.toString("base64") } }] } })
    + line({ type: "assistant", uuid: "a2", timestamp: "2026-09-27T00:00:03Z",
      message: { content: [{ type: "tool_use", id: "t2", name: "Screenshot", input: {} }] } })
    + line({ type: "user", uuid: "u3", timestamp: "2026-09-27T00:00:04Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "찍음" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } }] }] } }));
  const page = service.page("conn", AGENT);
  const user = page.items.find((item) => item.role === "user" && item.text.startsWith("이 화면"));
  const tool = page.items.find((item) => item.role === "tool" && item.text.startsWith("찍음"));
  assert.match(user.text, /^이 화면\n!\[이미지\]\(iris-image:[0-9a-f]{32}\)$/);
  assert.match(tool.text, /^찍음\n!\[이미지\]\(iris-image:[0-9a-f]{32}\)$/);
  assert.equal(JSON.stringify(page).includes("[이미지]\""), false);

  const ref = (text) => /iris-image:([0-9a-f]{32})/.exec(text)[1];
  const small = service.image(ref(user.text), 0);
  assert.deepEqual({ ...small, data: Buffer.from(small.data, "base64").toString() },
    { ok: true, mime: "image/png", size: pasted.length, offset: 0, data: "pasted-png" });
  const parts = [];
  for (let offset = 0; offset < shot.length;) {
    const got = service.image(ref(tool.text), offset);
    assert.equal(got.ok, true);
    assert.equal(got.size, shot.length);
    const payload = JSON.stringify(projectMediaImage({ rid: "r1", mime: got.mime, size: got.size, offset: got.offset, data: got.data }));
    assert.equal(fitsRemoteOutboundPayload(payload), true, "조각 하나가 원격 프레임 한도 안");
    const bytes = Buffer.from(got.data, "base64");
    parts.push(bytes);
    offset += bytes.length;
  }
  assert.equal(parts.length, 2);
  assert.deepEqual(Buffer.concat(parts), shot);
  assert.deepEqual(service.image(ref(tool.text), shot.length + 1), { ok: false, error: "invalid-request" });
  assert.deepEqual(service.image("e".repeat(32), 0), { ok: false, error: "expired" });

  // 같은 이름으로 다시 쓴 기록(다른 inode)의 같은 위치는 다른 줄일 수 있어 내주지 않음
  const kept = fs.readFileSync(file);
  fs.rmSync(file);
  fs.writeFileSync(file, kept);
  assert.deepEqual(service.image(ref(user.text), 0), { ok: false, error: "expired" });
});

test("같은 inode 로 다시 쓴 기록의 다른 이미지와 접근이 끊긴 에이전트에는 이미지를 내주지 않는다", (t) => {
  const { file, service } = harness(t);
  const shot = (data) => line({ type: "user", uuid: "u2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: [{ type: "text", text: "봐" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] } });
  const base = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, shot(Buffer.from("old!").toString("base64")));
  const ref = /iris-image:([0-9a-f]{32})/.exec(service.page("c", AGENT).items.find((x) => x.text.startsWith("봐")).text)[1];
  assert.equal(Buffer.from(service.image(ref, 0).data, "base64").toString(), "old!");
  // 같은 파일(같은 inode)을 덮어써 같은 위치에 다른 이미지
  const fd = fs.openSync(file, "r+");
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, base + shot(Buffer.from("new!").toString("base64")), 0);
  fs.closeSync(fd);
  assert.deepEqual(service.image(ref, 0), { ok: false, error: "expired" });
});

test("에이전트를 더 찾을 수 없으면 받은 적 있는 이미지도 내주지 않는다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-remote-transcript-"));
  const claude = path.join(root, "claude");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(claude, "projects", "s.jsonl");
  fs.writeFileSync(file, line({ type: "user", uuid: "u1", message: { content: [{ type: "image",
    source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } }] } }));
  let present = true;
  const agents = { resolve: (ref) => present && ref === AGENT ? { ref, kind: "claude", source: { transcriptFile: file } } : null };
  const service = createTranscriptService({ agents, stateDir: path.join(root, "state") });
  t.after(() => service.close());
  const ref = /iris-image:([0-9a-f]{32})/.exec(service.page("c", AGENT).items[0].text)[1];
  assert.equal(service.image(ref, 0).ok, true);
  present = false;
  assert.deepEqual(service.image(ref, 0), { ok: false, error: "expired" });
});

test("같은 이미지는 첫 쪽과 실시간 알림에서 같은 주소라 폰이 겹친 항목을 알아본다", async (t) => {
  const { file, service, timers } = harness(t);
  const sent = [];
  service.watch("conn", AGENT, (value) => sent.push(value));
  fs.appendFileSync(file, line({ type: "user", uuid: "u2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } }] } }));
  await timers.at(-1).fn();
  const appended = sent[0].items[0].text;
  const paged = service.page("conn", AGENT).items[0].text;
  assert.match(appended, /^!\[이미지\]\(iris-image:[0-9a-f]{32}\)$/);
  assert.equal(paged, appended);
  service.closeConnection("conn");
});

test("2MiB 넘는 이미지 줄도 페이지와 실시간 알림에 들어가고 그 뒤 대화가 멈추지 않는다", async (t) => {
  const { file, service, timers } = harness(t);
  const sent = [];
  service.watch("conn", AGENT, (value) => sent.push(value));
  const big = Buffer.alloc(1600 * 1024, 3).toString("base64");
  fs.appendFileSync(file, line({ type: "user", uuid: "u2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: [{ type: "text", text: "큰 화면" }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }] } })
    + line({ type: "assistant", uuid: "a2", timestamp: "2026-09-27T00:00:03Z", message: { content: "다음 답" } }));
  await timers.at(-1).fn();
  assert.deepEqual(sent.flatMap((x) => x.items).map((x) => x.text.split("\n")[0]), ["큰 화면", "다음 답"]);
  assert.ok(service.page("conn", AGENT).items.some((x) => x.text.startsWith("큰 화면\n![이미지](iris-image:")));
  service.closeConnection("conn");
});

test("이미지 주소는 글 길이 한도에서 잘리지 않고 [이미지] 는 해석기가 넣은 줄만 뺀다", async () => {
  const { joinImages, withoutImageLines } = await import("../server/remote/transcript.js");
  const refs = Array.from({ length: 80 }, (_, k) => `iris-image:${k.toString(16).padStart(32, "0")}`);
  const long = joinImages("a".repeat(3990), refs.slice(0, 1));
  assert.match(long, /\n!\[이미지\]\(iris-image:0{32}\)$/);
  assert.ok(Array.from(long).length <= 4000);
  const many = joinImages("", refs);
  const full = many.match(/!\[이미지\]\(iris-image:[0-9a-f]{32}\)/g);
  assert.ok(Array.from(many).length <= 4000);
  assert.match(many, new RegExp(`이미지 ${80 - full.length}개 더$`));
  assert.equal(many.split("\n").filter((l) => l.startsWith("![")).length, full.length, "잘린 주소 줄이 없다");
  assert.equal(withoutImageLines("문자열 [이미지]를 그대로\n[이미지]", 1), "문자열 [이미지]를 그대로");
});
