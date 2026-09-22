// 사람이 직접 실행하는 탐침. `fs.list`(탐색기)와 `fs.tree`(⌘⇧P 검색 백엔드)가 무엇을
// 돌려주는지 눈으로 본다. 닷파일이 보이는지, 트리가 재귀로 내려가는지.
//
// 검사가 아니라 탐침이다. 단정문이 없고 결과를 사람이 읽는다. 그래서 `test/`가 아니라 여기 있다.
//
// 이것을 검사로 만들지 못하는 이유는 허용 루트에 있다. 서버는 살아 있는 에이전트의 cwd와 스페이스
// 폴더만 열어 주는데(`allowedRoots`), 검사가 띄우는 서버에는 herdr가 없어 그 목록이 빈다.
// 그래서 헤드리스에서는 무엇을 물어도 "허용되지 않은 경로"가 돌아온다. 그 경계 자체는
// `test/fs-path-boundary.mjs`가 본다.
//
// 실행: node scripts/probe/fs-tree.mjs [포트]
import WS from "ws";
import { port as defaultPort } from "../../server/env.cjs";

const WebSocket = WS.WebSocket || WS;
const PORT = Number(process.argv[2]) || defaultPort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

let root = null;
const pending = new Map();
ws.on("message", (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === "state" && !root) {
    const a = (m.agents || []).find((x) => x.cwd); if (a) root = a.cwd;
  }
  if (m.type === "fs") { const p = pending.get("list"); if (p) { p(m); pending.delete("list"); } }
  if (m.type === "tree") { const p = pending.get("tree"); if (p) { p(m); pending.delete("tree"); } }
});
const req = (kind, msg) => new Promise((res) => { pending.set(kind, res); ws.send(JSON.stringify(msg)); });

ws.on("open", async () => {
  for (let i = 0; i < 20 && !root; i++) await sleep(200);
  if (!root) { console.log("루트 없음 — 에이전트 cwd가 있는 서버에 붙어야 합니다"); ws.close(); process.exit(0); }
  console.log("root:", root);
  const list = await req("list", { type: "fs.list", path: root });
  const dots = (list.entries || []).filter((e) => e.name.startsWith("."));
  console.log(`fs.list: ${(list.entries || []).length} entries, 닷파일/폴더 ${dots.length}개 → ${dots.slice(0, 8).map((e) => e.name).join(", ")}`);
  const tree = await req("tree", { type: "fs.tree", path: root });
  const files = tree.files || [];
  const treeDots = files.filter((f) => f.split("/").pop().startsWith("."));
  console.log(`fs.tree: ${files.length} files, truncated=${tree.truncated}, 닷파일 ${treeDots.length}개`);
  console.log("sample:", files.slice(0, 5).map((f) => f.slice(root.length + 1)).join(" | "));
  ws.close(); process.exit(0);
});
ws.on("error", (e) => { console.error("WS 오류:", e.message); process.exit(1); });
