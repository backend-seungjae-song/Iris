// 엑셀·CSV를 화면이 그대로 그릴 수 있는 모양으로 바꾼다.
//
// 서버에서 처리하는 이유. 창으로 파일을 나르는 통로(fs.read)는 utf8 텍스트 전용이라 바이너리가
// 지나갈 수 없다. base64로 우겨 넣고 브라우저에서 파싱하면 파서(수백 KB)를 vendor에 또 넣어야
// 하고, 20MB 파일이 base64로 27MB가 되어 WS 한 프레임에 실린다. 파싱은 서버에서 끝내고 화면이
// 쓸 수 있는 것만 보낸다.
//
// 스타일은 셀마다 통째로 싣지 않는다. 표 하나에 같은 서식이 수천 번 반복되므로 스타일을 모아
// 두고 셀은 그 번호만 갖는다. 확인 결과 200×18 표에서 전송량이 1/8 아래로 줄었다.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

// 화면이 감당하는 상한. 넘으면 잘라서 보내고 잘랐다는 사실도 함께 알린다. 알리지 않으면
// 파일이 원래 그만큼이라고 오해한다.
const MAX_CELLS = 60000;
const MAX_ROWS = 5000;
const MAX_COLS = 200;

// ── 값 ──────────────────────────────────────────────────────────────────────
// exceljs가 돌려주는 값은 한 가지가 아니다. 문자열·숫자·Date·{formula,result}·{richText}·
// {hyperlink,text}·{error} 가 섞여 온다. 화면은 글자 하나만 받으면 되므로 여기서 하나로 만든다.
function plain(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  if (v.formula !== undefined || v.sharedFormula !== undefined) return plain(v.result);
  if (v.hyperlink !== undefined) return v.text != null ? plain(v.text) : v.hyperlink;
  if (v.error) return String(v.error);
  return String(v);
}

// 숫자 서식을 화면에 보이는 글자로 바꾼다. 엑셀의 서식 문법 전체를 구현하지 않는다. 실제로
// 쓰이는 퍼센트·천단위·통화·날짜만 맞추고 나머지는 값 그대로 둔다. 전체를 불완전하게
// 구현하면 잘못된 숫자를 보여준다.
function fmtNumber(n, numFmt) {
  if (typeof n !== "number") return String(n);
  const f = String(numFmt || "");
  if (!f || f === "General") return trimNum(n);
  const dec = (f.match(/\.(0+)/) || [, ""])[1].length;
  if (f.includes("%")) return (n * 100).toFixed(dec) + "%";
  const neg = n < 0;
  const abs = Math.abs(n);
  let s = f.includes("#,##") || f.includes("#,#")
    ? abs.toLocaleString("ko-KR", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : (dec ? abs.toFixed(dec) : trimNum(abs));
  if (/[₩¥]/.test(f)) s = "₩" + s;
  else if (f.includes("$")) s = "$" + s;
  // 괄호식 음수 표기(회계)
  if (neg) s = /\(.*\)/.test(f) ? "(" + s + ")" : "-" + s;
  if (/0\.0x|0x/i.test(f) && f.includes("x")) s += "x";
  return s;
}
function trimNum(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e10) / 1e10);
}
function fmtDate(d, numFmt) {
  const f = String(numFmt || "").toLowerCase();
  const p = (x) => String(x).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (f.includes("h")) return f.includes("y") || f.includes("m/d") ? `${ymd} ${hm}` : hm;
  return ymd;
}

// 글자와 함께 "숫자인가"를 돌려준다. 엑셀은 숫자를 오른쪽, 글자를 왼쪽에 붙이는데, 화면에서
// 다시 판정하면 "01012345678" 같은 글자 코드가 숫자로 보여 오른쪽에 붙는다.
function displayOf(cell) {
  // 수식 칸은 value.result가 아니라 cell.result에서 받는다. 결과가 0인 수식은 exceljs가
  // value 안에 result를 넣어주지 않아, value만 보면 0이 전부 빈칸으로 보인다(확인 결과).
  let raw = cell.value;
  if (cell.type === ExcelJS.ValueType.Formula) raw = cell.result !== undefined ? cell.result : (raw && raw.result);
  const v = plain(raw);
  if (v === "") return ["", 0];
  if (v instanceof Date) return [fmtDate(v, cell.numFmt), 1];
  if (typeof v === "number") return [fmtNumber(v, cell.numFmt), 1];
  if (typeof v === "boolean") return [v ? "TRUE" : "FALSE", 0];
  return [String(v), 0];
}

// ── 서식 ────────────────────────────────────────────────────────────────────
// argb(FFRRGGBB) → css. SpreadsheetML 작성기들은 직접 셀 색상을 `00RRGGBB`로도 저장하고
// Excel은 그 RGB를 보이게 그린다. `00`을 CSS alpha 0으로 옮기면 정상 글자·배경이 전부 사라진다.
// 01~FE의 명시적 중간 alpha만 보존한다. 테마색·인덱스색을 못 풀면 기본색으로 둔다.
function css(color) {
  if (!color) return null;
  const a = color.argb;
  if (!a || typeof a !== "string" || a.length < 6) return null;
  const hex = a.length === 8 ? a.slice(2) : a;
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const alpha = a.length === 8 ? parseInt(a.slice(0, 2), 16) / 255 : 1;
  if (alpha > 0 && alpha < 0.99) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }
  return "#" + hex.toLowerCase();
}

const BORDER_W = { hair: 1, thin: 1, dotted: 1, dashed: 1, medium: 2, thick: 3, double: 3 };
function borderSide(b) {
  if (!b || !b.style) return null;
  const w = BORDER_W[b.style] || 1;
  const style = b.style === "dotted" ? "dotted" : b.style === "dashed" ? "dashed" : b.style === "double" ? "double" : "solid";
  return `${w}px ${style} ${css(b.color) || "#d0d0d0"}`;
}

function styleOf(cell) {
  const s = {};
  const f = cell.font;
  if (f) {
    if (f.bold) s.b = 1;
    if (f.italic) s.i = 1;
    if (f.underline) s.u = 1;
    if (f.strike) s.st = 1;
    if (f.size) s.fs = f.size;
    if (f.name) s.ff = f.name;
    const c = css(f.color);
    if (c) s.c = c;
  }
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern !== "none") {
    const c = css(fill.fgColor);
    if (c) s.bg = c;
  }
  const a = cell.alignment;
  if (a) {
    if (a.horizontal) s.ha = a.horizontal;
    if (a.vertical) s.va = a.vertical;
    if (a.wrapText) s.wrap = 1;
    if (a.indent) s.ind = a.indent;
  }
  const bd = cell.border;
  if (bd) {
    const l = borderSide(bd.left), r = borderSide(bd.right), t = borderSide(bd.top), b = borderSide(bd.bottom);
    if (l) s.bl = l;
    if (r) s.br = r;
    if (t) s.bt = t;
    if (b) s.bb = b;
  }
  // 숫자 서식은 고칠 때 다시 쓴다. 값이 바뀌어도 화면이 같은 서식으로 다시 그려야 한다.
  const nf = cell.numFmt;
  if (nf && nf !== "General") s.nf = nf;
  return s;
}

// 사람이 칸에 직접 입력한 원본. 화면에 보이는 글자와 다를 때만 따로 보낸다. 수식 칸은
// 결과만 보이고 수식은 감춰져 있어, 이 값이 없으면 수정하는 순간 수식이 사라진다.
function sourceOf(cell) {
  if (cell.type === ExcelJS.ValueType.Formula) return "=" + (cell.formula || "");
  const v = plain(cell.value);
  if (v === "" || v == null) return "";
  if (v instanceof Date) {
    const p = (x) => String(x).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === "number") return trimNum(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

// 고를 수 있는 값(드롭다운). 엑셀은 목록을 "가,나,다" 한 덩어리로 넣거나 다른 칸을 가리킨다.
// 여기서는 한 덩어리로 적힌 것만 읽는다. 칸을 가리키는 목록까지 따라가면 시트 사이 참조가
// 끊겼을 때 잘못된 값을 선택할 수 있다.
function listOf(cell) {
  const dv = cell.dataValidation;
  if (!dv || dv.type !== "list") return null;
  const f = (dv.formulae || [])[0];
  if (typeof f !== "string") return null;
  const m = f.match(/^"(.*)"$/s);
  if (!m) return null;
  const opts = m[1].split(",").map((x) => x.trim()).filter((x) => x !== "");
  return opts.length ? opts : null;
}

// ── 조건부 서식 ────────────────────────────────────────────────────────────
// 값에 따라 칸 색이 바뀌는 규칙. 파일에 있는데 읽지 않으면 값을 골라도 화면은 흰 칸 그대로여서
// 원본과 다르게 보인다(확인 결과: 조건부 색이 전혀 표시되지 않았다).
// 규칙의 서식은 채우기·글자만 옮긴다. 조건부 서식이 실제로 쓰는 것이 그 둘이고, 테두리까지
// 반영하면 원래 칸 테두리와 겹쳐 잘못된 선이 생긴다.
function cfStyle(st) {
  const o = {};
  if (!st) return o;
  const f = st.fill;
  if (f && f.type === "pattern") {
    // 조건부 서식의 채우기는 bgColor에 들어온다(보통 서식은 fgColor).
    const c = css(f.bgColor) || css(f.fgColor);
    if (c) o.bg = c;
  }
  const fo = st.font;
  if (fo) {
    if (fo.bold) o.b = 1;
    if (fo.italic) o.i = 1;
    if (fo.underline) o.u = 1;
    if (fo.strike) o.st = 1;
    if (fo.size) o.fs = fo.size;
    if (fo.name) o.ff = fo.name;
    const c = css(fo.color);
    if (c) o.c = c;
  }
  if (st.numFmt) o.nf = st.numFmt;
  return o;
}

function readCF(ws) {
  const out = [];
  for (const g of ws.conditionalFormattings || []) {
    const rules = [];
    for (const r of g.rules || []) {
      const style = cfStyle(r.style);
      if (!Object.keys(style).length) continue;
      rules.push({
        t: r.type,
        op: r.operator || null,
        f: (r.formulae || []).slice(0, 2),
        text: r.text != null ? String(r.text) : null,
        p: r.priority || 0,
        s: style,
      });
    }
    if (rules.length) out.push({ ref: String(g.ref || ""), rules });
  }
  return out;
}

// 같은 서식은 한 번만 싣는다.
class StylePool {
  constructor() { this.list = []; this.index = new Map(); }
  add(style) {
    const keys = Object.keys(style);
    if (!keys.length) return 0;                     // 0번 = 서식 없음
    const k = JSON.stringify(style, keys.sort());
    let i = this.index.get(k);
    if (i === undefined) { this.list.push(style); i = this.list.length; this.index.set(k, i); }
    return i;
  }
}

// ── 엑셀 ────────────────────────────────────────────────────────────────────
function relationshipSource(relPath) {
  if (relPath === "_rels/.rels") return "";
  const m = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relPath);
  return m ? path.posix.join(m[1], m[2]) : null;
}

// OOXML 관계 대상은 패키지 루트 절대경로(`/xl/tables/...`)와 원본 part 기준 상대경로를 둘 다
// 허용한다. ExcelJS 4.4는 worksheet의 table 관계만 상대경로라고 가정해, 정상 파일도
// `undefined.name`에서 예외로 실패한다. 원본 파일은 수정하지 않고, 실패한 읽기용 메모리
// 복사본에서만 표준의 다른 표현인 상대경로로 바꾼다. 테이블 노드를 통째로 무시하면 열리기는
// 해도 저장 때 표 정의가 사라지므로 그렇게 하지 않는다.
async function normalizedRelationshipBuffer(filePath) {
  const input = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(input);
  let changed = false;
  for (const relPath of Object.keys(zip.files)) {
    if (!relPath.endsWith(".rels")) continue;
    const source = relationshipSource(relPath);
    if (source === null) continue;
    const entry = zip.file(relPath);
    if (!entry) continue;
    const xml = await entry.async("string");
    const base = source ? path.posix.dirname(source) : ".";
    const next = xml.replace(/<Relationship\b[^>]*>/g, (relationship) => {
      if (/\bTargetMode=(["'])External\1/.test(relationship)) return relationship;
      return relationship.replace(/\bTarget=(["'])\/([^"']+)\1/, (whole, quote, target) => {
        const relative = path.posix.relative(base, target);
        if (!relative) return whole;
        changed = true;
        return `Target=${quote}${relative}${quote}`;
      });
    });
    if (next !== xml) zip.file(relPath, next);
  }
  return changed ? await zip.generateAsync({ type: "nodebuffer" }) : null;
}

async function loadWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
    return workbook;
  } catch (originalError) {
    const normalized = await normalizedRelationshipBuffer(filePath);
    if (!normalized) throw originalError;
    const retry = new ExcelJS.Workbook();
    await retry.xlsx.load(normalized);
    return retry;
  }
}

export async function readWorkbook(filePath) {
  const wb = await loadWorkbook(filePath);

  const pool = new StylePool();
  const lists = new StylePool();     // 드롭다운 목록도 같은 서식이 수백 칸에 반복된다
  const sheets = [];
  let budget = MAX_CELLS;

  for (const ws of wb.worksheets) {
    if (ws.state === "veryHidden") continue;

    const dim = ws.dimensions && ws.dimensions.model;
    let nRows = Math.max(ws.rowCount || 0, dim ? dim.bottom : 0);
    let nCols = Math.max(ws.columnCount || 0, dim ? dim.right : 0);
    const cutRows = nRows > MAX_ROWS, cutCols = nCols > MAX_COLS;
    nRows = Math.min(nRows, MAX_ROWS);
    nCols = Math.min(nCols, MAX_COLS);

    const cells = {};       // "r,c" → [글자, 스타일번호]
    const src = {};         // "r,c" → 사람이 쳐 넣은 원본(보이는 글자와 다를 때만)
    const dv = {};          // "r,c" → 고를 수 있는 값 목록의 번호
    const note = {};        // "r,c" → 메모 글자
    let cut = cutRows || cutCols;

    ws.eachRow({ includeEmpty: true }, (row, r) => {
      if (r > nRows) return;
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        if (c > nCols) return;
        if (budget <= 0) { cut = true; return; }
        const key = r + "," + c;
        const opts = listOf(cell);
        if (opts) dv[key] = lists.add(opts);
        let noteText = "";
        if (cell.note) noteText = typeof cell.note === "string" ? cell.note : (cell.note.texts || []).map((x) => x.text || "").join("");
        if (noteText) note[key] = noteText;
        const [text, isNum] = displayOf(cell);
        const si = pool.add(styleOf(cell));
        const s = sourceOf(cell);
        if (s !== "" && s !== text) src[key] = s;
        if (text === "" && si === 0 && !noteText) return; // 빈 칸이고 서식·메모도 없으면 보내지 않는다
        cells[key] = isNum ? [text, si, 1] : (si ? [text, si] : [text]);
        budget--;
      });
    });

    // 열 너비는 엑셀 문자 단위다. 화면 픽셀로 옮긴다(엑셀 기본 8.43자 ≈ 64px 기준).
    const cols = [];
    for (let c = 1; c <= nCols; c++) {
      const w = ws.getColumn(c).width;
      cols.push(w ? Math.round(w * 7.5 + 5) : 80);
    }
    const rows = [];
    for (let r = 1; r <= nRows; r++) {
      const h = ws.getRow(r).height;
      rows.push(h ? Math.round(h * 1.34) : 0);       // 0 = 기본 높이(화면이 정한다)
    }

    // 셀 안에 삽입된(floating) 그림만 다룬다. 시트 배경 그림(addBackgroundImage)은 별개다.
    // exceljs는 디스크에서 읽은 그림을 buffer로 주고, 이번 세션에 addImage로 추가한 것만
    // base64로 준다. 두 형식을 모두 처리해야 방금 저장한 파일을 다시 열 때도 그림이 표시된다.
    const images = [];
    for (const img of ws.getImages()) {
      const media = wb.getImage(img.imageId);
      if (!media) continue;
      const dataUrl = media.base64 || (media.buffer ? `data:image/${media.extension};base64,${Buffer.from(media.buffer).toString("base64")}` : null);
      if (!dataUrl) continue;
      const tl = img.range.tl, ext = img.range.ext;
      if (!tl || !ext) continue;
      images.push({ r: tl.nativeRow + 1, c: tl.nativeCol + 1, w: Math.round(ext.width), h: Math.round(ext.height), dataUrl });
    }

    const view = (ws.views && ws.views[0]) || {};
    sheets.push({
      name: ws.name,
      rows: nRows,
      colsCount: nCols,
      col: cols,
      row: rows,
      merges: (ws.model && ws.model.merges) || [],
      freeze: view.state === "frozen" ? { x: view.xSplit || 0, y: view.ySplit || 0 } : null,
      grid: view.showGridLines !== false,
      hidden: ws.state === "hidden",
      cells,
      src,
      dv,
      note,
      images,
      cf: readCF(ws),
      cut,
    });
  }

  const definedNames = (wb.definedNames && wb.definedNames.model) || [];
  return { kind: "xlsx", styles: pool.list, lists: lists.list, sheets, definedNames };
}

// ── CSV·TSV ────────────────────────────────────────────────────────────────
// 따옴표 안의 쉼표와 줄바꿈, 그리고 "" 이스케이프를 지킨다. 이것을 안 지키면 주소나 문장이 든
// 실제 파일에서 칸이 밀린다.
export function parseSeparated(text, sep) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function readSeparated(filePath, sep) {
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // BOM
  const raw = parseSeparated(text, sep);
  const cut = raw.length > MAX_ROWS;
  const rowsArr = raw.slice(0, MAX_ROWS);
  const nCols = Math.min(rowsArr.reduce((m, r) => Math.max(m, r.length), 0), MAX_COLS);

  const cells = {};
  rowsArr.forEach((r, ri) => {
    for (let ci = 0; ci < Math.min(r.length, nCols); ci++) {
      const v = r[ci];
      if (v !== "") cells[(ri + 1) + "," + (ci + 1)] = [v];
    }
  });

  return {
    kind: "csv",
    styles: [],
    lists: [],
    sheets: [{
      src: {},
      dv: {},
      cf: [],
      name: sep === "\t" ? "TSV" : "CSV",
      rows: rowsArr.length,
      colsCount: nCols,
      col: new Array(nCols).fill(120),
      row: new Array(rowsArr.length).fill(0),
      merges: [],
      freeze: null,
      grid: true,
      cells,
      cut,
    }],
  };
}

// ── 고쳐 쓰기 ───────────────────────────────────────────────────────────────
// 원본을 다시 열어 바뀐 칸만 교체하고 저장한다. 새 파일을 만들어 덮어쓰지 않는다. 그러면
// 서식·병합·고정·드롭다운·다른 시트가 모두 사라진다. exceljs는 읽은 내용을 그대로 다시 쓰므로
// 수정하지 않은 부분은 그대로 남는다.
//
// 수식은 결과까지 함께 받아 적는다. exceljs는 수식만 쓰면 계산해 둔 값을 비워 두는데, 그러면
// 엑셀·미리보기·이 뷰어가 다시 열 때 그 칸이 빈칸으로 보인다(확인 결과: 결과 없는 수식은 빈칸).
function coerce(sv, result) {
  const s = sv == null ? "" : String(sv);
  if (s === "") return null;
  if (s[0] === "=") {
    const f = s.slice(1);
    return result === undefined || result === null ? { formula: f } : { formula: f, result };
  }
  // 숫자로 보이는 글자는 숫자로 넣는다. 글자로 넣으면 합계·개수 수식이 그 칸을 계산에 포함하지 않는다.
  // 다만 0으로 시작하는 코드(01012345678)와 자릿수가 넘치는 것은 글자 그대로 둔다.
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s) && s.replace(/\D/g, "").length <= 15) return Number(s);
  if (/^-?\d+(\.\d+)?%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return s;
}

// 화면이 쓰는 서식 표기를 exceljs 형식으로 되돌린다. 복원할 수 있는 것만 복원한다.
// 테두리는 화면에서 css 문자열로 합쳐져 원래 선 종류를 복원할 수 없으므로 건드리지 않는다.
function applyStyle(cell, s) {
  const argb = (c) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c || ""));
    return m ? "FF" + m[1].toUpperCase() : null;
  };
  const font = Object.assign({}, cell.font || {});
  font.bold = !!s.b; font.italic = !!s.i; font.underline = !!s.u; font.strike = !!s.st;
  if (s.fs) font.size = s.fs;
  if (s.ff) font.name = s.ff;
  const fc = argb(s.c);
  if (fc) font.color = { argb: fc }; else delete font.color;
  cell.font = font;
  const al = Object.assign({}, cell.alignment || {});
  if (s.ha) al.horizontal = s.ha; else delete al.horizontal;
  if (s.va) al.vertical = s.va; else delete al.vertical;
  al.wrapText = !!s.wrap;
  if (s.ind) al.indent = s.ind; else delete al.indent;
  cell.alignment = al;
  const bg = argb(s.bg);
  if (bg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
  if (s.nf) cell.numFmt = s.nf;
}

// 행·열 삽입 시 병합 범위(A1 표기)를 직접 옮긴다. exceljs 문서가 splice로 병합을 옮기면
// 결과를 예측할 수 없다고 밝히고 있다(README Columns/Rows 절). splice 전에 병합을 모두 풀고
// 옮긴 좌표로 다시 합친다.
function numToCol(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }
function colToNum(s) { let c = 0; for (const ch of s) c = c * 26 + (ch.charCodeAt(0) - 64); return c; }
function parseRange(range) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  return { c1: colToNum(m[1]), r1: Number(m[2]), c2: colToNum(m[3]), r2: Number(m[4]) };
}
// 삽입 지점 이전은 그대로, 지점이 범위 안이면 그만큼 늘어나고, 지점이 시작보다 앞이면 통째로 밀린다.
function shiftRange(range, axis, at, count) {
  const p = parseRange(range); if (!p) return range;
  if (axis === "row") {
    if (at <= p.r1) { p.r1 += count; p.r2 += count; }
    else if (at <= p.r2) { p.r2 += count; }
  } else {
    if (at <= p.c1) { p.c1 += count; p.c2 += count; }
    else if (at <= p.c2) { p.c2 += count; }
  }
  return numToCol(p.c1) + p.r1 + ":" + numToCol(p.c2) + p.r2;
}
// 데이터 검증(드롭다운)도 병합과 같은 이유로 직접 옮긴다. splice는 셀 값·서식만 옮기고
// ws.dataValidations는 절대 주소(A1)로 따로 있어 갱신하지 않으면 그대로 남는다(확인 결과:
// 행을 삽입하면 드롭다운이 원래 위치에 남아, 그 자리로 밀려온 다른 칸에 적용됐다).
function shiftCellRef(addr, axis, at, count) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!m) return addr;
  let c = colToNum(m[1]), r = Number(m[2]);
  if (axis === "row" && at <= r) r += count;
  if (axis === "col" && at <= c) c += count;
  return numToCol(c) + r;
}
// 삭제는 삽입의 반대 방향이다. 지운 구간 안이면 사라지고(null), 뒤쪽이면 그만큼 당겨진다.
function shiftRangeDelete(range, axis, at, count) {
  const p = parseRange(range); if (!p) return null;
  const end = at + count - 1;
  if (axis === "row") {
    if (p.r1 >= at && p.r2 <= end) return null;
    if (p.r1 > end) { p.r1 -= count; p.r2 -= count; }
    else if (p.r2 >= at) { if (p.r1 < at) p.r2 -= Math.min(count, p.r2 - at + 1); else { p.r1 = at; p.r2 -= count; } }
  } else {
    if (p.c1 >= at && p.c2 <= end) return null;
    if (p.c1 > end) { p.c1 -= count; p.c2 -= count; }
    else if (p.c2 >= at) { if (p.c1 < at) p.c2 -= Math.min(count, p.c2 - at + 1); else { p.c1 = at; p.c2 -= count; } }
  }
  return numToCol(p.c1) + p.r1 + ":" + numToCol(p.c2) + p.r2;
}
function shiftCellRefDelete(addr, axis, at, count) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr); if (!m) return addr;
  let c = colToNum(m[1]), r = Number(m[2]);
  const end = at + count - 1;
  if (axis === "row") { if (r >= at && r <= end) return null; if (r > end) r -= count; }
  else { if (c >= at && c <= end) return null; if (c > end) c -= count; }
  return numToCol(c) + r;
}

// 겹치지 않는 이름을 고른다. "새 시트"가 이미 있으면 "새 시트 2", "새 시트 3" 순으로 붙인다.
function uniqueSheetName(wb, base) {
  if (!wb.getWorksheet(base)) return base;
  for (let i = 2; ; i++) { const name = `${base} ${i}`; if (!wb.getWorksheet(name)) return name; }
}

export async function writeWorkbook(filePath, edits) {
  const wb = await loadWorkbook(filePath);
  let n = 0;
  for (const e of edits) {
    if (e.newSheet !== undefined) {
      wb.addWorksheet(uniqueSheetName(wb, e.newSheet || "새 시트"));
      n++;
      continue;
    }
    if (e.definedName) {
      wb.definedNames.add(`${e.sheet}!${e.definedName.range}`, e.definedName.name);
      n++;
      continue;
    }
    if (e.removeDefinedName) {
      wb.definedNames.remove(e.removeDefinedName.range, e.removeDefinedName.name);
      n++;
      continue;
    }
    const ws = wb.getWorksheet(e.sheet);
    if (!ws) throw new Error(`시트를 찾지 못했습니다: ${e.sheet}`);
    if (e.rename !== undefined) {
      const name = uniqueSheetName(wb, e.rename);
      ws.name = name;
      n++;
      continue;
    }
    if (e.duplicate) {
      const clone = JSON.parse(JSON.stringify(ws.model));
      const nsheet = wb.addWorksheet(uniqueSheetName(wb, `${ws.name} 사본`));
      clone.id = nsheet.id; clone.name = nsheet.name;
      nsheet.model = clone;
      n++;
      continue;
    }
    if (e.removeSheet) {
      wb.removeWorksheet(ws.id);
      n++;
      continue;
    }
    if (e.merge) {
      const existing = [...((ws.model && ws.model.merges) || [])];
      for (const range of existing) ws.unMergeCells(range);
      for (const range of e.merge.ranges) ws.mergeCells(range);
      n++;
      continue;
    }
    if (e.freeze !== undefined) {
      const v = (ws.views && ws.views[0]) || {};
      const x = (e.freeze && e.freeze.x) || 0, y = (e.freeze && e.freeze.y) || 0;
      v.state = x || y ? "frozen" : "normal";
      v.xSplit = x; v.ySplit = y;
      ws.views = [v];
      n++;
      continue;
    }
    if (e.grid !== undefined) {
      const v = (ws.views && ws.views[0]) || {};
      v.showGridLines = !!e.grid;
      ws.views = [v];
      n++;
      continue;
    }
    if (e.hidden !== undefined) {
      ws.state = e.hidden ? "hidden" : "visible";
      n++;
      continue;
    }
    if (e.dv) {
      ws.dataValidations.add(e.dv.range, { type: "list", allowBlank: true, formulae: [`"${e.dv.values.join(",")}"`] });
      n++;
      continue;
    }
    if (e.note !== undefined) {
      const cell = ws.getRow(e.note.r).getCell(e.note.c);
      // exceljs는 값·서식이 전혀 없는 빈 칸에 메모만 달면 저장 시 그 메모를 누락한다
      // (확인 결과: 4.4.0). 빈 문자열 값을 줘 그 칸이 실제로 존재하게 만들면 유지된다.
      if (cell.value == null || cell.value === "") cell.value = "";
      cell.note = e.note.text || undefined;
      n++;
      continue;
    }
    if (e.image) {
      const imgId = wb.addImage({ base64: e.image.dataUrl, extension: e.image.extension });
      ws.addImage(imgId, { tl: { col: e.image.c - 1, row: e.image.r - 1 }, ext: { width: e.image.width, height: e.image.height } });
      n++;
      continue;
    }
    if (e.insert) {
      const { axis, at, count } = e.insert;
      const merges = [...((ws.model && ws.model.merges) || [])];
      for (const range of merges) { try { ws.unMergeCells(range); } catch {} }
      const dvEntries = Object.entries((ws.dataValidations && ws.dataValidations.model) || {});
      for (const [addr] of dvEntries) ws.dataValidations.remove(addr);
      const blanks = Array(count).fill([]);
      if (axis === "row") ws.spliceRows(at, 0, ...blanks); else ws.spliceColumns(at, 0, ...blanks);
      for (const range of merges) { try { ws.mergeCells(shiftRange(range, axis, at, count)); } catch {} }
      for (const [addr, dv] of dvEntries) ws.dataValidations.add(shiftCellRef(addr, axis, at, count), dv);
      const v = ws.views && ws.views[0];
      if (v && v.state === "frozen") {
        if (axis === "row" && at <= (v.ySplit || 0)) v.ySplit = (v.ySplit || 0) + count;
        if (axis === "col" && at <= (v.xSplit || 0)) v.xSplit = (v.xSplit || 0) + count;
      }
      n++;
      continue;
    }
    if (e.delete) {
      const { axis, at, count } = e.delete;
      const merges = [...((ws.model && ws.model.merges) || [])];
      for (const range of merges) { try { ws.unMergeCells(range); } catch {} }
      const dvEntries = Object.entries((ws.dataValidations && ws.dataValidations.model) || {});
      for (const [addr] of dvEntries) ws.dataValidations.remove(addr);
      if (axis === "row") ws.spliceRows(at, count); else ws.spliceColumns(at, count);
      for (const range of merges) { const shifted = shiftRangeDelete(range, axis, at, count); if (shifted) { try { ws.mergeCells(shifted); } catch {} } }
      for (const [addr, dv] of dvEntries) { const shifted = shiftCellRefDelete(addr, axis, at, count); if (shifted) ws.dataValidations.add(shifted, dv); }
      const v = ws.views && ws.views[0];
      if (v && v.state === "frozen") {
        if (axis === "row" && (v.ySplit || 0) >= at) v.ySplit = Math.max(0, (v.ySplit || 0) - Math.min(count, (v.ySplit || 0) - at + 1));
        if (axis === "col" && (v.xSplit || 0) >= at) v.xSplit = Math.max(0, (v.xSplit || 0) - Math.min(count, (v.xSplit || 0) - at + 1));
      }
      n++;
      continue;
    }
    // 열 폭·행 높이. 화면은 픽셀로 재고 엑셀은 글자 수·포인트로 재므로 읽을 때 쓴 비율로 되돌린다.
    if (e.layout) {
      if (e.layout.kind === "c") ws.getColumn(e.layout.i).width = Math.max(1, (e.layout.px - 5) / 7.5);
      else ws.getRow(e.layout.i).height = Math.max(6, e.layout.px / 1.34);
      n++;
      continue;
    }
    const cell = ws.getRow(e.r).getCell(e.c);
    if (e.style) { applyStyle(cell, e.style); if (e.v === undefined) { n++; continue; } }
    const nf = cell.numFmt, style = cell.style;
    cell.value = coerce(e.v, e.result);
    // 값을 갈아 끼우면 exceljs가 서식을 초기화하는 경로가 있다. 원래 서식을 되돌려 놓는다.
    if (style) cell.style = style;
    if (nf) cell.numFmt = nf;
    n++;
  }
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    await wb.xlsx.writeFile(tmpPath);
    try { fs.chmodSync(tmpPath, fs.statSync(filePath).mode); } catch {}
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
  return n;
}

// csv·tsv는 서식이 없으니 통째로 다시 쓴다. 원본의 줄 수·칸 수를 그대로 유지하고 바뀐 칸만 넣는다.
export function writeSeparated(filePath, sep, edits) {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const rows = parseSeparated(text, sep);
  for (const e of edits) {
    if (e.insert) {
      const { axis, at, count } = e.insert;
      if (axis === "row") {
        // 다른 줄과 칸 수를 맞춘다. 맞추지 않으면 그 줄만 칸 없는 빈 줄(",,"가 아니라 "")이 된다.
        const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
        for (let i = 0; i < count; i++) rows.splice(at - 1 + i, 0, Array(width).fill(""));
      } else {
        for (const row of rows) for (let i = 0; i < count; i++) row.splice(at - 1 + i, 0, "");
      }
      continue;
    }
    if (e.delete) {
      const { axis, at, count } = e.delete;
      if (axis === "row") rows.splice(at - 1, count);
      else for (const row of rows) row.splice(at - 1, count);
      continue;
    }
    while (rows.length < e.r) rows.push([]);
    const row = rows[e.r - 1];
    while (row.length < e.c) row.push("");
    row[e.c - 1] = e.v == null ? "" : String(e.v);
  }
  const q = (v) => (new RegExp(`["\\n\\r${sep === "\t" ? "\\t" : ","}]`).test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out = rows.map((r) => r.map((v) => q(String(v == null ? "" : v))).join(sep)).join("\n");
  fs.writeFileSync(filePath, (bom ? "﻿" : "") + out, "utf8");
  return edits.length;
}

const XLSX_RE = /\.(xlsx|xlsm)$/i;
const CSV_RE = /\.csv$/i;
const TSV_RE = /\.(tsv|tab)$/i;

export const isSheetPath = (p) => XLSX_RE.test(p) || CSV_RE.test(p) || TSV_RE.test(p);
export const supportsSheetMerges = (p) => XLSX_RE.test(p);

// 파일 메뉴 "새 문서"용. 빈 파일(0바이트)은 유효한 xlsx가 아니어서 열면 손상 오류가 나므로,
// 빈 워크북을 새로 만들어 저장한다.
export async function createBlankWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1");
  await wb.xlsx.writeFile(filePath);
}

export async function readSheet(filePath) {
  if (XLSX_RE.test(filePath)) return await readWorkbook(filePath);
  if (TSV_RE.test(filePath)) return readSeparated(filePath, "\t");
  return readSeparated(filePath, ",");
}

export async function writeSheet(filePath, edits) {
  if (!Array.isArray(edits) || !edits.length) return 0;
  if (edits.some((e) => e && e.merge) && !supportsSheetMerges(filePath)) throw new Error("이 표 형식은 셀 병합을 지원하지 않습니다");
  if (XLSX_RE.test(filePath)) return await writeWorkbook(filePath, edits);
  if (TSV_RE.test(filePath)) return writeSeparated(filePath, "\t", edits);
  return writeSeparated(filePath, ",", edits);
}
