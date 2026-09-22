// 조건부 서식: 셀 값과 규칙을 대조해 덧씌울 style을 고른다.
//
// 소유 범위
//   조건부 서식 범위 index, 규칙 우선순위, 규칙별 값 판정, 셀별 style 선택.
//
// 제공 API
//   initSheetConditional(): 기존 선언 위치를 보존하는 초기화 경계. 런타임 부작용은 없다.
//   svCF(t, sh, r, c, text): 이 셀에 덧씌울 style 또는 null.
//
// 의존 대상
//   sheet/formula.js의 A1·literal·truth·token·parse 헬퍼를 import한다.
//
// 유지 조건
//   priority가 작은 규칙부터 보고, 먼저 맞은 규칙 하나만 적용한다.
//   원래 셀 style은 바꾸지 않고 덧씌울 style만 반환한다.
//
// 영향 범위
//   main의 시트 행 렌더와 편집 직후 다시 칠하기 경로.
//
// model ← formula ← conditional 방향만 유지한다. model이나 main으로 역방향 import하지 않는다.
import { svA1, svLit, svTruth, svParse, svTok } from "./formula.js";

export function initSheetConditional() {}

// ── 조건부 서식 ────────────────────────────────────────────────────────────
// 값에 따라 칸 색이 바뀌는 규칙(구글 시트의 "조건부 서식"). 원본 파일이 통과=연초록·실패=연빨강·
// 미실행=회색을 이 방식으로 칠하므로, 이 계산을 하지 않으면 값을 넣어도 흰 칸으로 남는다.
// 우선순위(priority)가 작은 규칙이 먼저다. 여러 규칙이 맞으면 앞선 것이 적용된다(엑셀과 같다).
function svCFIndex(t, sh) {
  if (sh._cfi) return sh._cfi;
  const list = [];
  for (const g of sh.cf || []) {
    for (const part of String(g.ref).split(/\s+/)) {
      const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(part);
      if (!m) continue;
      const a = svA1(m[1] + m[2]), b = m[3] ? svA1(m[3] + m[4]) : a;
      if (!a || !b) continue;
      list.push({
        r1: Math.min(a[0], b[0]), r2: Math.max(a[0], b[0]),
        c1: Math.min(a[1], b[1]), c2: Math.max(a[1], b[1]),
        rules: g.rules.slice().sort((x, y) => (x.p || 0) - (y.p || 0)),
      });
    }
  }
  sh._cfi = list;
  return list;
}

// 규칙 하나가 이 값에 맞는지 판정한다.
function svCFHit(rule, v, t, si, r, c) {
  const num = (x) => { const n = typeof x === "number" ? x : Number(String(x).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const lit = (f) => { const m = /^"(.*)"$/s.exec(String(f)); return m ? m[1] : svLit(String(f)); };
  const s = v == null ? "" : String(v);
  if (rule.t === "cellIs") {
    const a = lit(rule.f[0]), b = rule.f[1] !== undefined ? lit(rule.f[1]) : null;
    const nv = num(v), na = num(a), nb = b == null ? null : num(b);
    switch (rule.op) {
      case "equal": return nv != null && na != null ? nv === na : s === String(a);
      case "notEqual": return nv != null && na != null ? nv !== na : s !== String(a);
      case "greaterThan": return nv != null && na != null && nv > na;
      case "lessThan": return nv != null && na != null && nv < na;
      case "greaterThanOrEqual": return nv != null && na != null && nv >= na;
      case "lessThanOrEqual": return nv != null && na != null && nv <= na;
      case "between": return nv != null && na != null && nb != null && nv >= Math.min(na, nb) && nv <= Math.max(na, nb);
      case "notBetween": return nv != null && na != null && nb != null && (nv < Math.min(na, nb) || nv > Math.max(na, nb));
      default: return false;
    }
  }
  if (rule.t === "containsText") return s.indexOf(String(rule.text != null ? rule.text : lit(rule.f[0]))) >= 0;
  if (rule.t === "notContainsText") return s.indexOf(String(rule.text != null ? rule.text : lit(rule.f[0]))) < 0;
  if (rule.t === "beginsWith") return s.indexOf(String(rule.text != null ? rule.text : lit(rule.f[0]))) === 0;
  if (rule.t === "endsWith") { const x = String(rule.text != null ? rule.text : lit(rule.f[0])); return s.slice(-x.length) === x; }
  if (rule.t === "containsBlanks") return s === "";
  if (rule.t === "notContainsBlanks") return s !== "";
  if (rule.t === "expression") {
    // 수식 규칙은 범위 첫 칸 기준으로 적혀 있다. 이 칸까지 상대 참조를 옮겨 계산한다.
    const ctx = { book: t.sheet, cache: new Map(), busy: new Set() };
    try { return svTruth(svParse(svTok(String(rule.f[0])), ctx, si)); } catch (e) { return false; }
  }
  return false;
}

// 이 칸에 걸리는 조건부 서식(없으면 null).
export function svCF(t, sh, r, c, text) {
  if (!sh.cf || !sh.cf.length) return null;
  const si = t.sheetIdx || 0;
  for (const g of svCFIndex(t, sh)) {
    if (r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) continue;
    for (const rule of g.rules) if (svCFHit(rule, text, t, si, r, c)) return rule.s;
  }
  return null;
}
