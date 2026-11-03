// 소비 코드가 다른 저장소에 있는 제품: build.related 의 저장소 안 경로를 consumers 로 받는지
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureQaBuild } from "../server/qa-build.js";
import { reviewQaList, validateQaDeclaration } from "../server/qa-list-review.js";

const plan = (build) => ({ listRationale: "저장 위험 확인", build, risks: [{ id: "r1", risk: "저장이 실패할 수 있음", size: "high", knowledge: "some", decision: "test" }] });
const row = (consumers) => ({ id: "a", given: "저장 화면", risk: ["r1"], oracle: "기능의 용도: 저장 결과 표시", basisNote: "저장 명세",
  dataChanging: true, consumers, rerun: { mode: "human", reason: "시험" }, mustNotChange: [{ sel: "header", text: "제목", reason: "저장 중 유지" }] });

function repos() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-related-"));
  const make = (name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "use.js"), "export const x = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], { cwd: dir });
    return dir;
  };
  return { base, client: make("client"), server: make("server") };
}

test("관련 저장소 안의 절대·상대 경로는 받고 목록에 없는 저장소 경로는 거부", () => {
  const { base, client, server } = repos();
  try {
    const absolute = `${server}/src/use.js:1`;
    assert.throws(() => validateQaDeclaration(row([absolute]), { repo: client }), /경로를 찾을 수 없습니다/);
    assert.equal(validateQaDeclaration(row([absolute]), { repo: client, related: [server] }).consumers[0], absolute);
    assert.ok(validateQaDeclaration(row(["../server/src/use.js:1"]), { repo: client, related: [server] }));
    assert.ok(validateQaDeclaration(row(["src/use.js:1"]), { repo: client, related: [server] }));
    assert.throws(() => validateQaDeclaration(row([`${base}/outside.js:1`]), { repo: client, related: [server] }), /경로를 찾을 수 없습니다/);
    assert.equal(reviewQaList({ plan: plan({ repo: client, related: [server] }), rows: [row([absolute])], repo: client }).rows.length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("회차 시작은 관련 저장소가 git 저장소 최상위인지 확인하고 기록", () => {
  const { base, client, server } = repos();
  try {
    assert.deepEqual(captureQaBuild({ repo: client, related: [server] }).related.map(item => [item.repo, typeof item.head, item.dirty]), [[server, "string", false]]);
    assert.equal(captureQaBuild({ repo: client }).related, undefined);
    assert.throws(() => captureQaBuild({ repo: client, related: [path.join(server, "src")] }), /최상위/);
    assert.throws(() => captureQaBuild({ repo: client, related: [base] }), /git 저장소가 아닙니다/);
    assert.throws(() => captureQaBuild({ repo: client, related: ["server"] }), /절대 경로/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
