import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { subagentTree } from "../server/join.js";

const use = (id, name = "Agent") =>
  `${JSON.stringify({ message: { content: [{ type: "tool_use", id, name, input: {} }] } })}\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-join-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sess");
  const sub = path.join(dir, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const agent = (id, toolUseId, body) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general", toolUseId }));
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), body);
  };
  const file = path.join(sub, "agent-p.jsonl");
  return { rec: { file: `${dir}.jsonl`, dir }, agent, file };
}

const shape = (tree) => tree.map((n) => [n.agentId, shape(n.children)]);

test("부모 기록에 쓰는 중이던 tool_use 줄이 완성되면 다음 계산에서 중첩으로 잡는다", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.rec.file, use("P"));
  f.agent("p", "P", use("r", "Read"));
  f.agent("c", "C", use("q", "Read"));
  assert.deepEqual(shape(subagentTree("sess", new Map(), f.rec)), [["c", []], ["p", []]]);

  const line = use("C");
  fs.appendFileSync(f.file, line.slice(0, 25));
  assert.deepEqual(shape(subagentTree("sess", new Map(), f.rec)), [["c", []], ["p", []]]);

  fs.appendFileSync(f.file, line.slice(25));
  assert.deepEqual(shape(subagentTree("sess", new Map(), f.rec)), [["p", [["c", []]]]]);
});

test("기록 파일이 짧게 다시 쓰이면 이전에 읽은 tool_use 를 버린다", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.rec.file, use("P"));
  f.agent("p", "P", use("pad", "Read") + use("C"));
  f.agent("c", "C", use("q", "Read"));
  assert.deepEqual(shape(subagentTree("sess", new Map(), f.rec)), [["p", [["c", []]]]]);

  fs.writeFileSync(f.file, use("r", "Read"));
  assert.deepEqual(shape(subagentTree("sess", new Map(), f.rec)), [["c", []], ["p", []]]);
});

test("반복 계산은 기록 파일에서 늘어난 부분만 읽는다", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.rec.file, use("P") + use("pad", "Read").repeat(5000));
  f.agent("p", "P", use("r", "Read"));
  subagentTree("sess", new Map(), f.rec);

  let bytes = 0;
  const { readFileSync, readSync } = fs;
  fs.readFileSync = (file, ...rest) => {
    const out = readFileSync(file, ...rest);
    if (String(file).endsWith(".jsonl")) bytes += out.length;
    return out;
  };
  fs.readSync = (...args) => { const n = readSync(...args); bytes += n; return n; };
  t.after(() => Object.assign(fs, { readFileSync, readSync }));
  const line = use("more", "Read");
  fs.appendFileSync(f.rec.file, line);
  subagentTree("sess", new Map(), f.rec);
  assert.ok(bytes <= line.length, `읽은 양 ${bytes}B`);
});
