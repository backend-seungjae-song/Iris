#!/usr/bin/env node
// 고친 파일이 실제로 앱에 들어갔는지 확인한다.
//
// 배경: 이름이 같은 사본이 저장소 루트와 native/electron/ 양쪽에 있으면, 실제로 쓰이지
// 않는 쪽을 고치고 빌드해 "고쳤는데 그대로"인 앱이 나간다. 그 자리에서 알아채지 못하면
// 원인을 엉뚱한 데서 찾게 된다.
//
//   node scripts/check-shipped.mjs pre    빌드 전: 이름이 겹치는 미사용 사본을 잡는다
//   node scripts/check-shipped.mjs post   빌드 후: asar와 unpacked 사본이 소스와 같은지 본다
//
// post 는 asar 안 파일은 크기로, 밖으로 푼 파일은 실제 바이트로 본다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "pre";
const fail = (msg) => { console.error("\n✗ " + msg + "\n"); process.exit(1); };

// 앱에 포함되어 나가는 소스. 설치 앱은 package.json build.files의 web/**·server/**와 설치 후
// 모델이 쓰는 agent-context launcher를 싣고, asarUnpack으로 app.asar.unpacked에 푼 사본을
// 실행·서빙한다. vendor도 브라우저가 실제로 적재하는 런타임 자산이므로 포함한다.
// 여기서 빠지면 설치 앱에서만 빈 화면이나 기능 누락이 생긴다.
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(dir.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
function shippedSources() {
  const native = filesUnder("native/electron").filter((rel) => rel.endsWith(".cjs"));
  return ["bin/agent-context.mjs", ...native, ...filesUnder("server"), ...filesUnder("web")].sort();
}

const shipped = shippedSources();

if (mode === "pre") {
  const dupes = [];
  // vendor 자산은 외부 배포 트리라 루트 소스와 basename이 같아도 미사용 사본이 아니다.
  // post에서는 실제 출하 바이트이므로 계속 전부 대조한다.
  for (const rel of shipped.filter((source) => !source.startsWith("web/vendor/"))) {
    const base = path.basename(rel);
    if (rel === base) continue;                       // 이미 루트인 것은 대상이 아니다
    if (fs.existsSync(path.join(ROOT, base))) dupes.push({ base, real: rel });
  }
  if (dupes.length) {
    for (const d of dupes) console.error(`  ./${d.base}  ←  죽은 사본. 실제로 쓰이는 것은 ${d.real}`);
    fail("이름이 겹치는 사본이 있습니다. 어느 쪽을 고쳤는지 착각하면 빌드에 안 들어갑니다.\n"
       + "  사본을 지우거나 이름을 바꾼 뒤 다시 실행하세요.");
  }
  console.log("사본 없음 — 고칠 파일이 하나뿐입니다.");
  process.exit(0);
}

// ── post ──
const asarPath = path.join(ROOT, "dist/mac-arm64/Iris.app/Contents/Resources/app.asar");
const unpackedRoot = path.join(path.dirname(asarPath), "app.asar.unpacked");
if (!fs.existsSync(asarPath)) fail("빌드 산출물이 없습니다: " + asarPath);

const fd = fs.openSync(asarPath, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
fs.closeSync(fd);
const header = JSON.parse(jsonBuf.toString("utf8").replace(/\0+$/, ""));

function entryOf(rel) {
  let node = header;
  for (const part of rel.split("/")) {
    if (!node || !node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

const bad = [];
for (const rel of shipped) {
  const e = entryOf(rel);
  if (!e) { bad.push(`${rel} — asar 안에 없음`); continue; }
  if (e.unpacked) {
    const sourcePath = path.join(ROOT, rel);
    const unpackedPath = path.join(unpackedRoot, rel);
    if (!fs.existsSync(unpackedPath)) { bad.push(`${rel} — app.asar.unpacked 사본 없음`); continue; }
    const source = fs.readFileSync(sourcePath);
    const unpacked = fs.readFileSync(unpackedPath);
    if (!source.equals(unpacked)) bad.push(`${rel} — app.asar.unpacked 사본의 바이트가 소스와 다름`);
    continue;
  }
  const onDisk = fs.statSync(path.join(ROOT, rel)).size;
  if (e.size !== onDisk) bad.push(`${rel} — 소스 ${onDisk}B / 앱 ${e.size}B`);
}
if (bad.length) {
  for (const b of bad) console.error("  " + b);
  fail("소스와 앱의 내용이 다릅니다. 고친 것이 안 들어갔거나 다른 파일을 고쳤습니다.");
}
console.log(`앱에 들어간 소스 ${shipped.length}개가 저장소와 같습니다.`);
