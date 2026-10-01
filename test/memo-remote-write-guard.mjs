import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 원격 연결의 메모 쓰기 거부 확인
// 서버 루프백 고정과 별개의 이중 방어
// 요청마다 같은 유효 입력으로 대조: 로컬 = 상태 변경, 원격 = 상태·전송 무변화
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-memo-guard-"));
process.env.IRIS_STATE_DIR = stateDir;
const { initMemoService, handleMemoMessage, archivesOut } = await import("../server/memo-service.js");
const { memoVersion } = await import("../server/memo-dock-store.js");
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const sent = [];
function reset() {
  for (const f of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(stateDir, "memo-archives.json"), JSON.stringify({
    __shared__: [{ date: "2026-09-27", at: 1, rev: 2, blocks: [{ id: "b1", text: "하나", at: 1 }, { id: "b2", text: "둘", at: 2 }] }],
  }));
  sent.length = 0;
  initMemoService({ broadcast: (m) => sent.push(["broadcast", m]), visitClients: () => {} });
}
// 상태 폴더 전체 파일 내용 + 보관 목록
function snapshot() {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else files[path.relative(stateDir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(stateDir);
  return JSON.stringify({ files, arch: archivesOut() });
}
const ws = (local) => ({ _local: local, _ui: local, readyState: 1, send: (m) => sent.push(["send", m]) });

const CASES = [
  { type: "memo.set", space: "__shared__", text: "원격 덮어쓰기", baseVersion: memoVersion(""), requestId: "req-set" },
  { type: "memo.archive", space: "__shared__", text: "셋" },
  { type: "memo.archive.delete", space: "__shared__", date: "2026-09-27" },
  { type: "memo.archive.block.delete", space: "__shared__", date: "2026-09-27", id: "b1" },
];

for (const msg of CASES) {
  test(`${msg.type}: 로컬은 변경, 원격은 무변화`, () => {
    reset();
    const before = snapshot();
    assert.equal(handleMemoMessage(ws(true), { ...msg }), true);
    assert.notEqual(snapshot(), before, "대조군: 로컬 요청이 상태를 바꿔야 이 입력이 유효");
    assert.ok(sent.length > 0, "대조군: 로컬 요청의 응답·방송");
    assert.ok(!sent.some(([, m]) => /memo-error|memo-conflict/.test(typeof m === "string" ? m : JSON.stringify(m))), "대조군: 오류 응답 없음");

    reset();
    const base = snapshot();
    assert.equal(handleMemoMessage(ws(false), { ...msg }), true);
    assert.equal(snapshot(), base);
    assert.deepEqual(sent, []);
  });
}
