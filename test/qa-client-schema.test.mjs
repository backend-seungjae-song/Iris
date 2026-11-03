import test from "node:test";
import assert from "node:assert/strict";
import { QA_TOOLS, QA_MERGED, clientSchema } from "../bin/iris-qa.mjs";
import { QA_COMMAND_SCHEMAS, QA_EXPECT_SCHEMA, validateQaCommand } from "../server/qa-protocol.js";

const enums = (schema, out = new Set()) => {
  if (Array.isArray(schema)) schema.forEach((item) => enums(item, out));
  else if (schema && typeof schema === "object") for (const [key, value] of Object.entries(schema)) key === "enum" ? value.forEach((v) => out.add(v)) : enums(value, out);
  return out;
};

test("클라이언트 스키마는 정본의 인자 이름과 선택지를 모두 보이면서 크기는 절반 아래로 준다", () => {
  const server = Object.entries(QA_COMMAND_SCHEMAS).reduce((sum, [, schema]) => sum + JSON.stringify(schema).length, 0);
  const client = QA_TOOLS.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0);
  assert.ok(client < server / 2, `${client} / ${server}`);
  for (const tool of QA_TOOLS) {
    // 합친 조작 도구는 구성 명령마다 인자 이름과 선택지를 모두 보임. history 의 action 은 back·forward·reload 로 고름
    const merged = QA_MERGED[tool.name.slice(3)];
    const members = merged ? Object.values(merged).map(([cmd, fixed]) => [cmd, fixed]) : [[tool.name.slice(3)]];
    for (const [cmd, fixed] of members) {
      const schema = QA_COMMAND_SCHEMAS[cmd];
      for (const key of Object.keys(schema.properties)) if (!(fixed && key === "action")) assert.ok(tool.inputSchema.properties[key], `${tool.name}.${key}`);
      for (const value of enums(schema)) if (!(fixed && ["back", "forward", "reload"].includes(value))) assert.ok(enums(tool.inputSchema).has(value), `${tool.name} 선택지 ${value}`);
    }
  }
  assert.deepEqual(QA_TOOLS.find((tool) => tool.name === "qa_act").inputSchema.properties.action.enum,
    ["click", "dblclick", "hover", "drag", "type", "key", "scroll", "select", "back", "forward", "reload"]);
});

test("효과 type으로 갈리는 갈래는 한 객체로 합치고 type별 필수 칸을 설명에 적는다", () => {
  const effect = clientSchema(QA_EXPECT_SCHEMA).properties.effects.items;
  assert.equal(effect.anyOf, undefined);
  assert.deepEqual(effect.properties.type.enum, ["appear", "disappear", "unchanged", "absent", "change", "navigate", "dialog", "request", "none"]);
  assert.deepEqual(effect.required, ["type", "oracle"]);
  assert.match(effect.description, /change: to, navigate: url, request: method·path/);
  for (const key of ["sel", "role", "name", "text", "from", "to", "url", "kind", "method", "path", "status", "id"]) assert.ok(effect.properties[key], key);
});

test("갈래가 정해진 효과는 그 갈래의 빠진 칸을 오류로 알린다", () => {
  const click = (effect) => validateQaCommand("click", { x: 1, y: 2, expect: { effects: [{ oracle: "기능의 용도", ...effect }] } });
  assert.throws(() => click({ type: "change", sel: "#a" }), /effects\[0\]\.to: 필수 인자/);
  assert.throws(() => click({ type: "navigate" }), /effects\[0\]\.url: 필수 인자/);
  assert.throws(() => click({ type: "appear", text: "a", url: "/x" }), /effects\[0\]\.url: 허용되지 않은 인자/);
  assert.throws(() => click({ type: "teleport" }), /허용된 형식/);
});

test("qa_act·qa_app_act 는 action 으로 서버 명령을 고르고, 목록에서 뺀 옛 이름도 그대로 받는다", async () => {
  const { qaArguments } = await import("../bin/iris-qa.mjs");
  const expect = { effects: [{ type: "none", oracle: "기능의 용도" }] };
  const names = QA_TOOLS.map((tool) => tool.name);
  for (const hidden of ["qa_click", "qa_type", "qa_history", "qa_app_tap", "qa_text", "qa_url"]) assert.equal(names.includes(hidden), false, hidden);
  assert.equal(names.length, 45);
  assert.deepEqual(qaArguments("qa_act", { run: "r", action: "click", x: 1, y: 2, expect }).cmd, "click");
  assert.deepEqual(qaArguments("qa_act", { run: "r", action: "back", expect }).args.action, "back");
  assert.equal(qaArguments("qa_act", { run: "r", action: "back", expect }).cmd, "history");
  assert.equal(qaArguments("qa_app_act", { run: "r", action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, expect }).cmd, "app_swipe");
  assert.equal(qaArguments("qa_click", { run: "r", x: 1, y: 2, expect }).cmd, "click");
  assert.throws(() => qaArguments("qa_act", { run: "r", action: "tap", x: 1, y: 2, expect }), /action은 click/);
  assert.throws(() => qaArguments("qa_act", { run: "r", action: "click", expect }), /args\.x: 필수 인자/);
});
