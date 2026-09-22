// 시트 수식: 셀 원문을 토큰화·계산하고 표시값으로 다시 적는다.
//
// 소유 범위
//   수식 토큰화와 파싱, 함수 표, 셀 값 캐시·순환 참조 차단, 숫자 서식, workbook 재계산.
//
// 제공 API
//   initSheetFormula(): 기존 선언 위치를 보존하는 초기화 경계. 런타임 부작용은 없다.
//   svErr, svA1, svTok, svTruth, svParse, svCellVal, svLit, svFmtNum, svRecalc.
//
// 의존 대상
//   sheet/model.js의 svStyles와 svSrcAt만 import한다.
//
// 유지 조건
//   모르는 함수는 #NAME?로, 순환 참조는 #REF!로 드러내고 조용히 숫자로 바꾸지 않는다.
//   수식 계산 결과와 셀 style index를 함께 보존하며, 입력 원문은 model의 svSrcAt으로 읽는다.
//
// 영향 범위
//   sheet/conditional.js, main의 시트 렌더·편집·저장·복사·정렬·채우기 경로.
//
// model ← formula 방향만 유지한다. 반대 import는 만들지 않는다.
import { svStyles, svSrcAt } from "./model.js";

export function initSheetFormula() {}

// ── 수식 ────────────────────────────────────────────────────────────────────
// 파일에 든 수식을 여기서 다시 계산한다. 안 하면 값을 하나 고쳐도 합계·개수 칸이 파일에
// 적혀 있던 이전 결과를 그대로 유지해, 고치는 사람은 자기가 뭘 바꿨는지 알 수 없다.
// 엑셀 함수를 모두 구현하지는 않는다. 실제로 쓰이는 것만 맞추고, 모르는 이름은 #NAME?로 남겨
// 계산하지 못했음을 드러낸다. 0을 대신 넣으면 틀린 숫자를 그대로 믿게 된다.
const SV_ERRS = ["#REF!", "#NAME?", "#DIV/0!", "#VALUE!", "#N/A", "#NUM!", "#NULL!"];
export const svErr = (v) => typeof v === "string" && SV_ERRS.includes(v);

export function svA1(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), c];
}

export function svTok(s) {
  const out = []; let i = 0;
  const dig = (ch) => ch >= "0" && ch <= "9";
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === '"') {
      let j = i + 1, v = "";
      while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; } v += s[j++]; }
      out.push({ t: "str", v }); i = j + 1; continue;
    }
    if (dig(ch) || (ch === "." && dig(s[i + 1]))) {
      let j = i;
      while (j < s.length && (dig(s[j]) || s[j] === ".")) j++;
      if ((s[j] === "e" || s[j] === "E") && (dig(s[j + 1]) || ((s[j + 1] === "+" || s[j + 1] === "-") && dig(s[j + 2])))) { j += 2; while (j < s.length && dig(s[j])) j++; }
      out.push({ t: "num", v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (ch === "'") {                                  // '시트 이름'!A1
      let j = i + 1, name = "";
      while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { name += "'"; j += 2; continue; } break; } name += s[j++]; }
      j++;
      const m = s[j] === "!" && /^\$?[A-Za-z]{1,3}\$?\d+/.exec(s.slice(j + 1));
      if (m) { out.push({ t: "ref", sheet: name, a: m[0] }); i = j + 1 + m[0].length; continue; }
      out.push({ t: "bad" }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const w = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(s.slice(i))[0];
      let j = i + w.length;
      const m = s[j] === "!" && /^\$?[A-Za-z]{1,3}\$?\d+/.exec(s.slice(j + 1));
      if (m) { out.push({ t: "ref", sheet: w, a: m[0] }); i = j + 1 + m[0].length; continue; }
      if (s[j] === "(") { out.push({ t: "fn", v: w.toUpperCase().replace(/^_XLFN\./, "") }); i = j; continue; }
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(w)) { out.push({ t: "ref", a: w }); i = j; continue; }
      const U = w.toUpperCase();
      if (U === "TRUE" || U === "FALSE") { out.push({ t: "bool", v: U === "TRUE" }); i = j; continue; }
      out.push({ t: "name", v: w }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>(),:%;".indexOf(ch) >= 0) { out.push({ t: "op", v: ch === ";" ? "," : ch }); i++; continue; }
    i++;
  }
  return out;
}

// 범위는 {rows:[[값…]…]} 형태로 전달한다. 개수·합계 함수가 조건 범위와 합계 범위를 같은 순서로 순회해야
// 해서, 평탄화한 배열만으로는 모양이 다른 두 범위를 짝지을 수 없다.
const svIsRange = (v) => v && typeof v === "object" && v.__rows;
function svFlat(v) { return svIsRange(v) ? [].concat.apply([], v.__rows) : [v]; }
function svOne(v) { if (!svIsRange(v)) return v; const f = svFlat(v); return f.length ? f[0] : ""; }

function svNum(v) {
  v = svOne(v);
  if (v === "" || v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (svErr(v)) return v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : "#VALUE!";
}
function svStr(v) {
  v = svOne(v);
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

// 조건(">=5", "<>통과", "사과", "사과*")을 하나의 판정 함수로 바꾼다.
function svCrit(c) {
  c = svOne(c);
  const s = c == null ? "" : String(c);
  const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(s);
  const op = m ? m[1] : "=", raw = m ? m[2] : s;
  const rn = raw === "" ? null : Number(raw);
  const isN = raw !== "" && Number.isFinite(rn);
  const wild = op === "=" || op === "<>" ? /[*?]/.test(raw) : false;
  const re = wild ? new RegExp("^" + raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  return (v) => {
    if (svIsRange(v)) v = svOne(v);
    if (re) { const hit = re.test(String(v == null ? "" : v)); return op === "<>" ? !hit : hit; }
    let a = v, b = raw;
    if (isN) { a = typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/,/g, "")); b = rn; if (!Number.isFinite(a)) a = NaN; }
    else { a = String(v == null ? "" : v).toLowerCase(); b = String(raw).toLowerCase(); }
    switch (op) {
      case "=": return a === b;
      case "<>": return a !== b;
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      case ">=": return a >= b;
    }
    return false;
  };
}

// 함수들. 이름은 엑셀 그대로. 여기 없는 이름은 #NAME?가 되어 화면에 그대로 보인다.
const SV_FN = {
  SUM: (a) => a.reduce((s, x) => { const f = svFlat(x); for (const v of f) { const n = typeof v === "number" ? v : (typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null); if (n != null) s += n; } return s; }, 0),
  PRODUCT: (a) => { let p = 1; for (const x of a) for (const v of svFlat(x)) if (typeof v === "number") p *= v; return p; },
  COUNT: (a) => a.reduce((n, x) => n + svFlat(x).filter((v) => typeof v === "number" || (typeof v === "string" && v !== "" && Number.isFinite(Number(v)))).length, 0),
  COUNTA: (a) => a.reduce((n, x) => n + svFlat(x).filter((v) => v !== "" && v != null).length, 0),
  COUNTBLANK: (a) => svFlat(a[0]).filter((v) => v === "" || v == null).length,
  AVERAGE: (a) => { const v = [].concat.apply([], a.map(svFlat)).filter((x) => typeof x === "number"); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : "#DIV/0!"; },
  MEDIAN: (a) => { const v = [].concat.apply([], a.map(svFlat)).filter((x) => typeof x === "number").sort((x, y) => x - y); if (!v.length) return "#NUM!"; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
  MIN: (a) => { const v = [].concat.apply([], a.map(svFlat)).filter((x) => typeof x === "number"); return v.length ? Math.min.apply(null, v) : 0; },
  MAX: (a) => { const v = [].concat.apply([], a.map(svFlat)).filter((x) => typeof x === "number"); return v.length ? Math.max.apply(null, v) : 0; },
  COUNTIF: (a) => { const f = svCrit(a[1]); return svFlat(a[0]).filter(f).length; },
  COUNTIFS: (a) => { const rs = [], fs = []; for (let i = 0; i + 1 < a.length; i += 2) { rs.push(svFlat(a[i])); fs.push(svCrit(a[i + 1])); } const n = rs[0] ? rs[0].length : 0; let c = 0; for (let i = 0; i < n; i++) if (rs.every((r, k) => fs[k](r[i]))) c++; return c; },
  SUMIF: (a) => { const r = svFlat(a[0]), f = svCrit(a[1]), s = a[2] !== undefined ? svFlat(a[2]) : r; let x = 0; for (let i = 0; i < r.length; i++) if (f(r[i]) && typeof s[i] === "number") x += s[i]; return x; },
  SUMIFS: (a) => { const s = svFlat(a[0]), rs = [], fs = []; for (let i = 1; i + 1 < a.length; i += 2) { rs.push(svFlat(a[i])); fs.push(svCrit(a[i + 1])); } let x = 0; for (let i = 0; i < s.length; i++) if (rs.every((r, k) => fs[k](r[i])) && typeof s[i] === "number") x += s[i]; return x; },
  AVERAGEIF: (a) => { const r = svFlat(a[0]), f = svCrit(a[1]), s = a[2] !== undefined ? svFlat(a[2]) : r; const v = []; for (let i = 0; i < r.length; i++) if (f(r[i]) && typeof s[i] === "number") v.push(s[i]); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : "#DIV/0!"; },
  IF: (a) => (svTruth(a[0]) ? (a[1] === undefined ? true : svOne(a[1])) : (a[2] === undefined ? false : svOne(a[2]))),
  IFS: (a) => { for (let i = 0; i + 1 < a.length; i += 2) if (svTruth(a[i])) return svOne(a[i + 1]); return "#N/A"; },
  IFERROR: (a) => (svErr(svOne(a[0])) ? svOne(a[1]) : svOne(a[0])),
  IFNA: (a) => (svOne(a[0]) === "#N/A" ? svOne(a[1]) : svOne(a[0])),
  AND: (a) => [].concat.apply([], a.map(svFlat)).every(svTruth),
  OR: (a) => [].concat.apply([], a.map(svFlat)).some(svTruth),
  NOT: (a) => !svTruth(a[0]),
  ABS: (a) => Math.abs(svNum(a[0])),
  INT: (a) => Math.floor(svNum(a[0])),
  SQRT: (a) => Math.sqrt(svNum(a[0])),
  MOD: (a) => { const d = svNum(a[1]); return d === 0 ? "#DIV/0!" : svNum(a[0]) - d * Math.floor(svNum(a[0]) / d); },
  POWER: (a) => Math.pow(svNum(a[0]), svNum(a[1])),
  ROUND: (a) => { const d = a[1] === undefined ? 0 : svNum(a[1]); const p = Math.pow(10, d); return Math.round(svNum(a[0]) * p) / p; },
  ROUNDUP: (a) => { const d = a[1] === undefined ? 0 : svNum(a[1]); const p = Math.pow(10, d); const n = svNum(a[0]); return (n < 0 ? -1 : 1) * Math.ceil(Math.abs(n) * p) / p; },
  ROUNDDOWN: (a) => { const d = a[1] === undefined ? 0 : svNum(a[1]); const p = Math.pow(10, d); const n = svNum(a[0]); return (n < 0 ? -1 : 1) * Math.floor(Math.abs(n) * p) / p; },
  LEN: (a) => svStr(a[0]).length,
  LEFT: (a) => svStr(a[0]).slice(0, a[1] === undefined ? 1 : svNum(a[1])),
  RIGHT: (a) => { const n = a[1] === undefined ? 1 : svNum(a[1]); return n <= 0 ? "" : svStr(a[0]).slice(-n); },
  MID: (a) => svStr(a[0]).substr(svNum(a[1]) - 1, svNum(a[2])),
  TRIM: (a) => svStr(a[0]).trim().replace(/\s+/g, " "),
  UPPER: (a) => svStr(a[0]).toUpperCase(),
  LOWER: (a) => svStr(a[0]).toLowerCase(),
  CONCATENATE: (a) => a.map(svStr).join(""),
  CONCAT: (a) => [].concat.apply([], a.map(svFlat)).map((v) => (v == null ? "" : String(v))).join(""),
  TEXTJOIN: (a) => { const sep = svStr(a[0]), skip = svTruth(a[1]); const v = [].concat.apply([], a.slice(2).map(svFlat)).map((x) => (x == null ? "" : String(x))); return (skip ? v.filter((x) => x !== "") : v).join(sep); },
  SUBSTITUTE: (a) => svStr(a[0]).split(svStr(a[1])).join(svStr(a[2])),
  FIND: (a) => { const i = svStr(a[1]).indexOf(svStr(a[0]), a[2] === undefined ? 0 : svNum(a[2]) - 1); return i < 0 ? "#VALUE!" : i + 1; },
  SEARCH: (a) => { const i = svStr(a[1]).toLowerCase().indexOf(svStr(a[0]).toLowerCase(), a[2] === undefined ? 0 : svNum(a[2]) - 1); return i < 0 ? "#VALUE!" : i + 1; },
  ISBLANK: (a) => { const v = svOne(a[0]); return v === "" || v == null; },
  ISNUMBER: (a) => typeof svOne(a[0]) === "number",
  ISTEXT: (a) => typeof svOne(a[0]) === "string" && !svErr(svOne(a[0])),
  ISERROR: (a) => svErr(svOne(a[0])),
  N: (a) => svNum(a[0]),
  T: (a) => (typeof svOne(a[0]) === "string" ? svOne(a[0]) : ""),
  ROWS: (a) => (svIsRange(a[0]) ? a[0].__rows.length : 1),
  COLUMNS: (a) => (svIsRange(a[0]) ? (a[0].__rows[0] || []).length : 1),
  INDEX: (a) => { const rows = svIsRange(a[0]) ? a[0].__rows : [[svOne(a[0])]]; const r = svNum(a[1]) || 1, c = a[2] === undefined ? 1 : svNum(a[2]) || 1; const row = rows[r - 1]; return row ? (row[c - 1] === undefined ? "#REF!" : row[c - 1]) : "#REF!"; },
  MATCH: (a) => { const v = svOne(a[0]), arr = svFlat(a[1]); for (let i = 0; i < arr.length; i++) if (String(arr[i]).toLowerCase() === String(v).toLowerCase()) return i + 1; return "#N/A"; },
  VLOOKUP: (a) => { const v = svOne(a[0]), rows = svIsRange(a[1]) ? a[1].__rows : []; const col = svNum(a[2]); for (const row of rows) if (String(row[0]).toLowerCase() === String(v).toLowerCase()) return row[col - 1] === undefined ? "#REF!" : row[col - 1]; return "#N/A"; },
  // 툴바 "링크 삽입" 버튼이 이 함수로 셀을 채운다(svToolbar case "link"). 구글 시트처럼 두 번째
  // 인자(라벨)가 있으면 그것을, 없으면 URL 자체를 표시값으로 삼는다. URL을 실제로 여는 것은
  // 별도 클릭 핸들러(svCellClickLink)가 맡는다.
  HYPERLINK: (a) => svStr(a[1] !== undefined ? a[1] : a[0]),
};
export function svTruth(v) { v = svOne(v); if (typeof v === "boolean") return v; if (typeof v === "number") return v !== 0; return String(v).toUpperCase() === "TRUE"; }

// 파서의 우선순위는 엑셀과 같다: 비교 < 잇기(&) < 더하기 < 곱하기 < 거듭제곱 < 부호 < 퍼센트.
export function svParse(toks, ctx, si) {
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (t && t.t === "op" && t.v === v) { p++; return true; } return false; };

  function ref(tok) {
    const at = svA1(tok.a); if (!at) return "#REF!";
    let s = si;
    if (tok.sheet != null) { const i = ctx.book.sheets.findIndex((x) => x.name === tok.sheet); if (i < 0) return "#REF!"; s = i; }
    // A1:B9처럼 뒤에 :이 오면 범위다.
    if (toks[p] && toks[p].t === "op" && toks[p].v === ":" && toks[p + 1] && toks[p + 1].t === "ref") {
      const b = svA1(toks[p + 1].a); p += 2;
      if (!b) return "#REF!";
      const r1 = Math.min(at[0], b[0]), r2 = Math.max(at[0], b[0]);
      const c1 = Math.min(at[1], b[1]), c2 = Math.max(at[1], b[1]);
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200000) return "#NUM!";
      const rows = [];
      for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(svCellVal(ctx, s, r, c)); rows.push(row); }
      return { __rows: rows };
    }
    return svCellVal(ctx, s, at[0], at[1]);
  }

  function primary() {
    const t = peek();
    if (!t) return "#VALUE!";
    if (t.t === "num" || t.t === "str" || t.t === "bool") { p++; return t.v; }
    if (t.t === "ref") { p++; return ref(t); }
    if (t.t === "fn") {
      p++; eat("(");
      const args = [];
      if (!eat(")")) {
        for (;;) { args.push(expr()); if (eat(",")) continue; eat(")"); break; }
      }
      const f = SV_FN[t.v];
      if (!f) return "#NAME?";
      const bad = args.find((a) => svErr(svOne(a)));
      // IFERROR·ISERROR는 오류를 받아 처리하는 것이 일이므로 그대로 넘긴다.
      if (bad && t.v !== "IFERROR" && t.v !== "IFNA" && t.v !== "ISERROR") return svOne(bad);
      try { return f(args); } catch (e) { return "#VALUE!"; }
    }
    if (t.t === "op" && t.v === "(") { p++; const v = expr(); eat(")"); return v; }
    if (t.t === "name") { p++; return "#NAME?"; }
    p++; return "#VALUE!";
  }
  function postfix() { let v = primary(); while (peek() && peek().t === "op" && peek().v === "%") { p++; const n = svNum(v); v = svErr(n) ? n : n / 100; } return v; }
  function unary() {
    if (peek() && peek().t === "op" && (peek().v === "-" || peek().v === "+")) { const op = peek().v; p++; const v = unary(); const n = svNum(v); return svErr(n) ? n : (op === "-" ? -n : n); }
    return postfix();
  }
  function pow() { let v = unary(); while (peek() && peek().t === "op" && peek().v === "^") { p++; const b = unary(); const x = svNum(v), y = svNum(b); v = svErr(x) ? x : svErr(y) ? y : Math.pow(x, y); } return v; }
  function mul() {
    let v = pow();
    while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = peek().v; p++; const b = pow();
      const x = svNum(v), y = svNum(b);
      v = svErr(x) ? x : svErr(y) ? y : op === "*" ? x * y : (y === 0 ? "#DIV/0!" : x / y);
    }
    return v;
  }
  function add() {
    let v = mul();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = peek().v; p++; const b = mul();
      const x = svNum(v), y = svNum(b);
      v = svErr(x) ? x : svErr(y) ? y : op === "+" ? x + y : x - y;
    }
    return v;
  }
  function cat() { let v = add(); while (peek() && peek().t === "op" && peek().v === "&") { p++; const b = add(); v = svErr(svOne(v)) ? svOne(v) : svErr(svOne(b)) ? svOne(b) : svStr(v) + svStr(b); } return v; }
  function expr() {
    let v = cat();
    while (peek() && peek().t === "op" && ["=", "<>", "<", ">", "<=", ">="].indexOf(peek().v) >= 0) {
      const op = peek().v; p++; const b = cat();
      let x = svOne(v), y = svOne(b);
      if (typeof x !== "number" || typeof y !== "number") { x = String(x == null ? "" : x).toLowerCase(); y = String(y == null ? "" : y).toLowerCase(); }
      v = op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
    }
    return v;
  }
  return expr();
}

// 한 칸의 값. 수식이면 풀어서 계산하고, 같은 칸을 두 번 계산하지 않게 기억해 둔다.
// 자기를 다시 참조하는 수식은 #REF!로 끊는다. 끊지 않으면 창이 멈춘다.
export function svCellVal(ctx, si, r, c) {
  const key = si + "!" + r + "," + c;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  if (ctx.busy.has(key)) return "#REF!";
  const sh = ctx.book.sheets[si];
  if (!sh) return "#REF!";
  const raw = svSrcAt(sh, r, c);
  let v;
  if (raw === "" || raw == null) v = "";
  else if (raw[0] === "=") {
    ctx.busy.add(key);
    try { v = svParse(svTok(raw.slice(1)), ctx, si); } catch (e) { v = "#VALUE!"; }
    ctx.busy.delete(key);
    v = svOne(v);
  } else v = svLit(raw);
  ctx.cache.set(key, v);
  return v;
}
export function svLit(raw) {
  const s = String(raw);
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s)) return Number(s);
  if (/^-?\d+(\.\d+)?%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return s;
}

// 숫자 서식: 서버와 같은 규칙(퍼센트·천단위·통화·소수 자리)만 맞춘다.
export function svFmtNum(n, nf) {
  if (typeof n !== "number") return String(n);
  const f = String(nf || "");
  const trim = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1e10) / 1e10));
  if (!f || f === "General") return trim(n);
  const dec = ((f.match(/\.(0+)/) || [, ""])[1] || "").length;
  if (f.indexOf("%") >= 0) return (n * 100).toFixed(dec) + "%";
  const neg = n < 0, abs = Math.abs(n);
  let s = f.indexOf("#,#") >= 0
    ? abs.toLocaleString("ko-KR", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : (dec ? abs.toFixed(dec) : trim(abs));
  if (/[₩¥]/.test(f)) s = "₩" + s;
  else if (f.indexOf("$") >= 0) s = "$" + s;
  if (neg) s = /\(.*\)/.test(f) ? "(" + s + ")" : "-" + s;
  return s;
}

// 파일 전체를 다시 계산해 화면에 보이는 글자까지 갈아 끼운다. 200줄짜리 표에서 한 번에 끝난다.
export function svRecalc(t) {
  const book = t.sheet; if (!book) return;
  const ctx = { book, cache: new Map(), busy: new Set() };
  const styles = svStyles(t);
  for (let si = 0; si < book.sheets.length; si++) {
    const sh = book.sheets[si];
    if (!sh.src) continue;
    for (const key of Object.keys(sh.src)) {
      if (String(sh.src[key])[0] !== "=") continue;
      const rc = key.split(",");
      const v = svCellVal(ctx, si, Number(rc[0]), Number(rc[1]));
      const cur = sh.cells[key];
      const sIdx = cur ? (cur[1] || 0) : 0;
      const nf = sIdx ? (styles[sIdx - 1] || {}).nf : null;
      const text = typeof v === "number" ? svFmtNum(v, nf) : (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v == null ? "" : v));
      sh.cells[key] = typeof v === "number" ? [text, sIdx, 1] : (sIdx ? [text, sIdx] : [text]);
      if (!sh._val) sh._val = {};
      sh._val[key] = v;
    }
  }
}
