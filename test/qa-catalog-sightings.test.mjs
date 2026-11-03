// 회차별 반응을 카탈로그에 합치기: 키로 찾고, 없으면 조건으로 맞추고, 같은 반응이 반복돼도 결과가 같다
import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalogSightings } from "../server/qa-catalog.js";

test("카탈로그 항목마다 마지막으로 본 회차와 합친 횟수를 남긴다", () => {
  const catalog = { items: [{ key: "a", condition: { sel: "#toast" } }, { key: "b", condition: { text: "저장" } }, { key: "c", condition: { sel: "#none" } }] };
  const runs = [
    { name: "r1", sightings: { runSeq: 1, items: [{ id: "x", catalogKey: "a", count: 2 }, { id: "y", sel: "#toast" }] } },
    // 같은 반응이 수천 번 반복돼도 한 번 맞춘 결과를 씀
    { name: "r2", sightings: { runSeq: 2, items: Array.from({ length: 3000 }, (_, i) => ({ id: `t${i % 3}`, clues: { text: "저장됨" } })) } },
  ];
  const out = applyCatalogSightings(catalog, runs, { repo: process.cwd(), runSeq: 3 });
  const [a, b, c] = out.items;
  assert.equal(a.lastRun, "r1"); assert.equal(a.count, 3, "x 2회 + y 1회");
  assert.equal(b.lastRun, "r2"); assert.equal(b.lastRunSeq, 2); assert.equal(b.count, 3, "같은 회차의 같은 id 는 한 번");
  assert.equal(c.lastRun, undefined);
});

test("반응 출처는 연결 저장소(build.related) 파일도 받고, 그 밖은 거부한다", async () => {
  const { verifyReactionSource, catalogStaleness } = await import("../server/qa-catalog.js");
  const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-related-"));
  const repo = path.join(base, "client"), admin = path.join(base, "admin"), other = path.join(base, "other");
  for (const dir of [repo, admin, other]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "a.ts"), "one\ntwo\n"); }
  assert.throws(() => verifyReactionSource("../admin/a.ts:2", { repo }), /연결 저장소/);
  const ok = verifyReactionSource("../admin/a.ts:2", { repo, roots: [admin] });
  assert.equal(ok.source, path.join(admin, "a.ts") + ":2", "제품 저장소 밖은 절대 경로로 저장");
  assert.throws(() => verifyReactionSource("../other/a.ts:1", { repo, roots: [admin] }), /연결 저장소/);
  assert.equal(verifyReactionSource("a.ts:1", { repo, roots: [admin] }).source, "a.ts:1");
  // 저장한 출처는 파일이 그대로면 다시 확인할 때 문제 없음
  assert.deepEqual(catalogStaleness({ source: ok.source, sourceHash: ok.sourceHash }, { repo }).reviewReasons, []);
  fs.writeFileSync(path.join(admin, "a.ts"), "changed\ntwo\n");
  assert.deepEqual(catalogStaleness({ source: ok.source, sourceHash: ok.sourceHash }, { repo }).reviewReasons, ["출처 파일 변경"]);
});
