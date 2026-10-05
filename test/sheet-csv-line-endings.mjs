// csv 칸 하나를 고쳐 저장해도 줄 끝 형식과 끝 줄바꿈은 원본 그대로다.
// 확인 결과: "…2.25\n" 파일의 칸 하나를 고치자 끝 줄바꿈이 사라졌고, CRLF 파일은 모든 줄이 LF 로 바뀌었다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSeparated } from "../server/sheet.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-csv-eol-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const save = (name, text, edits) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  writeSeparated(file, ",", edits);
  return fs.readFileSync(file, "utf8");
};

test("LF 와 끝 줄바꿈을 유지한다", () => {
  assert.equal(save("lf.csv", "a,b\n1,2\n", [{ r: 2, c: 2, v: "9" }]), "a,b\n1,9\n");
});

test("CRLF 를 유지한다", () => {
  assert.equal(save("crlf.csv", "a,b\r\n1,2\r\n", [{ r: 2, c: 2, v: "9" }]), "a,b\r\n1,9\r\n");
});

test("끝 줄바꿈이 없던 파일에는 붙이지 않는다", () => {
  assert.equal(save("none.csv", "a,b\n1,2", [{ r: 2, c: 2, v: "9" }]), "a,b\n1,9");
});

test("BOM 을 유지한다", () => {
  assert.equal(save("bom.csv", "﻿a,b\n1,2\n", [{ r: 1, c: 1, v: "x" }]), "﻿x,b\n1,2\n");
});
