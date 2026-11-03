import fs from "node:fs";
import path from "node:path";

// QA 근거 인용·목록 추출·라벨체 판정의 상태 없는 계약
// 제공 API: quoteFromSource, listFromSource, nominalFault
// 의존 대상: Node 파일·경로 API
// 유지 조건: 파일 원문과 오류 문구, 목록 순서, 라벨체 판정 결과 보존
// 영향 범위: qa-journal, qa-rows, QA 계약 검사

const SRC_RANGE = /^(.*?):(\d+)(?:-(\d+))?$/;

export function quoteFromSource(src) {
  const m = SRC_RANGE.exec(String(src || "").trim());
  if (!m) return null;
  const file = m[1], a = Number(m[2]), b = m[3] ? Number(m[3]) : Number(m[2]);
  if (!file || !Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { error: `그 파일을 읽지 못했습니다: ${file}` }; }
  const lines = text.split("\n");
  if (b > lines.length) return { error: `${file}는 ${lines.length}행까지입니다(요청 ${a}-${b}).` };
  const picked = lines.slice(a - 1, b);
  const pad = Math.min(...picked.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return { quote: picked.map((l) => l.slice(Number.isFinite(pad) ? pad : 0)).join("\n").trim() };
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".dart", ".py",
  ".go", ".java", ".kt", ".rb", ".php", ".vue", ".svelte", ".swift", ".cs"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next",
  ".working", "vendor", "__pycache__", ".dart_tool"]);
const SCAN_CAP = 5000;

function scanUsage(root, ids, exclude) {
  const left = new Set(ids);
  let seen = 0, capped = false;
  const walk = (d) => {
    if (capped || !left.size) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (capped || !left.size) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(full); continue; }
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      if (full === exclude) continue;
      if (++seen > SCAN_CAP) { capped = true; return; }
      let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const id of [...left]) if (text.includes(id)) left.delete(id);
    }
  };
  const st0 = (() => { try { return fs.statSync(root); } catch { return null; } })();
  if (!st0) return { error: `부르는 자리를 찾을 폴더가 없습니다: ${root}` };
  walk(st0.isDirectory() ? root : path.dirname(root));
  return { unused: [...left], scanned: seen, capped };
}

export function listFromSource(from) {
  const raw = String((from && from.source) || "").trim();
  const pick = String((from && from.pick) || "").trim();
  if (!raw || !pick) return { error:
    "from에는 source(파일)와 pick(찾을 규칙)이 둘 다 필요합니다.\n"
    + '  from: { source: "libs/…/notifier.service.ts", pick: "async (\\\\w+)\\\\(" }' };
  const file = raw.replace(/:\d+(-\d+)?$/, "");
  let re;
  try { re = new RegExp(pick, "g"); }
  catch (e) { return { error: `pick이 규칙이 아닙니다: ${pick} (${e.message})` }; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { error: `그 파일을 읽지 못했습니다: ${file}` }; }
  const items = [], seen = new Set();
  text.split("\n").forEach((line, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m[0] === "") { re.lastIndex += 1; continue; }
      const id = String(m[1] != null ? m[1] : m[0]).trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        items.push({ id, text: line.trim().slice(0, 200), at: `${file}:${i + 1}` });
      }
    }
  });
  if (!items.length) return { error:
    `그 규칙이 ${file}에서 아무것도 못 찾았습니다: ${pick}\n`
    + "0개짜리 목록은 완전한 목록과 구별되지 않습니다 — 규칙을 고치거나 items로 직접 적으세요." };
  const out = { items, from: { source: file, pick } };
  const usedIn = String((from && from.usedIn) || "").trim();
  if (usedIn) {
    const got = scanUsage(usedIn, items.map((x) => x.id), file);
    if (got.error) return got;
    const un = new Set(got.unused);
    for (const it of items) if (un.has(it.id)) it.unused = true;
    out.from.usedIn = usedIn;
    out.from.scanned = got.scanned;
    if (got.capped) out.from.capped = SCAN_CAP;
  }
  return out;
}

const NARRATIVE_TAIL = /(다|요)$/;
const NOUN_YO = /(필|중|개|수|주|소|강|동)요$/;

function narrativeSentences(text) {
  const bad = [];
  String(text == null ? "" : text)
    .split(/\n+/)
    .flatMap((para) => para.split(/(?<=[^0-9]\.|[?!])\s+/))
    .map((x) => x.trim()).filter(Boolean)
    .forEach((one) => {
      if (/[?？]\s*["'\u201d\u2019)\]]*$/.test(one)) return;
      const tail = one.replace(/["'\u201c\u201d\u2018\u2019)\]\s.。!?？]+$/u, "");
      if (NARRATIVE_TAIL.test(tail) && !NOUN_YO.test(tail)) bad.push(one);
    });
  return bad;
}

export function nominalFault(label, text) {
  const bad = narrativeSentences(text);
  if (!bad.length) return null;
  return `${label}: 보고서는 라벨체입니다. 종결어미를 붙이지 않습니다.\n`
    + bad.slice(0, 3).map((x) => `  서술형: ${x}`).join("\n")
    + (bad.length > 3 ? `\n  … 외 ${bad.length - 3}문장` : "")
    + "\n예: \"버튼이 안 눌렸다\" → \"버튼 미반응\" · \"사유가 비어 있다\" → \"사유 없음\"\n"
    + "-임·-함·-음 같은 명사형 어미도 종결어미입니다. 여기서는 -다·-요만 막지만 그것도 걷어냅니다.\n"
    + "근거 원문(quote)과 묻는 문장은 이 검사에서 빠집니다.\n"
    + "뜻이 깎이면 문장으로 되돌리지 말고 줄을 더 쌓습니다 — 한 줄에 한 사실입니다.\n"
    + "  \"구매자는 앱을 열어 직접 봐야 한다\"\n"
    + "  → \"구매자 알림 없음\" / \"확인 경로: 앱에서 내 중고거래 직접 열기\"";
}
