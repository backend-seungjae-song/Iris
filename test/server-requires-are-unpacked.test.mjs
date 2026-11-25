// 설치된 앱의 서버는 app.asar.unpacked 에서 실행되어 asar 안의 파일을 읽지 못함
// 서버가 server/ 밖의 파일을 불러오면 그 파일도 asarUnpack 에 있어야 함 (2026-11-18 설치 실패)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpack = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.asarUnpack;

function isUnpacked(rel) {
  return unpack.some((pattern) => {
    if (pattern.endsWith("/**") || pattern.endsWith("/**/*")) return rel.startsWith(pattern.replace(/\/\*\*(\/\*)?$/, "/"));
    return pattern === rel;
  });
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|cjs|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test("서버가 불러오는 server/ 밖의 파일은 asarUnpack 에 들어 있음", () => {
  const missing = [];
  let outside = 0;
  for (const file of sourceFiles(path.join(root, "server"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:require|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']|\)\(\s*["'](\.\.?\/[^"']+)["']\)|from\s+["'](\.\.?\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1] || match[2] || match[3]);
      const rel = path.relative(root, target).split(path.sep).join("/");
      if (rel.startsWith("server/") || rel.startsWith("..")) continue;
      outside += 1;
      if (!isUnpacked(rel)) missing.push(`${path.relative(root, file)} → ${rel}`);
    }
  }
  assert.ok(outside > 0, "server/ 밖을 불러오는 곳을 하나도 찾지 못함(검사가 대상을 읽지 못함)");
  assert.deepEqual(missing, []);
});
