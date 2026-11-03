import { renderSessionRecords, direction } from "./report-session.mjs";
// 장부 회차의 기본 지면. 개발자가 아닌 사람이 이 페이지만 보고 확인 결과를 다시 판정한다.
//
// 소유 범위
//   장부 회차의 report.html 화면. 줄마다 흐름(화면 > 행동 > 결과), 색 판정, 결과 줄, 장면.
//
// 제공 API
//   renderPlain. report.mjs 의 buildReport 가 장부를 읽은 뒤 부른다.
//
// 의존 대상
//   부르는 쪽이 넘기는 도구 묶음(h)과 장부(led)뿐이다. 파일 보존·장면 삽입·색 표는 report.mjs 가 소유한다.
//
// 유지 조건
//   확인 기록 번호·선택자·주소·코드 경로·조건 원문을 싣지 않는다. 그것들은 같은 폴더의
//   report-dev.html 이 그대로 싣는다. 이 지면은 장부의 글을 고치지 않고 고르기만 한다.
//
// 영향 범위
//   bin/smoke/sections/qa-report-page.mjs 가 렌더 결과를 검사한다.

import { checkLanes, lanesSvg } from "./report-lanes.mjs";
import { QA_CASE_KINDS as QA_KIND_ORDER, QA_COMMAND_SCHEMAS, QA_EXPECT_SCHEMA } from "../../server/qa-protocol.js";

// 판정 색 이름. 개발자 지면과 뜻은 같고 이름만 읽는 사람의 말로 적는다.
const PLAIN = {
  red: "실패", orange: "사용 불편", yellow: "개선 권장",
  blue: "결정 대기", gray: "미확인", green: "통과",
};
const BASIS_PLAIN = { spec: "명세", plan: "기획서", code: "기존 구현", user: "사용자 결정", assumed: "확인자 판단" };

// 장부 글에 줄바꿈이 문자 그대로(\n) 들어간 옛 기록도 줄로 나눈다.
const splitLines = (t) => String(t || "").split(/\n|\\n/).map((x) => x.trim()).filter(Boolean);

// 확인 한 건을 선택자 없이 적는다. 반응 판정은 기록된 조작·효과에서 "조작 → 효과" 문장을 만들고,
// 조작·효과 기록이 없는 판정(브라우저 화면 조건 판정·옛 회차)은 대상과 기대로 적는다.
// 기기에서 효과로 판정한 확인은 종류가 기능
const MODE_WANT = { equals: "일치", contains: "포함", absent: "없음", exists: "있음" };
const DEVICE_KIND = "기능";

// 받침 여부: 한글은 음절로, 숫자·영문은 읽는 소리로. "ㄹ"은 ㄹ 받침('로' 앞)
function finalSound(word) {
  const ch = String(word).trim().replace(/[…'"’”)\]]+$/, "").at(-1) || "";
  const c = ch.charCodeAt(0) - 0xac00;
  if (c >= 0 && c < 11172) return c % 28 === 0 ? "" : c % 28 === 8 ? "ㄹ" : "ㅇ";
  if (/[178lLrR]/.test(ch)) return "ㄹ";
  if (/[036mMnN]/.test(ch)) return "ㅇ";
  return "";
}
const josa = (word, withFinal, without) => {
  const f = finalSound(word);
  return withFinal === "으로" ? (f && f !== "ㄹ" ? "으로" : "로") : f ? withFinal : without;
};
// 여러 줄 이름은 같은 줄을 합침. 화면에는 30자까지, 묶기에는 원래 이름을 씀
function displayName(raw) {
  const t = [...new Set(String(raw).split(/\n+/).map((x) => x.trim()).filter(Boolean))].join(" ").replace(/https?:\/\/\S+/g, "주소");
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
}
const quoted = (raw) => `'${displayName(raw)}'`;
const KEY_NAME = { enter: "Enter", backspace: "Backspace", delete: "Delete", escape: "Esc", tab: "Tab", space: "스페이스",
  arrowup: "위 화살표", arrowdown: "아래 화살표", arrowleft: "왼쪽 화살표", arrowright: "오른쪽 화살표" };
// 조작 종류별 [목적어구, 동사 줄기]. 표에 없는 종류는 "조작하"
const withObj = (n, a, b) => (n ? `${quoted(n)}${josa(displayName(n), a, b)}` : "");
export const ACTION_PHRASE = {
  tap: (a) => [a.name ? withObj(a.name, "을", "를") : "화면 한 곳을", "누르"],
  click: (a) => ACTION_PHRASE.tap(a),
  dblclick: (a) => [a.name ? withObj(a.name, "을", "를") : "화면 한 곳을", "두 번 누르"],
  // 입력 원문은 기록에 없음(비밀 입력 보호). 이름이 없으면 기록된 글자 수
  type: (a) => [a.name ? `${quoted(a.name)}에` : Number.isInteger(a.length) && a.length > 0 ? `${a.length}글자를` : "", "입력하"],
  key: (a) => { const k = a.key ? KEY_NAME[String(a.key).toLowerCase()] || String(a.key) : "";
    return [`${a.name ? `${quoted(a.name)}에서 ` : ""}${k ? `${k} 키를` : "키를"}`, "누르"]; },
  swipe: (a) => { const d = direction(a.dx, a.dy); return [`${a.name ? `${quoted(a.name)}에서` : "화면을"}${d ? ` ${d}` : ""}`, "밀"]; },
  scroll: (a) => { const d = direction(a.dx, a.dy); return [`${a.name ? `${quoted(a.name)} 쪽에서` : "화면을"}${d ? ` ${d}` : ""}`, "스크롤하"]; },
  select: (a) => [a.name ? `${quoted(a.name)}에서` : "목록에서", "고르"],
  drag: (a) => [a.name ? withObj(a.name, "을", "를") : "", "끌어 옮기"],
  hover: (a) => [a.name ? `${quoted(a.name)}에` : "", "마우스를 올리"],
  history: () => ["이전·다음 화면으로", "이동하"],
  dialog: () => ["대화상자에", "답하"],
};
function actionPhrase(a) {
  const [obj, stem] = (Object.hasOwn(ACTION_PHRASE, a.kind) ? ACTION_PHRASE[a.kind] : () => ["", "조작하"])(a);
  const head = obj ? `${obj} ` : "";
  if (a.delivered === false) return `${head}${stem}려 했으나 입력이 전달되지 않았고`;
  return a.retried ? `${head}${stem}자(첫 클릭에 화면 반응이 없어 다시 누름)` : `${head}${stem}자`;
}
// 효과 종류별 [주어구, 됨, 안 됨, 해야 함]. QA_EXPECT_SCHEMA 의 종류 전부(시험이 대조)
const subject = (n, fallback) => (n ? `${quoted(n)}${josa(displayName(n), "이", "가")}` : fallback);
export const EFFECT_PHRASE = {
  appear: (e) => [subject(e.name, "새 요소가"), "나타남", "나타나지 않음", "나타나야 함"],
  disappear: (e) => [subject(e.name, "요소가"), "사라짐", "사라지지 않음", "사라져야 함"],
  change: (e) => [`${subject(e.name, "값이")}${e.to != null && e.to !== "" ? ` ${quoted(e.to)}${josa(displayName(e.to), "으로", "로")}` : ""}`, "바뀜", "바뀌지 않음", "바뀌어야 함"],
  unchanged: (e) => [subject(e.name, "화면이"), "그대로임", "바뀜", "그대로여야 함"],
  absent: (e) => [subject(e.name, "요소가"), "없음", "있음", "없어야 함"],
  none: () => ["", "변화 없음", "변화가 있음", "변화가 없어야 함"],
  navigate: () => ["", "다른 화면으로 이동함", "다른 화면으로 이동하지 않음", "다른 화면으로 이동해야 함"],
  dialog: () => ["대화상자가", "뜸", "뜨지 않음", "떠야 함"],
  request: () => ["서버 요청이", "나감", "나가지 않음", "나가야 함"],
};
// 관찰 기록이 있으면 그대로, 없으면 판정이 통과일 때 관찰된 것으로 봄
const observedOf = (e, pass) => (typeof e.observed === "boolean" ? e.observed : pass === true ? true : undefined);
function effectPhrase(e, pass) {
  const [subj, did, didnt, should] = (Object.hasOwn(EFFECT_PHRASE, e.type) ? EFFECT_PHRASE[e.type] : () => ["기대한 변화가", "확인됨", "확인되지 않음", "있어야 함"])(e);
  const seen = observedOf(e, pass);
  return `${subj ? `${subj} ` : ""}${seen === true ? did : seen === false ? didnt : should}`;
}
export function checkText(x) {
  const pass = !!x.pass;
  if (Array.isArray(x.effects) && x.effects.length) {
    const effects = x.effects.map((e) => effectPhrase(e, x.pass)).join(", ");
    // 묶기 키는 바뀐 값까지, 반복 확인 키는 효과 대상과 관찰 결과만(값만 다른 같은 효과도 반복)
    const full = x.effects.map((e) => [e.type, e.name ?? null, e.to ?? null, observedOf(e, x.pass) ?? null]);
    const effKeys = full.map(([type, name, , seen]) => JSON.stringify([type, name, seen]));
    const a = x.act;
    return { kind: DEVICE_KIND, target: "", want: a ? `${actionPhrase(a)} ${effects}` : effects, got: "", pass, effKeys,
      key: JSON.stringify([a ? [a.kind, a.name ?? null, a.key ?? null, a.delivered ?? null, direction(a.dx, a.dy), a.name ? null : a.length ?? null, ...(a.retried ? ["retried"] : [])] : null, full, pass]) };
  }
  const w = x.want != null && String(x.want) !== "" ? `'${String(x.want)}'` : "";
  // 주소를 대상으로 한 확인은 주소 대신 "현재 주소"로. 사람용에는 주소를 두지 않음
  const raw = x.label ? String(x.label) : x.element ? String(x.element) : "";
  const target = /^https?:\/\//.test(raw) ? "현재 주소" : raw.replace(/https?:\/\/\S+/g, "주소");
  // 글자 없이 있음·없음만 본 확인은 "화면에 있음·없음"으로 적는다.
  const want = w ? `${w} ${MODE_WANT[x.mode] || "확인"}` : x.mode === "absent" ? "화면에 없음" : "화면에 있음";
  // 실제값은 통과하면 기대값이 곧 사실이라 싣지 않는다. 실패했을 때만 무엇이 나왔는지 적는다.
  const got = x.pass ? "" : x.got == null || String(x.got) === "" ? (x.found === false ? "대상을 못 찾음" : "")
    : String(x.got);
  return { kind: DEVICE_KIND, target, want, got, pass, key: JSON.stringify([target, want, got, pass]) };
}
const checkLine = (c) => `${c.target ? c.target + " · " : ""}${c.want}${c.got ? ` · 실제값 '${c.got.slice(0, 80)}'` : ""} → ${c.pass ? "통과" : "실패"}`;

// 판정 글이 가리킨 회차 안 번호(사진 17493, 5113~5180). 개수·자리수·배율·전화번호·파일 줄 번호는 빼려고 앞뒤 글자를 봄
const SEQ_REF = /(?<![\w.\-:/~])(\d{2,8})(?:\s*~\s*(\d{2,8}))?(?![\w.\-:%개자번배원명건장초분일줄회단칸])/g;
export function seqRefs(text) {
  return [...String(text || "").matchAll(SEQ_REF)].map((m) => ({ from: Number(m[1]), to: Number(m[2] || m[1]) })).filter((r) => r.to >= r.from);
}
// 사진 고르기에 쓰는 번호. 문장 안에서 다른 QA 회차(앞·지난·다른·N번째 회차, 회차 ID)를 말한 뒤의 번호는
// 어느 회차 사진인지 알 수 없어 사진에 잇지 않음. 이번·현재 회차를 말하면 그 뒤 번호는 다시 이 회차 사진.
// "앞 회차 사진 600"을 이 회차의 600번 사진(홈 화면)에 이은 사례. 수식어 없는 '회차'는 제품 낱말일 수 있어 보지 않음
const OTHER_RUN = /(?:앞|이전|지난|다른|직전|첫|[두세네]\s*번째|\d+\s*번째|\d+)\s*회차|\bqa-[0-9a-f]{6,}\b/g;
const THIS_RUN = /(?:이번|이|지금|현재)\s*회차/g;
export function ownRunRefs(text) {
  const out = [];
  for (const sent of String(text || "").split(/(?<=[.!?。])\s+|\n+/)) {
    const marks = [...[...sent.matchAll(OTHER_RUN)].map((m) => [m.index + m[0].length, false]),
      ...[...sent.matchAll(THIS_RUN)].map((m) => [m.index + m[0].length, true])].sort((a, b) => a[0] - b[0]);
    for (const m of sent.matchAll(SEQ_REF)) {
      const mark = marks.filter(([end]) => end <= m.index).at(-1);
      if (mark && !mark[1]) continue;
      const r = { from: Number(m[1]), to: Number(m[2] || m[1]) };
      if (r.to >= r.from) out.push(r);
    }
  }
  return out;
}
// 캡션에서 회차 안 번호를 지움. known 이 참인 번호(그 경로의 사진·판정 번호)만 지우고 나머지 숫자는 둠.
// 앞의 '사진'·'장면' 같은 말은 남기고 receipt·seq 는 함께 지움. 번호만 남은 괄호는 통째로 지움
// knownAny: 보고서 전체의 회차 번호. '사진 17423'처럼 낱말이 붙은 번호는 다른 경로의 것이어도 지움
export function dropSeqRefs(text, known, knownAny = known) {
  const token = new RegExp(`((?:마지막\\s*)?(?:사진|스냅샷|장면|판정)\\s*)?(?:(?:receipt|seq)\\s*)?#?${SEQ_REF.source}`, "g");
  // 조사 바로 앞의 번호는 '사진'으로 바꿈(다시 찍은 18331에서 → 다시 찍은 사진에서)
  return String(text || "").replace(token, (m, word, a, b, offset, all) => {
    // '사진 17423'처럼 앞에 사진·장면 같은 말이 붙은 번호는 다른 경로의 것이어도 회차 안 번호
    if (word) return known(Number(a), Number(b || a)) || knownAny(Number(a), Number(b || a)) ? `${word.trim()}\u0000` : m;
    if (!known(Number(a), Number(b || a))) return m;
    return /^(?:에서|에|과|와|은|는|이|가|을|를|으로|로|의|까지|부터)/.test(all.slice(offset + m.length)) ? "사진\u0000" : "\u0000";
  })
    // 번호를 지워 낱말만 남은 괄호는 통째로
    .replace(/\(((?:\s*(?:마지막|사진|스냅샷|장면|판정|receipt|seq|\u0000|[,·~]))*)\)/g, (m, inner) => (inner.includes("\u0000") ? "" : m))
    .replace(/\u0000/g, "")
    .replace(/\(\s*[,·]\s*/g, "(").replace(/\s*[,·]\s*\)/g, ")")
    .replace(/\s+·/g, "·").replace(/·(?:\s*·)+/g, "·").replace(/\s*[,·]\s*([.]|$)/g, "$1")
    .replace(/(?:\s*,\s*){2,}/g, ", ").replace(/\s+([.,)])/g, "$1").replace(/\s{2,}/g, " ").trim();
}
// 확인자 글에서 Iris 를 가리키는 것이 확실한 낱말만 바꿈: Iris 명령 이름, 회차 안 사진·판정 번호, 반응 후보 참조.
// 커밋 해시·소스 경로·좌표 같은 것은 다른 앱에서 화면 내용일 수 있어 두고, 확인자가 overview.cases[].text 로 고침.
// 그 흔적이 든 괄호는 통째로, 문장 속은 그 낱말만. 원문은 -dev 보고서에 그대로 남음
// 명령의 한국어 이름. 표에 없는 명령은 "QA 명령"
const TOOL_WORDS = { qa_play: "자동 실행", qa_act: "조작", qa_app_act: "조작", app_type: "입력", qa_type: "입력", qa_app_type: "입력", app_tap: "누르기", qa_app_tap: "누르기",
  app_swipe: "밀기", qa_app_swipe: "밀기", app_key: "키 입력", qa_app_key: "키 입력", qa_key: "키 입력", qa_click: "누르기",
  qa_dialog: "대화상자 응답", qa_unexpected: "뜻밖의 화면 처리", qa_snapshot: "화면 구조 읽기", qa_screenshot: "화면 찍기",
  qa_note: "메모", qa_row: "확인 항목 기록", qa_expect: "화면 조건 판정", qa_app_expect: "화면 조건 판정" };
const COMMAND_WORD = Object.fromEntries(Object.entries(TOOL_WORDS).map(([k, v]) => [k.replace(/^qa_/, ""), v]));
// 스키마의 명령 k 마다 qa_k, 밑줄이 든 명령(app_tap 등)은 k 그대로도. 새 명령이 생기면 따라감
const COMMAND_NAMES = Object.keys(QA_COMMAND_SCHEMAS).flatMap((k) => [`qa_${k}`, ...(k.includes("_") ? [k] : [])]).sort((a, b) => b.length - a.length);
const commandWord = (name) => COMMAND_WORD[name.replace(/^qa_/, "")] || "QA 명령";
const TOOL_NAME = new RegExp(String.raw`\b(?:${COMMAND_NAMES.join("|")})\b`, "g");
// 반응 후보 참조: 후보 id(a<번호>…)와 후보 코드(K<번호>)를 함께 쓴 형태
const CANDIDATE = String.raw`후보\s+a\d+(?:-[0-9a-f][0-9a-f-]*)?\s+K\d+`;
const JOSA_PAIR = { 으로: (w) => josa(w, "으로", "로"), 로: (w) => josa(w, "으로", "로"), 은: (w) => josa(w, "은", "는"), 는: (w) => josa(w, "은", "는"),
  이: (w) => josa(w, "이", "가"), 가: (w) => josa(w, "이", "가"), 을: (w) => josa(w, "을", "를"), 를: (w) => josa(w, "을", "를"), 과: (w) => josa(w, "과", "와"), 와: (w) => josa(w, "과", "와") };
const TRACE = new RegExp(String.raw`${TOOL_NAME.source}|${CANDIDATE}`);
// known(n): 이 보고서에 실제로 있는 회차 번호인가. 모르면 번호를 지우지 않음
const COUNTER = "개자번배원명건장초분일줄회단칸%";
export function plainText(text, known = () => false) {
  const allKnown = (nums) => nums.length > 0 && nums.every((n) => known(Number(n), Number(n)));
  // 사진 209·스냅샷 2425·촬영 19130·판정 #68 → 낱말만, seq 7164·receipt 6249 → 통째로. 이 보고서의 번호이고 뒤에 개수 낱말이 없을 때만
  let t = String(text ?? "").replace(new RegExp(String.raw`((?:마지막\s*)?(?:사진|스냅샷|촬영|장면|판정)(?:\s*기록)?)\s*#?(\d{2,8}(?:\s*[~·,]\s*\d{2,8})*)(?![\d${COUNTER}])`, "g"),
    (m, word, nums) => (allKnown(nums.match(/\d+/g)) ? `${word}\u0000` : m))
    .replace(new RegExp(String.raw`(?:마지막\s*)?(?:seq|receipt)\s*#?(\d+(?:\s*[~·,]\s*\d+)*)(?![\d${COUNTER}])`, "gi"),
      (m, nums) => (allKnown(nums.match(/\d+/g)) ? "\u0001" : m));
  // Iris 흔적(명령 이름·후보 참조·지운 seq 번호)이 든 괄호는 통째로. 흔적을 근거로 단 괄호라 다른 설명이 함께 있어도 뺌
  t = t.replace(/\(([^()]*)\)/g, (m, inner) => (TRACE.test(inner) || inner.includes("\u0001") ? "" : m)).replace(/\u0001/g, "");
  // 명령 이름 바로 뒤 번호는 그 명령의 회차 번호라 함께 지움. 조사는 새 낱말 받침에 맞춤(qa_expect 10691로 → 화면 조건 판정으로)
  t = t.replace(new RegExp(String.raw`(${TOOL_NAME.source})(?:\s*#?\d{2,8}(?![\d.]))?(으로|로|은|는|이|가|을|를|과|와)?`, "g"), (m, name, p) => {
    const word = commandWord(name);
    return word + (p ? JOSA_PAIR[p](word) : "");
  }).replace(new RegExp(CANDIDATE, "g"), "");
  // 번호를 지워 낱말만 남은 괄호는 통째로. 확인자가 쓴 다른 괄호는 둠
  t = t.replace(/\(((?:\s*(?:마지막|사진|스냅샷|촬영|장면|판정|기록|\u0000|[,·~]))*)\)/g, (m, inner) => (inner.includes("\u0000") ? "" : m));
  // 번호를 지운 자리 뒤 '로'는 앞 글자 받침에 맞춤(판정 10691로 → 판정으로)
  t = t.replace(/([가-힣])\u0000로/g, (m, ch) => `${ch}${josa(ch, "으로", "로")}`).replace(/\u0000/g, "");
  return t.replace(/(\S+)(?: \1)+(?=\s|$)/g, "$1").replace(/\s*·\s*,/g, ",").replace(/\(\s*[,·]\s*/g, "(").replace(/\s*[,·]\s*\)/g, ")")
    .replace(/(?:\s*·\s*){2,}/g, " · ").replace(/(?:\s*,\s*){2,}/g, ", ").replace(/^\s*[,·]\s*|\s*[,·]\s*$/g, "")
    .replace(/\s+([.,)])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}
const sentencesOf = (t) => String(t || "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
// 문장을 괄호 밖의 쉼표로 나눔. 한 문장이 사진 여러 장을 가리킬 때 그 사진을 가리킨 부분만 캡션으로 씀
export function clausesOf(sentence) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i];
    if (ch === "(") depth += 1; else if (ch === ")") depth = Math.max(0, depth - 1);
    // 숫자 안 쉼표(33,333P)는 절 경계가 아님
    else if (ch === "," && !depth && !(/\d/.test(sentence[i - 1] || "") && /\d/.test(sentence[i + 1] || ""))) { out.push(sentence.slice(start, i).trim()); start = i + 1; }
  }
  out.push(sentence.slice(start).trim());
  return out.filter(Boolean);
}

// 같은 대상에 글자를 하나씩 넣으며 남긴 판정. 연속한 두 판정이 같은 대상의 입력이고 앞 값이 뒤 값의 앞부분이면 입력 중간.
// 값이 줄어든 쪽(10 → 1)은 줄이거나 지우는 동작의 증거일 수 있어 빼지 않음.
// 조작 기록이 없는 옛 판정은 판별하지 않음(1 → 10처럼 따로 확인할 값을 빼지 않게)
export function typingIntermediates(receipts) {
  const out = new Set();
  const toOf = (x) => (x.effects || []).find((e) => e.type === "change" && typeof e.to === "string" && e.to)?.to;
  receipts.forEach((x, i) => {
    const y = receipts[i + 1];
    if (!y || x.act?.kind !== "type" || y.act?.kind !== "type" || !x.act.name || x.act.name !== y.act.name) return;
    const a = toOf(x), b = toOf(y);
    if (a && b && a !== b && b.startsWith(a)) out.add(x);
  });
  return out;
}

// 거의 같은 장면 기준: dHash 64비트 중 다른 비트 6개 이하. 화면 전체 밝기 격자라 대화상자·목록 값 차이를 못 봄(확인 창이 뜬 화면과
// 안 뜬 화면이 1비트). 그래서 화면에 나갈 설명이 같고 판정 상태가 같을 때만 묶음. 설명이 같으면 읽는 사람이 두 사진에서 얻는 사실이 같음
const NEAR_SAME_BITS = 6;
const hashDistance = (a, b) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
// 순위: 판정 글이 가리킴 > 실패 판정 > 설명 단 사진 > 통과 판정 > 변화 없음만 확인한 통과 판정 > 자동 장면. 증거 사진은 순위 밖(상한 없이 맨 앞)
const RANK = { cited: 0, fail: 1, evidence: 2, own: 3, pass: 4, still: 5, auto: 6 };
// 같은 순위 안에서 상한보다 많으면 경로 처음부터 끝까지 고르게, 처음과 마지막 포함. 앞 사진부터 채우면 결과 장면이 밀린 사례
function spread(list, n) {
  if (n <= 0) return [];
  if (list.length <= n) return list;
  if (n === 1) return [list.at(-1)];
  return [...new Set(Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]))];
}
// 사진 설명은 {said 확인자 글, line 확인 줄} 두 덩어리. 묶인 사진들의 설명에서 같은 확인자 글은 한 번만,
// 이미 쓴 확인 줄은 처음 나온 확인자 글에 붙을 때만 다시 씀. 확인 줄만 보고 빼면 "이메일 · 확인됨" 다음
// "휴대전화 · 확인됨"의 결과가 사라짐. 덩어리 안 같은 문장은 한 번만
function bandOf(captions) {
  const saids = new Set(), lines = new Set(), once = (t) => { const said = new Set(); return sentencesOf(t).filter((x) => (said.has(x) ? false : said.add(x))).join(" "); };
  return captions.map((c) => {
    const said = String(c.said || "").trim(), line = String(c.line || "").trim();
    const head = said && !saids.has(said) ? said : "";
    const tail = line && (head || !lines.has(line)) ? line : "";
    if (said) saids.add(said);
    if (line) lines.add(line);
    return [head, tail].filter(Boolean).map(once).join(" · ");
  }).filter(Boolean).join(" / ");
}
const captionKey = (c) => JSON.stringify([c.said || "", c.line || ""]);

// 장면 고르기. 후보 모음 → 파일 확인 → 덮어쓰기 hide → 같은 사진 묶기 → 순위·상한.
// 한 회차 보고서는 상한 없음, 여러 회차 묶음만 경로마다 상한(sceneLimit). 묶음에 판정 장면 수백 장이 들어가 문자열 한도를 넘은 사례
// ctx: voided 그 경로에서 유효 판정이 없는 무효 판정 사진, evidence 증거 사진, edits sha256→덮어쓰기, shas 그 케이스 후보 sha256 모음,
// tx·display 확인자 글 고치기(원문·표시 규칙), gen 구조에서 만든 문장 모음, log 적용 결과
function pickScenes(ln, h, ctx) {
  const { voided = new Set(), evidence = [], edits = new Map(), shas = new Set(), tx = (t) => t, display = (s, b, e) => e, gen = (t) => t, log = null } = ctx;
  const shaOf = (p) => (h.fileSha ? h.fileSha(p) : null);
  // 읽을 수 없을 만큼 작은 그림은 고르기 전에 뺀다. 고른 뒤에 빼면 대신 설 장면이 없다.
  const usable = (f) => { const d = h.pngSize(f.path); return !d || (d.w >= TINY && d.h >= TINY); };
  const frames = ln.frames || [], receipts = ln.receipts || [];
  const live = frames.filter((f) => !h.frameStale(f) && !voided.has(f.path) && usable(f));
  // 덮어쓰기 대조는 고르기 전 후보 전체로. 고른 사진만 보면 상한·묶기에 빠진 사진이 없는 sha256 오류가 됨
  if (edits.size) for (const f of live) { const x = shaOf(f.path); if (x) shas.add(x); }
  const byShot = new Map();
  for (const x of receipts) if (x.shot) byShot.set(x.shot, [...(byShot.get(x.shot) || []), x]);
  const verdictsOf = (f) => byShot.get(f.path) || [];
  const seqOf = (x) => Number(x.origSeq ?? x.seq);
  const laneSeqs = [...frames.map((f) => Number(f.seq)), ...receipts.map(seqOf)].filter(Number.isFinite);
  const known = (a, b) => laneSeqs.some((n) => n >= a && n <= b);
  // 판정 글: 경로를 닫을 때 쓴 장면 판단·결과와, 다시 열고 닫을 때마다 남은 장면 판단 사진의 설명
  const storyRaw = [...new Set([...frames.filter((f) => f.claimKind === "S5").map((f) => f.caption), ln.judgment, ln.note].filter(Boolean))].join("\n");
  const story = tx(storyRaw);
  const refs = ownRunRefs(story).filter((r) => known(r.from, r.to));
  const numsOf = (f) => [Number(f.seq), ...verdictsOf(f).map(seqOf)].filter(Number.isFinite);
  // 범위(5113~5180)는 그 안의 첫 사진과 끝 사진만. 범위 안 사진을 모두 고르면 같은 캡션이 열 장 넘게 실린 사례
  const inRange = (r) => live.filter((f) => numsOf(f).some((n) => n >= r.from && n <= r.to));
  const cited = new Set(refs.flatMap((r) => { const xs = inRange(r); return r.from === r.to ? xs : [xs[0], xs.at(-1)].filter(Boolean); }));
  const refOf = (f) => cited.has(f);
  const typing = typingIntermediates(receipts);
  // 장부 설명 끝에 붙은 촬영 상태(안정 전 촬영 · 남은 항목: [...])를 뗀 설명
  const ownRaw = (f) => String(f.caption || "").replace(f.captureNote || "\0", "").replace(/(?:\s*·\s*)+$/, "").trim();
  const ownCaption = (f) => tx(ownRaw(f));
  const unstable = (f) => /안정 전 촬영/.test(f.captureNote || "");
  const skipped = { typing: 0, unstable: 0, failInPass: 0, same: 0, hidden: 0, lost: 0, tiny: 0 };
  const candidates = live.filter((f) => refOf(f) || f.why === "찍음" || (f.why === "판정" && verdictsOf(f).length));
  let pool = candidates.filter((f) => {
    if (refOf(f)) return true;
    const vs = verdictsOf(f);
    if (vs.length && vs.every((x) => typing.has(x))) { skipped.typing += 1; return false; }
    // 설명을 달아 일부러 찍은 장면은 안정 전이어도 남김
    if (unstable(f) && !(f.why === "찍음" && ownCaption(f))) { skipped.unstable += 1; return false; }
    if (ln.color === "green" && vs.length && vs.every((x) => !x.pass)) { skipped.failInPass += 1; return false; }
    return true;
  });
  const hiddenSha = (x) => !!x && edits.get(x)?.hide === true;
  // 확인자가 뺀 사진은 대신할 사진으로도 되살리지 않음
  const visible = (f) => !hiddenSha(shaOf(f.path));
  if (!pool.length) pool = candidates.length ? [candidates.filter(visible).at(-1)].filter(Boolean)
    : live.length > 1 ? [live.filter(visible)[0], live.filter(visible).at(-1)].filter(Boolean) : live.filter(visible);
  // 장면 캡션: 판정 사진은 그 판정의 문장, 판정 글이 가리킨 사진은 그 문장, 나머지는 가장 가까운 앞 판정
  // 확인자 글 부분은 원문 규칙을 적용한 판정 글(sentences)과 적용하지 않은 판정 글(base)로 두 번 만들어 표시 규칙에 넘김
  const sentences = sentencesOf(story), baseSentences = sentencesOf(storyRaw);
  // 설명은 자르지 않음. 화면은 3줄로 줄이고 크게 보기에서 전문
  const knownAny = h.knownSeq || known;
  const clean = (t) => plainText(dropSeqRefs(t, known, knownAny), knownAny);
  const writer = (make) => display(storyRaw, make(baseSentences), make(sentences));
  // 통과 경로에서 뺀 실패 판정은 캡션에도 쓰지 않음
  const shown = ln.color === "green" ? receipts.filter((x) => x.pass) : receipts;
  const lineOf = (x) => gen(checkLine(checkText(x)));
  const nearCheck = (f) => {
    const n = Number(f.seq);
    const before = Number.isFinite(n) ? shown.filter((x) => seqOf(x) <= n).at(-1) : null;
    const x = before || shown.find((y) => !Number.isFinite(n) || seqOf(y) > n);
    return x ? lineOf(x) : "";
  };
  const citedPart = (f, sents) => {
    const cites = (t) => ownRunRefs(t).some((r) => numsOf(f).some((n) => n >= r.from && n <= r.to));
    const said = sents.find(cites);
    if (!said) return "";
    const own = ownRunRefs(said).filter((r) => known(r.from, r.to)).length > 1 ? clausesOf(said).find(cites) || said : said;
    return plainText(dropSeqRefs(own, known, knownAny), knownAny);
  };
  const captionOf = (f) => {
    const vs = verdictsOf(f);
    const said = refOf(f) ? writer((sents) => citedPart(f, sents)) : "";
    if (vs.length) return { said, line: [...new Set(vs.map(lineOf))].join(" / ") };
    if (said) return { said };
    if (f.why === "찍음" && f.claimKind !== "S5" && ownCaption(f)) return { said: display(ownRaw(f), clean(ownRaw(f)), clean(ownCaption(f))) };
    if (!candidates.includes(f)) return { said: pool[0] === f ? "시작 화면" : "끝 화면" };
    const near = nearCheck(f);
    return near ? { line: near } : { said: writer((sents) => clean(sents.find((t) => t.length >= 15) || sents[0] || "")) || "확인 중 화면" };
  };
  const stateOf = (f) => { const vs = verdictsOf(f); return !vs.length ? "none" : vs.some((x) => !x.pass) ? "fail" : "pass"; };
  const still = (f) => verdictsOf(f).every((x) => (x.effects || []).length > 0 && x.effects.every((e) => e.type === "none"));
  const rankOf = (f) => (refOf(f) ? RANK.cited : stateOf(f) === "fail" ? RANK.fail
    : f.why === "찍음" && f.claimKind !== "S5" && ownCaption(f) ? RANK.own : stateOf(f) === "pass" ? (still(f) ? RANK.still : RANK.pass) : RANK.auto);
  // 증거 사진: 회차 사진과 같은 검사(지금 파일을 읽어 sha256 을 다시 구하고 판독 불가 크기는 뺌), hide 먼저, 같은 파일만 묶음, 상한 없음
  const evidenceItems = evidence.filter((e) => { if (usable(e.f)) return true; skipped.tiny += 1; return false; })
    .map((e, i) => ({ f: e.f, k: i - evidence.length, rank: e.bad ? RANK.fail : RANK.evidence, caption: e.band, bad: e.bad, evidence: true,
      state: e.bad ? "fail" : e.pass === true ? "pass" : "none", sha: h.fileSha ? shaOf(e.f.path) : e.f.sha256 || null, unstable: false }));
  const items = [
    ...evidenceItems,
    ...pool.map((f, k) => ({ f, k, rank: rankOf(f), caption: captionOf(f), bad: stateOf(f) === "fail", state: stateOf(f),
      sha: shaOf(f.path), unstable: unstable(f), cited: refOf(f) })),
  ].filter((x) => {
    // 사진 파일을 읽지 못하면 고르기 전에 빼고 셈. 고른 뒤에 빠지면 그 자리를 다음 사진이 못 채움
    if (h.fileSha && !x.sha) { skipped.lost += 1; return false; }
    return !hiddenSha(x.sha);
  });
  for (const x of items) {
    const edit = x.sha && edits.get(x.sha);
    if (edit?.caption) x.caption = { said: edit.caption };
  }
  // 같은 사진 묶기: 같은 파일(sha256)은 늘 묶고 설명을 모두 남김. 거의 같은 사진(dHash)은 설명과 판정 상태가 같을 때만.
  // 증거 사진과 판정 글이 번호로 가리킨 사진은 확인자가 따로 고른 증거라 묶지 않음. "사진 11은 저장 전, 12는 저장 후"처럼 한 문장이 두 사진을 비교하기도 함.
  // 대표 사진과만 비교(연쇄 없음). 증거 사진이 먼저 대표가 됨
  const reps = [];
  const own = (x) => !x.evidence && !x.cited;
  for (const x of [...items].sort((a, b) => Number(!a.evidence) - Number(!b.evidence) || a.rank - b.rank || a.k - b.k)) {
    x.hash = h.sceneHash ? h.sceneHash(x.f.path) : null;
    const near = (r) => own(r) && own(x) && r.state === x.state && captionKey(r.caption) === captionKey(x.caption)
      && x.hash != null && r.hash != null && hashDistance(r.hash, x.hash) <= NEAR_SAME_BITS;
    const rep = reps.find((r) => (x.sha && r.sha === x.sha) || near(r));
    if (rep) { skipped.same += 1; rep.captions.push(x.caption); rep.members.push(x); continue; }
    reps.push({ ...x, captions: [x.caption], members: [x] });
  }
  // 상한은 증거 사진 밖의 대표 사진에만. 판정 글이 가리킨 사진은 상한을 넘어 12장까지
  const proof = reps.filter((r) => r.evidence), rest = reps.filter((r) => !r.evidence);
  const chosen = (r) => r.members.some((m) => m.cited);
  const limit = h.sceneLimit ? Math.max(h.sceneLimit, Math.min(rest.filter(chosen).length, 12)) : 0;
  const picked = [];
  if (limit) for (const rank of [...new Set(rest.map((r) => r.rank))].sort((a, b) => a - b)) {
    picked.push(...spread(rest.filter((r) => r.rank === rank).sort((a, b) => a.k - b.k), limit - picked.length));
  }
  const kept = [...proof, ...(limit ? picked : rest)];
  // 덮어쓰기 요청마다 결과: 뺌, 보임(설명 적용), 안 보임(입력 중간·상한 등으로 고르지 않음)
  if (edits.size) {
    const laneShas = new Set([...live.map((f) => shaOf(f.path)), ...evidenceItems.map((x) => x.sha)].filter(Boolean));
    const seenShas = new Set(kept.flatMap((r) => r.members.map((m) => m.sha)));
    for (const [x, edit] of edits) {
      if (!laneShas.has(x)) continue;
      if (edit.hide) { skipped.hidden += 1; log?.hidden.push(x); } else (seenShas.has(x) ? log?.applied : log?.notShown)?.push(x);
    }
  }
  ln.omitted = rest.length - (kept.length - proof.length);
  ln.skipped = skipped;
  // 보이는 순서는 증거 사진, 나머지는 시간순. 처음 보이는 사진은 증거 > 판정 글이 가리킨 사진 > 실패 판정 중 가장 앞 순위
  const order = [...proof, ...kept.filter((r) => !r.evidence).sort((a, b) => a.k - b.k)];
  const lead = (r) => (r.evidence ? 0 : r.members.some((m) => m.cited) ? 1 : r.state === "fail" ? 2 : 3);
  const first = order.reduce((best, r, i) => (lead(r) < lead(order[best]) ? i : best), 0);
  return order.map((r, i) => ({ f: { ...r.f, sha256: r.sha || undefined }, bad: r.bad, first: i === first && lead(r) < 3,
    band: `${bandOf(r.captions)}${r.unstable ? " · 안정 전 촬영" : ""}` }));
}

// overview.cases[].checks 의 증거 사진. 장면 고르기의 후보로 들어감
// 확인 글과 사진 설명은 overview 에 직접 쓴 글이라 text 고치기 대상이 아님
function evidenceScenes(extra) {
  return extra.flatMap((c) => (c.evidence || []).map((ev) => ({ f: { path: ev.file, sha256: ev.sha256 },
    band: { said: c.text, line: ev.caption }, bad: c.pass === false, pass: c.pass })));
}

// 같은 확인 줄은 한 줄로 묶고 횟수를 셈. 재시도로 같은 줄이 수십 번 되풀이된 사례. 묶기는 잘라내기 전 값(key)으로
export function collapseChecks(checks) {
  const byKey = new Map();
  for (const c of checks) {
    const key = c.key || JSON.stringify([c.kind, c.target, c.want, c.got, c.pass]);
    const hit = byKey.get(key);
    if (hit) hit.count += 1; else byKey.set(key, { ...c, count: 1 });
  }
  return [...byKey.values()];
}

const TINY = 64;
// 장면은 한 자리에 한 장씩 크게 싣고 넘긴다. 나란히 늘어놓으면 한 장이 작아져 글자를 못 읽는다.
function carouselHtml(dir, key, all, h) {
  let lost = 0, tiny = 0;
  const scenes = all.map((s, k) => {
    const kept = h.keepShot(dir, s.f.path, `plain-${key}-${String(k + 1).padStart(2, "0")}`);
    const size = kept && h.pngSize(kept);
    if (size && (size.w < TINY || size.h < TINY)) { tiny += 1; return null; }
    const src = kept && h.dataUri(kept);
    if (!src) { lost += 1; return null; }
    return { ...s, src, marks: s.f.marks || h.readMarks(kept) };
  }).filter(Boolean);
  const gone = [lost ? `파일 유실 장면 ${lost}장` : "", tiny ? `판독 불가 크기 장면 ${tiny}장 제외` : ""].filter(Boolean);
  if (!scenes.length) return { html: "", gone };
  const n = scenes.length;
  // 처음 보이는 장면(증거·판정 글이 가리킨 사진·실패 판정). 넘기는 순서는 그대로
  const on = Math.max(0, scenes.findIndex((s) => s.first));
  return { gone, html: `<div class="car" aria-roledescription="캐러셀" aria-label="장면 ${n}장">
    <div class="view">${scenes.map((s, k) => `<figure class="sc${k === on ? " on" : ""}${s.bad ? " bad" : ""}"${k === on ? "" : " hidden"}${s.f.sha256 ? ` data-sha256="${s.f.sha256}"` : ""}>
      <button type="button" class="shot" aria-label="장면 ${k + 1} 크게 보기"><span class="frame"><img src="${s.src}" alt="${h.esc(s.band)}" loading="lazy" decoding="async">${
        h.boxesOf({ marks: s.marks })}</span></button>
      <figcaption aria-live="polite"><b>${k + 1}/${n}</b><span>${h.esc(s.band)}</span></figcaption></figure>`).join("")}
      ${n > 1 ? `<button type="button" class="arw prev" aria-label="이전 장면">‹</button><button type="button" class="arw next" aria-label="다음 장면">›</button>` : ""}</div>
    ${n > 1 ? `<ol class="thumbs">${scenes.map((s, k) => `<li><button type="button" class="th${k === on ? " on" : ""}${s.bad ? " bad" : ""}" data-i="${k}"${
      k === on ? ' aria-current="true"' : ""} aria-label="장면 ${k + 1}: ${h.esc(s.band.slice(0, 60))}"><img alt=""><b>${k + 1}</b></button></li>`).join("")}</ol>` : ""}</div>` };
}

// 120자 넘는 줄은 앞부분만 보이고 펼쳐서 전체를 봄. label 을 주면 요약줄은 label, 펼치면 본문
const shortText = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
function lineItem(x, h, label) {
  return shownItem(plainText(x, h.knownSeq), h, label);
}
// 이미 Iris 낱말 바꾸기와 확인자 글 고치기를 거친 글
function shownItem(x, h, label) {
  if (label) return x ? `<details class="more"><summary>${h.esc(label)}</summary><p>${h.esc(x)}</p></details>` : h.esc(label);
  return x.length > 120 ? `<details class="more"><summary>${h.esc(shortText(x, 90))}</summary><p>${h.esc(x)}</p></details>` : h.esc(x);
}
function shownLines(text, h, cls = "result") {
  const xs = splitLines(text);
  return xs.length ? `<ul class="${cls}">${xs.map((x) => `<li>${shownItem(x, h)}</li>`).join("")}</ul>` : "";
}
function linesHtml(note, h, cls = "result") {
  const xs = splitLines(note).map((x) => plainText(x, h.knownSeq)).filter(Boolean);
  return xs.length ? `<ul class="${cls}">${xs.map((x) => `<li>${lineItem(x, h)}</li>`).join("")}</ul>` : "";
}
// 케이스 이름이 없을 때 표에 쓰는 짧은 이름. 선언 설명의 ':' 앞 또는 앞 40자
const shortName = (what) => { const s = String(what || "").trim(); const head = s.split(/[:：]/)[0].trim(); return shortText(head.length >= 4 ? head : s, 40); };
function kindChips(kinds, h) {
  return (kinds || []).map((k) => `<span class="kind">${h.esc(k)}</span>`).join("");
}
// 글 고치기 칸의 기본값. 인자 기본값에 화살표를 쓰면 구조 검사(떼어낸 MCP 모듈의 이름 찾기)가 인자를 읽지 못함
const same = (t) => t;
const noSource = () => [];
// say: 앞 선언 이름(마우스를 올리면 보이는 글)의 확인자 글 고치기
function historyHtml(history, h, say = same) {
  return `<ol class="hist">${history.map((x) => `<li><span class="run">${h.esc(x.run.replace(/ 회차$/, ""))}</span><span class="chip ${x.color}">${PLAIN[x.color] || x.color}</span>${
    x.replaced ? `<small title="${h.esc(say(x.replaced))}">다른 선언</small>` : ""}${x.reportable === false ? `<small>보고서 검사 미통과</small>` : ""}</li>`).join("")}</ol>`;
}

function flowHtml(what, h) {
  const parts = String(what || "").split(/\s*>\s*/).map((x) => x.trim()).filter(Boolean);
  return `<ol class="flow">${parts.map((x) => `<li>${h.esc(x)}</li>`).join("")}</ol>`;
}

// 확인 줄은 실패 → 미확인 → 통과 → 반복 확인 통과 순, 여섯 줄(실패가 더 많으면 실패 전부)까지 보이고 나머지는 접음.
// 한 경로에 확인 31건이 세로로 늘어서던 사례. 줄마다 종류 칩. pass 가 없는 바깥 확인은 "확인"으로 적음
// 반복 확인: 같은 효과를 서로 다른 줄 3개 이상에서 확인한 통과 줄(여러 조작 뒤 매번 보는 화면 기준). 효과가 여럿이면 모두 반복일 때만
const REPEAT_MIN = 3;
export function orderChecks(checks) {
  const lines = collapseChecks(checks);
  const seenIn = new Map();
  for (const c of lines) for (const k of new Set(c.effKeys || [])) seenIn.set(k, (seenIn.get(k) || 0) + 1);
  const repeated = (c) => c.pass === true && (c.effKeys || []).length > 0 && c.effKeys.every((k) => seenIn.get(k) >= REPEAT_MIN);
  // 효과가 변화 없음뿐인 통과 줄은 반복 확인을 포함한 다른 통과 줄 모두의 뒤(접기에 먼저 들어감). 분류 이름은 붙이지 않음
  const still = (c) => c.pass === true && (c.effKeys || []).length > 0 && c.effKeys.every((k) => JSON.parse(k)[0] === "none");
  const passed = lines.filter((c) => c.pass === true && !still(c));
  return [...lines.filter((c) => c.pass === false), ...lines.filter((c) => typeof c.pass !== "boolean"),
    ...passed.filter((c) => !repeated(c)), ...passed.filter(repeated), ...lines.filter(still)];
}
function checksHtml(checks, h) {
  const verdict = (c) => (c.pass === true ? ["ok", "통과"] : c.pass === false ? ["no", "실패"] : ["ck", "확인"]);
  const item = (c) => `<li class="${verdict(c)[0]}"><b>${verdict(c)[1]}</b><span class="kind">${h.esc(c.kind)}</span><span>${
    c.target ? `<em>${h.esc(c.target)}</em>` : ""}${h.esc(c.want)}${
    c.got ? `<small title="${h.esc(c.got)}">실제값 ${h.esc(c.got)}</small>` : ""}</span>${c.count > 1 ? `<i class="n">${c.count}회</i>` : ""}</li>`;
  const ordered = orderChecks(checks);
  const shown = Math.max(6, ordered.filter((c) => c.pass === false).length);
  const rest = ordered.slice(shown);
  return `<ul class="checks">${ordered.slice(0, shown).map(item).join("")}</ul>${
    rest.length ? `<details class="more"><summary>나머지 확인 ${rest.length}줄</summary><ul class="checks">${rest.map(item).join("")}</ul></details>` : ""}`;
}

// 기기 확인 줄과 overview.cases[].checks 줄. 종류 거르기가 이 줄들의 종류를 모아 씀
const laneChecks = (ln, extra = []) => [...extra.map((c) => ({ kind: c.kind, target: "", want: c.text, got: "", pass: c.pass,
  key: JSON.stringify(["바깥", c.kind, c.text, c.pass ?? null]) })),
  ...(ln.receipts || []).map(checkText)];
export function caseKinds(r, info) {
  const lanes = r.paths.map((p) => r.lanes.get(p)).filter(Boolean);
  return [...new Set([...(info?.checks || []).map((c) => c.kind), ...lanes.flatMap((ln) => (ln.receipts || []).length ? [DEVICE_KIND] : [])])];
}

// ctx: voidShots 무효 판정 사진 전체, edits·shas·tx·log 는 그 케이스의 덮어쓰기(pickScenes 참고)
function laneHtml(dir, r, ln, many, h, ctx, extra = []) {
  const lc = ln.color || "gray";
  const field = ctx.field;
  const plain = (t) => plainText(t, h.knownSeq);
  // 여러 줄 글은 줄마다 Iris 낱말 바꾸기를 거친 뒤 줄바꿈으로 이음(linesHtml 이 다시 나눔)
  const plainLines = (t) => splitLines(t).map(plain).filter(Boolean).join("\n");
  // 무효는 판정 단위. 같은 사진을 이 경로의 유효 판정도 쓰면 그 사진은 남김
  const valid = new Set((ln.receipts || []).map((x) => x.shot).filter(Boolean));
  const voided = new Set([...ctx.voidShots].filter((p) => !valid.has(p)));
  const evidence = evidenceScenes(extra);
  for (const e of evidence) if (e.f.sha256) ctx.shas.add(e.f.sha256);
  // 통과 경로에서 실패한 기기 확인(나중에 다시 통과했거나 조작 순서 문제)은 목록에서 빼고 접어 둠. 통과 케이스에 실패가 섞여 보인 사례
  const all = laneChecks(ln, extra);
  for (const c of all.slice(extra.length)) ctx.gen(c.want);
  const retried = lc === "green" ? all.filter((c, i) => i >= extra.length && c.pass === false) : [];
  const checks = all.filter((c) => !retried.includes(c));
  const stale = (ln.frames || []).filter((f) => h.frameStale(f)).length;
  const voids = ln.voids || [];
  const aside = ln.aside || [];
  const car = carouselHtml(dir, `${r.id}-${ln.path}`, pickScenes(ln, h, { ...ctx, voided, evidence }), h);
  const tiny = (ln.frames || []).filter((f) => {
    if (f.why !== "찍음" && f.why !== "판정") return false;
    const d = h.pngSize(f.path); return !!d && (d.w < TINY || d.h < TINY);
  }).length;
  const sk = ln.skipped || {};
  const skipped = [sk.same && `거의 같은 장면 ${sk.same}장`, sk.typing && `입력 중간 장면 ${sk.typing}장`,
    sk.unstable && `안정 전 촬영 장면 ${sk.unstable}장`, sk.failInPass && `통과 전 실패 장면 ${sk.failInPass}장`,
    sk.lost && `파일을 읽지 못한 장면 ${sk.lost}장`, sk.hidden && `확인자가 뺀 장면 ${sk.hidden}장`].filter(Boolean);
  const files = extra.flatMap((c) => c.evidence || []);
  // 제외 사유는 펼쳐서 봄. 사유 문장이 경고 칸에 그대로 이어져 케이스마다 긴 글이 쌓이던 사례
  const out = [
    ...voids.map((v) => shownItem(v.why ? field("무효 사유")(v.why, (t) => plain(`사유: ${t}`)) : "", h, "잘못 설정한 확인 제외")),
    ...aside.map((a) => shownItem(a.why ? field("제외 사유")(a.why, (t) => plain(`사유: ${t}`)) : "", h, "증거에서 제외한 장면")),
    retried.length ? `<details class="more"><summary>${h.esc(`통과 전에 실패한 확인 ${retried.length}건`)}</summary>${checksHtml(retried, h)}</details>` : "",
    stale ? h.esc(`촬영 시각 불일치 장면 ${stale}장 제외`) : "",
    tiny + (sk.tiny || 0) ? h.esc(`판독 불가 크기 장면 ${tiny + (sk.tiny || 0)}장 제외`) : "",
    skipped.length ? h.esc(`${skipped.join(", ")} 제외`) : "",
    // 개발자용 보고서는 경로의 장면을 모두 그림. 회차마다 보고서가 있지는 않음
    ln.omitted ? (ctx.devLink ? `<a href="${h.esc(ctx.devLink)}">${h.esc(`나머지 장면 ${ln.omitted}장은 개발자용 보고서에 있음`)}</a>`
      : h.esc(`나머지 장면 ${ln.omitted}장은 개발자용 보고서에 있음`)) : "",
    ...car.gone.map(h.esc),
  ].filter(Boolean);
  const picks = Array.isArray(ln.options) ? ln.options : [];
  const passed = checks.filter((c) => c.pass === true).length;
  const info = `<div class="info">
    ${many ? `<h3>${h.esc(ln.path)} 경로 <span class="chip ${lc}">${PLAIN[lc]}</span></h3>` : ""}
    <section><h4>결과</h4>${shownLines(field("결과")(ln.note || "", plainLines), h) || `<p class="none">${ln.color ? "결과 기록 없음" : "미확인"}</p>`}</section>
    ${Array.isArray(ln.history) && ln.history.length ? `<section><h4>판정 이력</h4>${historyHtml(ln.history, h, field("판정 이력"))}</section>` : ""}
    ${checks.length ? `<section><h4>확인 ${checks.length}건 · 통과 ${passed}건</h4>${checksHtml(checks, h)}</section>` : ""}
    ${files.length ? `<details class="more files"><summary>증거 파일 ${files.length}개</summary><ul>${files.map((f) => `<li><span>${h.esc(f.file.split("/").at(-1))}</span><code>sha256 ${f.sha256}</code></li>`).join("")}</ul></details>` : ""}
    ${picks.length || ln.lean ? `<section class="ask"><h4>선택지</h4>${picks.length ? `<ol class="picks">${picks.map((o) => `<li><b>${h.esc(field("선택지")(o.pick))}</b>${
      o.then ? `<span>선택 시 ${h.esc(field("선택지")(o.then))}</span>` : ""}${o.cost ? `<span>감수할 점 ${h.esc(field("선택지")(o.cost))}</span>` : ""}</li>`).join("")}</ol>` : ""}${
      ln.lean ? `<p class="lean">확인자 의견 ${h.esc(field("확인자 의견")(ln.lean))}</p>` : ""}</section>` : ""}
    ${out.length ? `<ul class="warn">${out.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}</div>`;
  return `<div class="lane${car.html ? "" : " noscene"}">${car.html}${info}</div>`;
}

// 기록 객체 안의 글 전부. 규칙이 원문 규칙인지 정할 때 씀. 그리는 칸 목록을 따로 두면 새 칸이 생길 때 어긋남
function textsIn(value, out = [], seen = new WeakSet()) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const x of value instanceof Map ? value.values() : value instanceof Set ? value : Array.isArray(value) ? value : Object.values(value)) textsIn(x, out, seen);
  }
  return out;
}
// 확인자 글 고치기(overview.cases[].text, overview.text). 규칙마다 처음에 한 번 정함: from 이 그 범위 기록(케이스는 그 케이스 줄,
// overview.text 는 보고서 전체 기록)의 글 어디엔가 있으면 원문 규칙, 없으면 표시 규칙. 칸마다 정하면 같은 낱말이 한 칸에서는 원문,
// 다른 칸에서는 Iris 가 바꾼 글(qa_note → 메모)이라 원문 규칙이 Iris 글까지 바꿈.
// 순서: 원문 규칙 전부(케이스 규칙 → overview.text, 적은 순서대로 차례로) → Iris 바꾸기·이름표 → 표시 규칙 전부(같은 순서).
// 한 번도 바꾸지 못한 규칙은 오류(앞 규칙이 먼저 바꾼 경우는 빼고). 그리지 않는 칸에만 있는 원문 때문이어도 조용히 넘어가지 않음.
// 구조에서 만든 문장(확인 줄)은 gen, overview 에 직접 쓴 글은 direct 로 모아 오류 안내에만 씀
function textEditor(caseRules, reportRules, sourceOf = noSource, allSource = []) {
  const corpus = new Map(), all = (allSource || []).join("\n");
  const rawIn = (scope) => { if (scope == null) return all; if (!corpus.has(scope)) corpus.set(scope, sourceOf(scope).join("\n")); return corpus.get(scope); };
  const make = (list, scope) => (list || []).map((x) => ({ ...x, scope, raw: rawIn(scope).includes(x.from), hits: 0, chained: 0 }));
  const own = new Map([...caseRules].map(([id, list]) => [id, make(list, id)]));
  const report = make(reportRules, null);
  const seen = [], made = [], direct = [];
  const rulesOf = (scope) => [...(own.get(scope) || []), ...report];
  const replace = (x, out, origin) => {
    if (!out.includes(x.from)) return out;
    if (origin.includes(x.from)) x.hits += 1; else x.chained += 1;
    return out.split(x.from).join(x.to);
  };
  const tx = (scope, field) => (t) => {
    const raw = String(t ?? ""); let out = raw;
    for (const x of rulesOf(scope)) if (x.raw) out = replace(x, out, raw);
    seen.push({ scope, field, text: raw, out });
    return out;
  };
  // base: 원문 규칙 없이 만든 표시 글, edited: 원문 규칙을 적용해 만든 표시 글. 표시 규칙은 edited 에서 찾음
  // (원문 규칙이 바꾼 뒤 화면에 나갈 글). base 는 바뀌기 전 글로 적은 규칙을 오류로 알리는 데만 씀
  const display = (scope, field) => (source, base, edited) => {
    const start = String(edited ?? ""); let out = start;
    for (const x of rulesOf(scope)) if (!x.raw) out = replace(x, out, start);
    seen.push({ scope, field, text: start, base: String(base ?? ""), out });
    return out;
  };
  const show = (scope, field) => (t, compose = same) => display(scope, field)(t, compose(String(t ?? "")), compose(tx(scope, field)(t)));
  const gen = (t) => { made.push(String(t ?? "")); return t; };
  const rules = () => [...[...own.values()].flat(), ...report];
  return { tx, display, show, gen, direct: (t) => { if (t) direct.push(String(t)); },
    // 한 번도 바꾸지 못한 규칙마다 그 글이 실제로 있는 곳
    problems(nameOf) {
      const where = (e) => (e.scope == null ? e.field : `${nameOf(e.scope)}의 ${e.field}`);
      const mineOf = (x) => (e) => x.scope == null || e.scope === x.scope;
      // 그 범위에 그린 글(원문 규칙은 원문, 표시 규칙은 원문 규칙 뒤 표시 글)에 있었지만 앞 규칙이 먼저 바꿔
      // 남은 곳이 없는 규칙은 오류가 아님(결과에 바꾼 수 0)
      const consumed = (x) => seen.some((e) => mineOf(x)(e) && e.text.includes(x.from));
      return rules().filter((x) => !x.hits && !consumed(x)).map((x) => {
        const mine = mineOf(x);
        const head = x.scope == null ? `overview.text.from '${x.from}'` : `${x.scope}: text.from '${x.from}'`;
        // 사진 설명은 결과·장면 판단에서 나온 글이라 그 원래 칸을 먼저 알림
        const others = seen.filter((e) => !mine(e) && (e.text.includes(x.from) || e.out.includes(x.from)));
        const other = others.find((e) => e.field !== "사진 설명") || others[0];
        const why = x.chained ? "앞 규칙의 to에서만 나옴. 이 규칙을 그 앞 규칙보다 먼저 두거나 원문 글로"
          : seen.some((e) => mine(e) && e.base?.includes(x.from)) ? "원문 규칙이 먼저 바꾼 글. 바뀐 뒤 글로"
          : other ? `${where(other)}에 있음. ${other.scope == null ? "케이스 밖 글은 overview.text로" : "그 케이스의 text나 overview.text로"}`
          : direct.some((t) => t.includes(x.from)) ? "overview에 직접 쓴 글(범위·기능·케이스 제목·흐름·결과·확인 글·사진 설명)이라 overview에서 고침"
          : made.some((t) => t.includes(x.from)) ? "확인 줄은 기록에서 만든 문장이라 바꿀 수 없음. 사진 설명은 scenes.caption으로"
          : x.raw ? "기록에는 있으나 보고서에 보이는 글이 아님"
          : "보고서 어디에도 없음";
        return `${head}(${why})`;
      });
    },
    // 규칙마다 원문·보이는 글 중 어디에 적용했고 몇 곳을 바꿨는지
    result: () => rules().map((x) => ({ scope: x.scope ?? "overview", from: x.from, how: x.raw ? "원문" : "보이는 글", count: x.hits })) };
}

// 케이스 하나의 덮어쓰기. scenes 는 sha256 으로 사진 설명을 바꾸거나 뺌. overview 에 직접 쓴 title·flow·result·caption 은 text 대상이 아님.
// 가리킨 사진이 그 케이스에 없으면 renderPlain 이 오류로 멈춤(조용히 무시하면 고쳤다고 믿게 됨)
function caseEdits(info, voidShots, log, editor, scope) {
  const edits = new Map((info?.scenes || []).map((x) => [x.sha256, x]));
  const shas = new Set();
  return { tx: editor.tx(scope, "사진 설명"), field: (name) => editor.show(scope, name), display: editor.display(scope, "사진 설명"), gen: editor.gen,
    edits, shas, voidShots, log,
    problems: () => [...edits.keys()].filter((x) => !shas.has(x)).map((x) => `scenes.sha256 ${x}(그 케이스 사진에 없거나 파일을 읽지 못함)`) };
}

// 장부의 줄 번호(W1·A1)는 확인자가 붙인 약어라 읽는 사람이 뜻을 모른다. 기본 지면은 순서대로
// Case 1, Case 2로 부르고 장부 번호는 개발자 지면에만 둔다.
function rowHtml(dir, r, i, h, ctx, reqsOf = new Map(), featNames = [], info = null) {
  const c = h.rowColor(r);
  const field = ctx.field;
  const plain = (t) => plainText(t, h.knownSeq);
  const lanes = r.paths.map((p) => r.lanes.get(p) || { path: p, frames: [], receipts: [] });
  const basis = BASIS_PLAIN[r.basis];
  const quotes = r.quotes && r.quotes.length ? r.quotes : r.quote ? [r.quote] : [];
  const srcShot = r.sourceShot ? h.keepShot(dir, r.sourceShot, `plain-basis-${r.id}`) : null;
  const srcUri = srcShot && h.dataUri(srcShot);
  const srcLost = r.sourceShot && !srcUri;
  return `<article id="w${i + 1}" class="row ${c}">
    <header data-kinds-of="${h.esc(caseKinds(r, info).join("|"))}"><span class="id">Case ${i + 1}</span><span class="chip ${c}">${PLAIN[c]}</span>${
      ctx.unchecked ? `<span class="chip gray">보고서 검사 미통과 회차</span>` : ""}${
      (reqsOf.get(String(r.id)) || []).map((k) => `<a class="reqlink" href="#q${k}">${h.esc(featNames[k - 1] || `기능 ${k}`)}</a>`).join("")}</header>
    ${info?.title ? `<h3 class="ttl">${h.esc(info.title)}</h3>` : ""}
    ${flowHtml(info?.flow || field("확인 항목 설명")(r.what), h)}
    ${info?.flow && r.what ? `<details class="more orig"><summary>선언한 확인 항목 원문</summary><p>${h.esc(field("확인 항목 설명")(r.what))}</p></details>` : ""}
    <dl class="meta">${r.given ? `<div><dt>조건</dt><dd>${shownItem(field("조건")(String(r.given), plain), h)}</dd></div>` : ""}${
      basis ? `<div><dt>기대 근거</dt><dd>${shownItem(r.basisNote ? field("기대 근거")(r.basisNote, (t) => plain(`${basis} · ${t}`)) : basis, h)}</dd></div>` : ""}</dl>
    ${quotes.length || srcUri ? `<div class="quote">${quotes.map((q) => `<blockquote>${h.esc(field("인용")(String(q)))}</blockquote>`).join("")}${
      srcUri ? `<button type="button" class="shot src" aria-label="근거 화면 크게 보기"><span class="frame"><img src="${srcUri}" alt="근거 화면"></span></button>` : ""}</div>` : ""}
    ${srcLost ? `<p class="warn">근거 화면 파일 유실</p>` : ""}
    ${lanes.map((ln, k) => laneHtml(dir, r, ln, lanes.length > 1, h, ctx, k ? [] : info?.checks || [])).join("")}</article>`;
}

// say: 결정할 사항 칸의 확인자 글 고치기
function noteHtml(dir, nt, h, say = same) {
  const shot = nt.shot ? h.keepShot(dir, nt.shot, "plain-note-" + nt.id) : null;
  const src = shot && h.dataUri(shot);
  const picks = Array.isArray(nt.options) ? nt.options : [];
  const lines = (t) => say(t, (v) => splitLines(v).map((x) => plainText(x, h.knownSeq)).filter(Boolean).join("\n"));
  return `<article class="row blue decide">
    <header><span class="chip blue">결정 대기</span></header>
    <p class="q">${h.esc(say(nt.decide || ""))}</p>
    ${shownLines(lines(nt.what), h)}${nt.why ? shownLines(lines(nt.why), h) : ""}
    ${src ? `<div class="car"><div class="view"><figure class="sc on"><button type="button" class="shot" aria-label="크게 보기"><span class="frame"><img src="${src}" alt="당시 화면"></span></button><figcaption><b>1/1</b><span>당시 화면</span></figcaption></figure></div></div>` : ""}
    ${picks.length ? `<ol class="picks">${picks.map((o) => `<li><b>${h.esc(say(o.pick))}</b>${
      o.then ? `<span>선택 시 ${h.esc(say(o.then))}</span>` : ""}${o.cost ? `<span>감수할 점 ${h.esc(say(o.cost))}</span>` : ""}</li>`).join("")}</ol>` : ""}</article>`;
}

// 맨 위는 기능 추적표다. 사용자의 최종 요구를 기능 단위로 종합하고, 확인자가 그것을 어떻게
// 이해해서 무엇을 만들었는지, 어느 케이스가 스크린샷으로 확인했는지를 기능 한 줄로 잇는다.
// 이 보고서 한 장으로 요구·이해·구현·검증을 대조하려는 것이다. 요청 발화를 하나씩 늘어놓지 않는다.
// 기능 안에서 케이스가 없는 부분은 "확인하지 않은 것"으로 그 자리에 적는다.
function asLines(v) {
  return (Array.isArray(v) ? v : splitLines(v)).map((x) => String(x).trim()).filter(Boolean);
}
function featuresHtml(features, caseOf, h) {
  const list = (Array.isArray(features) ? features : []).filter((q) => q && (q.name || q.need || q.built));
  if (!list.length) return "";
  const linked = (q) => (Array.isArray(q.cases) ? q.cases : []).map((id) => caseOf.get(String(id))).filter(Boolean);
  const gapsOf = (q) => asLines(q.gaps);
  const withGap = list.filter((q) => !linked(q).length || gapsOf(q).length).length;
  return `<h2>기능과 구현 ${list.length}</h2>
  <p class="tally"><span class="chip gray">기능 ${list.length}</span>${
    withGap ? `<span class="chip yellow">확인하지 않은 것이 있는 기능 ${withGap}</span>` : ""}</p>
  <ol class="req">${list.map((q, k) => {
    const cs = linked(q);
    const gaps = gapsOf(q);
    return `<li id="q${k + 1}">
    <div class="need"><h3>${h.esc(q.name || `기능 ${k + 1}`)}</h3><h4>최종 요구</h4>${linesHtml(asLines(q.need).join("\n"), h, "plain")}</div>
    <div><h4>AI 이해</h4>${linesHtml(asLines(q.understood).join("\n"), h, "plain")}</div>
    <div><h4>구현</h4>${linesHtml(asLines(q.built).join("\n"), h, "plain")}</div>
    <div class="cases"><h4>확인</h4>${cs.length
      ? cs.map((c) => `<a class="chip ${c.color}" href="#w${c.i + 1}">Case ${c.i + 1} ${PLAIN[c.color]}</a>`).join("")
      : `<span class="chip yellow">확인 케이스 없음</span>`}${
      gaps.length || (!cs.length && q.why) ? `<small class="gap">확인하지 않은 것<br>${[...gaps, ...(!cs.length && q.why ? [q.why] : [])].map(h.esc).join("<br>")}</small>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

// 역할별 흐름도. 역할은 제품마다 다르므로 부르는 쪽이 정한다.
function diagramsHtml(diagrams, h) {
  const list = Array.isArray(diagrams) ? diagrams : [];
  if (!list.length) return "";
  return `<h2>역할별 흐름</h2><div class="lanes-wrap">${list.map((d, k) => lanesSvg(d, k + 1, h.esc)).join("")}</div>`;
}

// 예전 형태(블록 목록)도 받는다. 블록마다 제목·흐름·사실 줄.
function blocksHtml(blocks, h) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && (b.title || b.flow || (b.lines || []).length));
  if (!list.length) return "";
  return `<div class="ov">${list.map((b) => `<section>
    ${b.title ? `<h3>${h.esc(b.title)}</h3>` : ""}${b.flow ? flowHtml(b.flow, h) : ""}${
      Array.isArray(b.lines) && b.lines.length ? `<ul>${b.lines.map((x) => `<li>${h.esc(x)}</li>`).join("")}</ul>` : ""}</section>`).join("")}</div>`;
}

// "항목: 값" 줄은 두 칸으로, 쉼표로 셋 이상 나열한 값은 칩으로. 회차·판정 변경·대체는 표
// caseField(id, 칸 이름)·outside(칸 이름): 기록에서 온 글(케이스 이름·앞 선언·대신한 이유)의 확인자 글 고치기
const keepText = () => (t, compose = same) => compose(String(t ?? ""));
function scopeHtml(overview, caseOf, infoOf, nameOf, h, caseField = keepText, outside = keepText) {
  const lines = asLines(overview.scope);
  const combined = overview.combined || {};
  const runs = Array.isArray(combined.runs) ? combined.runs : [];
  const changes = Array.isArray(combined.changes) ? combined.changes : [];
  const replaced = Array.isArray(combined.replaced) ? combined.replaced : [];
  if (!lines.length && !runs.length) return "";
  const caseLink = (id) => { const c = caseOf.get(String(id)); return c ? `<a class="chip ${c.color}" href="#w${c.i + 1}">Case ${c.i + 1}</a>` : h.esc(id); };
  const caseName = (id) => h.esc(infoOf.get(String(id))?.title || caseField(id, "확인 항목 설명")(nameOf(id), shortName));
  const value = (v) => { const parts = v.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
    return parts.length >= 3 ? `<span class="vals">${parts.map((x) => `<span class="val">${h.esc(x)}</span>`).join("")}</span>` : lineItem(v, h); };
  const pairsHtml = lines.length ? `<dl class="pairs scope">${lines.map((x) => {
    const m = /^([^:：]{1,16})[:：]\s*(.+)$/.exec(x);
    return m ? `<dt>${h.esc(m[1].trim())}</dt><dd>${value(m[2])}</dd>` : `<dt>범위</dt><dd>${value(x)}</dd>`;
  }).join("")}</dl>` : "";
  // 보고서 검사 뜻과 케이스마다 고르는 회차(pickFinalRuns 규칙)
  const runsHtml = runs.length ? `<h3>합친 회차 ${runs.length}</h3><table class="sum mini"><thead><tr><th>회차</th><th>이 보고서의 케이스</th><th>보고서 검사</th></tr></thead><tbody>${
    runs.map((r) => `<tr><td class="id">${h.esc(r.label.replace(/ 회차$/, ""))}</td><td>${r.cases.length ? r.cases.map(caseLink).join(" ") : `<span class="none">없음</span>`}</td><td>${
      r.reportable ? `<span class="chip green">통과</span>` : `<span class="chip yellow">미통과</span>`}</td></tr>`).join("")}</tbody></table>
    <p class="note">보고서 검사: 회차 기록이 보고서 조건을 갖췄는지. 케이스마다 검사를 통과한 마지막 회차의 판정을 쓰고, 통과한 회차가 없으면 마지막 회차 판정을 씀</p>` : "";
  const changesHtml = changes.length ? `<h3>뒤 회차에서 판정이 바뀐 케이스 ${changes.length}</h3><table class="sum mini"><thead><tr><th>케이스</th><th>이름</th><th>판정 이력</th></tr></thead><tbody>${
    changes.map((c) => `<tr><td class="id">${caseLink(c.id)}</td><td>${caseName(c.id)}</td><td>${historyHtml(c.history, h, caseField(c.id, "판정 이력"))}</td></tr>`).join("")}</tbody></table>` : "";
  const replacedHtml = replaced.length ? `<h3>다시 선언해 대신한 항목 ${replaced.length}</h3><table class="sum mini"><thead><tr><th>대신한 케이스</th><th>앞 선언</th><th>이유</th></tr></thead><tbody>${
    replaced.map((r) => `<tr><td class="id">${caseLink(r.to)}</td><td title="${h.esc(outside("앞 선언")(r.from))}">${h.esc(outside("앞 선언")(r.from, shortName))}</td><td>${lineItem(outside("대신한 이유")(String(r.why || "")), h)}</td></tr>`).join("")}</tbody></table>` : "";
  return `<h2>이번 확인 범위</h2><div class="scopewrap">${pairsHtml}${runsHtml}${changesHtml}${replacedHtml}</div>`;
}

function overviewHtml(overview, caseOf, h, infoOf = new Map(), nameOf = (id) => id, caseField = keepText, outside = keepText) {
  if (!overview) return "";
  if (Array.isArray(overview)) return overview.length ? `<h2>구현 내용</h2>${blocksHtml(overview, h)}` : "";
  return [featuresHtml(overview.features || overview.requests, caseOf, h), diagramsHtml(overview.diagrams, h),
    overview.blocks ? blocksHtml(overview.blocks, h) : "", scopeHtml(overview, caseOf, infoOf, nameOf, h, caseField, outside)].join("\n");
}

const hasOverview = (o) => (Array.isArray(o) ? o.length > 0 : !!(o && (o.features || o.requests || o.diagrams || o.blocks)));

function renderPlain({ title, summary, overview, led, dir, devHref, charter, sessionRecord, sessionAnalysis, sessionScene, build }, h) {
  const diagrams = overview && !Array.isArray(overview) && Array.isArray(overview.diagrams) ? overview.diagrams : [];
  const problems = diagrams.flatMap((d, k) => checkLanes(d, k + 1));
  if (problems.length) throw new Error(`역할별 흐름도를 그릴 수 없음\n${problems.join("\n")}`);
  // 이 보고서에 실제로 있는 회차 번호(회차 기록 전체, 없으면 사진·판정). 확인자 글에서 이 번호만 지움
  const seqs = new Set([...(h.runSeqs || []),...led.rows.flatMap((r) => [...r.lanes.values()].flatMap((ln) => [...(ln.frames || []).map((f) => f.seq),
    ...(ln.receipts || []).map((x) => x.origSeq ?? x.seq)])), ...[...led.receipts.values()].map((x) => x.origSeq ?? x.seq)].map(Number).filter(Number.isFinite));
  h = { ...h, knownSeq: (a, b = a) => { for (const n of seqs) if (n >= a && n <= b) return true; return false; } };
  const rows = led.rows;
  const colorOf = rows.map((r) => h.rowColor(r));
  const caseOf = new Map(rows.map((r, i) => [String(r.id), { i, color: colorOf[i] }]));
  const infoOf = new Map((overview && !Array.isArray(overview) && Array.isArray(overview.cases) ? overview.cases : []).map((c) => [String(c.id), c]));
  const nameOf = (id) => rows.find((r) => String(r.id) === String(id))?.what || String(id);
  // 케이스에서 거꾸로 그 케이스가 확인한 요청으로 간다.
  const reqsOf = new Map();
  const featList = overview && !Array.isArray(overview) ? (overview.features || overview.requests || []) : [];
  (Array.isArray(featList) ? featList : []).filter((q) => q && (q.name || q.need || q.built)).forEach((q, k) => {
    for (const id of (Array.isArray(q.cases) ? q.cases : [])) {
      const key = String(id); if (!reqsOf.has(key)) reqsOf.set(key, []); reqsOf.get(key).push(k + 1);
    }
  });
  const count = {};
  for (const c of colorOf) count[c] = (count[c] || 0) + 1;
  const order = Object.keys(PLAIN).sort((a, b) => h.COLOR[a].rank - h.COLOR[b].rank);
  // 요약 한 줄은 줄의 색을 정한 경로(가장 나쁜 경로)의 결과다. 경로가 여럿이면 이름을 붙인다.
  const firstNote = (r) => {
    const lanes = r.paths.map((p) => r.lanes.get(p)).filter(Boolean);
    const rank = (ln) => (ln.color ? h.COLOR[ln.color].rank : 99);
    const ln = lanes.filter((x) => x.note).sort((a, b) => rank(a) - rank(b))[0];
    if (!ln) return "";
    const line = splitLines(ln.note)[0] || "";
    return r.paths.length > 1 ? `${ln.path} 경로: ${line}` : line;
  };
  const sorted = rows.map((r, i) => ({ r, i, c: colorOf[i] }))
    .sort((a, b) => h.COLOR[a.c].rank - h.COLOR[b.c].rank || a.i - b.i);
  // 무효로 돌린 판정이 남긴 장면. 장부는 판정만 빼고 장면은 남겨 두므로 여기서 거른다.
  const voidShots = new Set([...led.receipts.values()]
    .filter((x) => led.voided.has(String(x.id)) && x.shot).map((x) => x.shot));
  // 케이스마다 확인자 덮어쓰기. 케이스 본문을 다 그린 뒤 가리킨 대상이 없는 항목이 있으면 오류
  // 무효 판정 사진은 그 케이스 안에서만 뺌. 다른 케이스가 같은 파일을 증거로 쓸 수 있음
  const voidShotsOf = (r) => new Set([...r.lanes.values()].flatMap((ln) => (ln.voids || []).map((v) => led.receipts.get(String(v.receipt))?.shot)).filter((x) => x && voidShots.has(x)));
  const ov = overview && !Array.isArray(overview) ? overview : {};
  const rowOf = new Map(rows.map((r) => [String(r.id), r]));
  const editor = textEditor(new Map(rows.map((r) => [String(r.id), infoOf.get(String(r.id))?.text || []])), ov.text || [],
    (id) => textsIn(rowOf.get(id)), textsIn([rows, led.notes, charter, sessionRecord, sessionAnalysis, ov.combined]));
  for (const t of [...asLines(ov.scope), ...(Array.isArray(featList) ? featList : []).flatMap((q) => [q?.name, q?.need, q?.built, q?.why])]) editor.direct(t);
  for (const c of infoOf.values()) for (const t of [c.title, c.flow, c.result, ...(c.scenes || []).map((x) => x.caption),
    ...(c.checks || []).flatMap((k) => [k.text, ...(k.evidence || []).map((e) => e.caption)])]) editor.direct(t);
  const caseName = new Map(rows.map((r, i) => [String(r.id), `케이스 ${i + 1}(${r.id})`]));
  const unchecked = new Set((ov.combined?.unchecked || []).map(String));
  const ctxOf = new Map(rows.map((r, i) => [String(r.id), { ...caseEdits(infoOf.get(String(r.id)), voidShotsOf(r), h.sceneEdits || null, editor, String(r.id)),
    devLink: devHref ? `${devHref}#q${i + 1}` : "", unchecked: unchecked.has(String(r.id)) }]));
  // 끝난 회차의 결정 카드 빼기(overview.notes). 없는 번호는 오류
  const hideNotes = new Set((ov.notes || []).map((x) => String(x.id)));
  // 결정 카드 번호(n1·n2)는 회차마다 다시 매겨 합친 보고서에서 겹칠 수 있음. 겹치면 어느 카드인지 몰라 오류
  const noteCount = (id) => led.notes.filter((nt) => String(nt.id) === id).length;
  const missingNotes = [...hideNotes].filter((id) => noteCount(id) !== 1);
  const notes = led.notes.filter((nt) => !hideNotes.has(String(nt.id)));
  const outside = (name) => editor.show(null, name);
  const featNames = (Array.isArray(featList) ? featList : []).map((f) => String((f && f.name) || ""));
  const caseHtml = rows.map((r, i) => rowHtml(dir, r, i, h, ctxOf.get(String(r.id)), reqsOf, featNames, infoOf.get(String(r.id)))).join("\n");
  // 한 화면에서 전 줄을 훑는다. 급한 색이 위에 오고, 누르면 그 줄로 간다.
  // 확인 종류로 거르기. 케이스의 종류는 그 케이스 확인 줄 종류의 합. 종류가 하나뿐이면 칸과 단추를 그리지 않음
  const kindsOfRow = new Map(rows.map((r) => [String(r.id), caseKinds(r, infoOf.get(String(r.id)))]));
  const kindsUsed = QA_KIND_ORDER.filter((k) => rows.some((r) => kindsOfRow.get(String(r.id)).includes(k)));
  const kindCount = (k) => rows.filter((r) => kindsOfRow.get(String(r.id)).includes(k)).length;
  const filter = kindsUsed.length > 1 ? `<div class="filter" role="group" aria-label="확인 종류로 거르기"><button type="button" class="fk on" data-k="" aria-pressed="true">전체 ${rows.length}</button>${
    kindsUsed.map((k) => `<button type="button" class="fk" data-k="${h.esc(k)}" aria-pressed="false">${h.esc(k)} ${kindCount(k)}</button>`).join("")}</div>` : "";
  const cell = (r) => {
    const info = infoOf.get(String(r.id));
    if (!info?.title && !info?.flow) return `<td class="what">${h.esc(ctxOf.get(String(r.id)).field("확인 항목 설명")(r.what))}</td>`;
    const steps = String(info.flow || "").split(/\s*>\s*/).filter(Boolean);
    return `<td class="what">${info.title ? `<b>${h.esc(info.title)}</b>` : ""}${steps.length ? `<span class="mflow">${steps.map((x) => `<span>${h.esc(x)}</span>`).join("")}</span>` : ""}</td>`;
  };
  // 결과 칸: 보고서를 만들 때 받은 짧은 결과가 있으면 그것, 없으면 닫을 때 쓴 첫 줄
  const resultCell = (r) => { const own = infoOf.get(String(r.id))?.result;
    const t = own ? plainText(own, h.knownSeq) : ctxOf.get(String(r.id)).field("결과")(firstNote(r), (v) => plainText(v, h.knownSeq));
    return `<div class="clamp" title="${h.esc(t)}">${h.esc(t)}</div>`; };
  const table = `<table class="sum" data-cases><thead><tr><th>케이스</th><th>판정</th>${kindsUsed.length > 1 ? "<th>확인 종류</th>" : ""}<th>확인 절차</th><th>결과</th></tr></thead><tbody>${
    sorted.map(({ r, i, c }) => `<tr class="${c}" data-kinds="${h.esc(kindsOfRow.get(String(r.id)).join("|"))}"><td class="id"><a href="#w${i + 1}">Case ${i + 1}</a></td>
      <td><span class="chip ${c}">${PLAIN[c]}</span></td>${kindsUsed.length > 1 ? `<td class="kinds">${kindChips(kindsOfRow.get(String(r.id)), h)}</td>` : ""}${cell(r)}
      <td class="res">${resultCell(r)}</td></tr>`).join("")}</tbody></table>`;
  // 케이스 밖 글(결정할 사항·세션 기록)을 다 그린 뒤 가리킨 글을 못 찾은 규칙을 셈
  const notesHtml = notes.length ? `<h2>결정할 사항 ${notes.length}</h2>${notes.map((nt) => noteHtml(dir, nt, h, (t, compose = (v) => plainText(v, h.knownSeq)) => outside("결정할 사항")(t, compose))).join("")}` : "";
  const sessionHtml = renderSessionRecords(charter, sessionRecord, h.esc, sessionAnalysis, sessionScene,
    { plain: true, build, lastRun: ov.combined?.lastRun || "", show: (name) => (t) => outside(name)(t, (v) => plainText(v, h.knownSeq)) });
  // 보고서 앞부분(확인 범위)도 글 고치기를 거치므로 못 찾은 규칙을 세기 전에 그림
  const caseField = (id, name) => ctxOf.get(String(id))?.field(name) || keepText();
  const overviewPart = overviewHtml(overview, caseOf, h, infoOf, nameOf, caseField, outside);
  const unmatched = [...rows.flatMap((r) => ctxOf.get(String(r.id)).problems().map((x) => `${r.id}: ${x}`)),
    ...editor.problems((id) => caseName.get(id) || id), ...missingNotes.map((id) => `overview.notes.id '${id}'(${noteCount(id) ? "같은 번호의 결정 카드가 둘 이상" : "결정할 사항에 없음. 번호는 개발자용 보고서의 결정 카드 번호"})`)];
  if (unmatched.length) throw new Error(`overview의 고치는 칸이 가리킨 대상을 찾지 못했습니다\n${unmatched.join("\n")}`);
  if (h.textEdits) h.textEdits.push(...editor.result());
  // 여러 경로 중 한 곳이라도 보이면 적용으로 셈
  if (h.sceneEdits) {
    const e = h.sceneEdits, applied = new Set(e.applied);
    e.applied = [...applied]; e.hidden = [...new Set(e.hidden)]; e.notShown = [...new Set(e.notShown)].filter((x) => !applied.has(x));
  }
  return `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h.esc(title || "확인 보고서")}</title>
<style>
:root{color-scheme:light;--bg:#f6f6f4;--card:#fff;--fg:hsl(40 6% 10%);--muted:hsl(40 4% 40%);--line:hsl(40 8% 88%);
 --red:hsl(358 66% 46%);--red-2:hsl(0 90% 96%);--orange:hsl(24 90% 38%);--orange-2:hsl(24 100% 95%);
 --amber:hsl(36 100% 30%);--amber-2:hsl(44 100% 92%);--blue:hsl(211 90% 40%);--blue-2:hsl(210 100% 96%);
 --gray:hsl(40 4% 32%);--gray-2:hsl(40 8% 93%);--green:hsl(140 50% 28%);--green-2:hsl(130 50% 94%);
 --sans:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo",-apple-system,BlinkMacSystemFont,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);word-break:keep-all;font-variant-numeric:tabular-nums}
main{max-width:1440px;margin:0 auto;padding:32px 16px 72px}
h1{font-size:26px;line-height:1.3;letter-spacing:-.02em;margin:0 0 6px;font-weight:700;text-wrap:balance}
.lede{color:var(--muted);margin:0 0 20px}
h2{font-size:17px;margin:36px 0 12px;letter-spacing:-.01em}
.req{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:10px}
.req>li{display:grid;grid-template-columns:1.1fr 1fr 1.2fr 150px;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;scroll-margin-top:12px}
.req h4{margin:0 0 6px;font-size:12.5px;color:var(--muted);font-weight:600}
.req h3{font-size:15.5px;margin:0 0 8px}.req .gap{color:var(--amber);font-size:12.5px;flex-basis:100%}
.req blockquote{margin:0 0 6px;padding:0 0 0 10px;border-left:2px solid var(--line);font-size:14px;white-space:pre-wrap}
.req .plain{margin:0;padding:0 0 0 18px;font-size:14px}.req .plain li{margin:2px 0}
.req .cases{display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px}.req .cases h4{margin-bottom:0;flex-basis:100%}.req .cases small{flex-basis:100%}
.req .cases a{text-decoration:none}.req .cases small{color:var(--muted);font-size:12.5px}
.reqlink{font-size:12.5px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:5px;padding:1px 8px}.reqlink:hover{color:var(--fg)}
.lanes-wrap{display:grid;gap:14px}.lanes{margin:0;overflow-x:auto}.lanes figcaption{font-size:14px;font-weight:600;margin:0 0 6px}.lanes svg{width:100%;height:auto;display:block}
@media (max-width:1000px){.req>li{grid-template-columns:1fr}}
.ov{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:12px;margin:0 0 8px}
.ov section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.ov h3{font-size:15.5px;margin:0 0 8px}.ov .flow{margin:0 0 8px}.ov .flow li{font-size:13.5px}
.ov ul{margin:0;padding:0 0 0 18px;font-size:14px}.ov li{margin:2px 0}
.tally{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}.tally .chip{font-size:13.5px;padding:3px 10px}
.chip{display:inline-block;font-size:12.5px;font-weight:600;padding:2px 9px;border-radius:5px;white-space:nowrap}
.chip.red{background:var(--red-2);color:var(--red)}.chip.orange{background:var(--orange-2);color:var(--orange)}
.chip.yellow{background:var(--amber-2);color:var(--amber)}.chip.blue{background:var(--blue-2);color:var(--blue)}
.chip.gray{background:var(--gray-2);color:var(--gray)}.chip.green{background:var(--green-2);color:var(--green)}
.sum{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
.sum th{text-align:left;font-size:12.5px;color:var(--muted);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--gray-2)}
.sum td{padding:8px 12px;border-top:1px solid var(--line);vertical-align:top}
.sum td.id{font-weight:700;white-space:nowrap}.sum td.id a{color:inherit}
.sum td.what{width:52%}.sum td.res{color:var(--muted)}
.sum tr.red td{background:var(--red-2)}
.row{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px 18px 28px;margin:0 0 16px;scroll-margin-top:12px}
/* 판정 색 막대. 카드 테두리를 칠하면 둥근 모서리를 따라 휘므로, 안쪽에 곧은 막대로 세운다. */
.row::before{content:"";position:absolute;left:12px;top:18px;bottom:18px;width:4px;border-radius:2px;background:var(--bar,var(--line))}
.row.red{--bar:var(--red)}.row.orange{--bar:var(--orange)}.row.yellow{--bar:var(--amber)}
.row.blue{--bar:var(--blue)}.row.gray{--bar:var(--gray)}.row.green{--bar:var(--green)}
.row header{display:flex;align-items:center;gap:10px;margin:0 0 10px}
.row header .id{font-size:18px;font-weight:700}
.flow{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-wrap:wrap;gap:6px 0;align-items:center;counter-reset:f}
.flow li{counter-increment:f;display:inline-flex;align-items:center;gap:7px;background:var(--gray-2);border-radius:6px;padding:4px 10px;font-size:14.5px;font-weight:500}
.flow li::before{content:counter(f);font-size:11.5px;font-weight:700;color:#fff;background:var(--fg);border-radius:4px;min-width:18px;height:18px;display:inline-grid;place-items:center}
.flow li+li{margin-left:24px;position:relative}
.flow li+li::after{content:"›";position:absolute;left:-17px;color:var(--muted);font-size:18px;line-height:1}
.meta{margin:0 0 14px;font-size:13.5px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 22px}
.meta div{display:flex;gap:8px}.meta dt{font-weight:600;color:var(--fg)}.meta dd{margin:0}
section.req>dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font-size:14px}
section.req>dl dt{color:var(--muted)}section.req>dl dd{margin:0;white-space:pre-wrap}
.lane{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
.lane.noscene{grid-template-columns:minmax(0,760px)}
.lane+.lane{margin-top:16px;padding-top:16px;border-top:1px dashed var(--line)}
.info h3{font-size:15px;margin:0 0 8px;display:flex;gap:8px;align-items:center}
.info section{margin:0 0 12px}
.info h4{margin:0 0 4px;font-size:12.5px;color:var(--muted);font-weight:600}
.result{margin:0;padding:0 0 0 18px}.result li{margin:2px 0}
.checks{list-style:none;margin:0;padding:0;font-size:14px}
.checks li{display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--line)}.checks li:first-child{border-top:0}
.checks b{flex:none;font-size:12px;padding:1px 7px;border-radius:4px;height:fit-content}
.checks .ok b{background:var(--green-2);color:var(--green)}.checks .no b{background:var(--red-2);color:var(--red)}
.checks small{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted);word-break:break-word;white-space:pre-wrap}
.ask{background:var(--blue-2);border-radius:8px;padding:10px 12px}.ask .picks{margin:4px 0 0}.lean{margin:6px 0 0;font-size:13.5px;color:var(--muted)}
.checks em{display:block;font-style:normal;font-weight:600}
.checks .ck b{background:var(--blue-2);color:var(--blue)}
.checks .kind{flex:none;height:fit-content;font-size:11px;padding:0 7px}
.checks li>span:not(.kind){flex:1;min-width:0}
.checks .n{flex:none;font-style:normal;font-size:12px;color:var(--muted);white-space:nowrap}
.files ul{list-style:none;margin:6px 0 0;padding:0;font-size:12px}.files li{display:flex;flex-wrap:wrap;gap:4px 8px;padding:2px 0}
.files code{color:var(--muted);overflow-wrap:anywhere}
.quote{margin:0 0 14px;padding:10px 14px;background:var(--gray-2);border-radius:8px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.quote blockquote{margin:0;flex:1 1 320px;white-space:pre-wrap;font-size:14px}
.quote .shot.src{width:auto;height:auto;padding:0;max-width:360px}.quote .shot.src img{max-height:200px}
.warn{margin:0;padding:8px 12px;border-radius:8px;background:var(--amber-2);color:var(--amber);font-size:13px}
.none{color:var(--muted);font-size:13.5px;margin:4px 0}
.car{min-width:0;outline:none}
.view{position:relative;background:var(--gray-2);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.view{display:grid}.sc{grid-area:1/1;margin:0;display:flex;flex-direction:column}.sc[hidden]{display:flex;visibility:hidden}
.shot{display:flex;justify-content:center;align-items:center;padding:8px;border:0;background:transparent;cursor:zoom-in;width:100%;flex:1}
.frame{position:relative;display:inline-block;max-width:100%;max-height:100%}
.shot img{display:block;max-width:100%;max-height:min(62vh,620px);width:auto;height:auto}
.shot:focus-visible,.car:focus-visible .view{outline:3px solid var(--blue);outline-offset:-3px}
.box{position:absolute;border:3px solid #ff5a36;border-radius:4px;pointer-events:none}
.box i{position:absolute;left:-3px;top:-24px;font-style:normal;font-size:12px;font-weight:700;color:#fff;padding:2px 7px;border-radius:4px;white-space:nowrap}
.sc figcaption{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;background:var(--fg);color:#fff;font-size:14.5px;line-height:1.5;min-height:44px}
.sc figcaption b{flex:none;font-size:12.5px;opacity:.75;padding-top:1px}
.sc.bad figcaption{background:var(--red)}
.arw{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:56px;border:0;border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font-size:26px;line-height:1;cursor:pointer;opacity:.75;transition:opacity .15s}
.arw:hover,.arw:focus-visible{opacity:1}.arw.prev{left:8px}.arw.next{right:8px}
.thumbs{list-style:none;margin:8px 0 0;padding:0;display:flex;gap:6px;overflow-x:auto}
.th{position:relative;padding:0;border:2px solid transparent;border-radius:6px;background:var(--gray-2);cursor:pointer;display:block;width:88px;height:56px;overflow:hidden}
.th img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;opacity:.7}
.th b{position:absolute;left:3px;top:3px;font-size:11px;background:var(--fg);color:#fff;border-radius:3px;padding:0 5px}
.th.on{border-color:var(--fg)}.th.on img{opacity:1}.th.bad{border-color:var(--red)}
.decide .q{font-size:17px;font-weight:700;margin:0 0 10px}
.picks{margin:12px 0 0;padding:0 0 0 22px}
.picks li{margin:0 0 8px}.picks b{display:block}.picks span{display:block;color:var(--muted);font-size:14px}
footer{margin-top:48px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
footer a{color:inherit}
dialog{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100vh}
dialog[open]{display:grid;place-items:center}
dialog::backdrop{background:rgba(10,10,10,.85)}
dialog figure{margin:0;max-width:calc(100vw - 32px);background:var(--card);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
dialog .shot{cursor:default;height:auto;padding:0}
dialog .shot img{max-height:calc(100vh - 110px);max-width:calc(100vw - 32px)}
dialog .close{position:fixed;top:12px;right:12px;font:inherit;font-weight:700;padding:8px 14px;border:0;border-radius:6px;background:#fff;cursor:pointer}
/* 접기: 첫 줄만 보이고 펼치면 전체 */
.more{margin:0}.more>summary{cursor:pointer;list-style:none;display:flex;gap:6px;align-items:baseline}.more>summary::-webkit-details-marker{display:none}
.more>summary::before{content:"▸";color:var(--muted);font-size:11px;flex:none;transition:transform .15s}.more[open]>summary::before{transform:rotate(90deg)}
.more>summary small{color:var(--muted);font-size:12px}.more>p,.more>ul,.more>table,.more>dl,.more>ol{margin:6px 0 0}
.result li .more>summary,.warn li .more>summary{display:inline-flex}
.orig{font-size:13px;color:var(--muted);margin:-4px 0 12px}.orig p{white-space:pre-wrap}
.ttl{font-size:16.5px;margin:-2px 0 10px;letter-spacing:-.01em}
/* 확인 종류 칩과 거르기 */
.kind{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--fg);background:var(--card);white-space:nowrap}
.filter{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.fk{font:inherit;font-size:13px;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
.fk:hover{border-color:var(--muted)}.fk.on{background:var(--fg);border-color:var(--fg);color:#fff}
.fk:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.sum td.kinds{white-space:normal}.sum td.kinds .kind{margin:0 4px 4px 0}
.sum td.what b{display:block;font-weight:650;margin:0 0 4px}
.mflow{display:flex;flex-wrap:wrap;gap:3px 0;font-size:12.5px;color:var(--muted)}
.mflow span+span::before{content:"›";margin:0 6px;color:var(--line)}
.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dshots{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
.dshots figure{margin:0;max-width:240px;cursor:zoom-in}.dshots img{max-height:300px!important;width:auto;max-width:100%;display:block;border:1px solid var(--line);border-radius:6px}
.dshots figcaption{font-size:12px;color:var(--muted);margin-top:4px}
/* 판정 이력 */
.hist{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 0}
.hist li{display:inline-flex;align-items:center;gap:5px;font-size:12.5px}
.hist li+li::before{content:"→";color:var(--muted);margin:0 8px}
.hist .run{color:var(--muted);font-variant-numeric:tabular-nums}.hist small{color:var(--muted);font-size:11.5px}
/* 이번 확인 범위 */
.scopewrap{display:grid;gap:10px}.scopewrap h3{font-size:14px;margin:8px 0 0;color:var(--muted);font-weight:600}
.scopewrap .note{margin:0;font-size:12.5px;color:var(--muted)}
.pairs{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:0;font-size:14px}
.pairs dt{color:var(--muted);font-weight:600}.pairs dd{margin:0;min-width:0}.pairs dd p{margin:0}
.pairs.scope{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.vals{display:flex;flex-wrap:wrap;gap:4px 6px}.val{background:var(--gray-2);border-radius:5px;padding:1px 8px;font-size:13px}
.sum.mini td{vertical-align:middle}.sum.mini td.id{width:1%}.sum.mini td .chip{margin:0 3px 3px 0}
ul.warn{list-style:none;margin:0;padding:8px 12px}ul.warn li+li{margin-top:2px}
/* 세션 기록 */
.rec{margin:36px 0 0}.rec h2{margin:0 0 12px}.rec h2 small{color:var(--muted);font-weight:500;font-size:14px;margin-left:4px}
.rec>.pairs,.rec>details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:0 0 8px}
.rec .lead{font-size:15.5px;font-weight:600;margin:0 0 10px}
.lines{margin:0;padding:0 0 0 18px}.lines li{margin:1px 0}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 10px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:5px;background:var(--gray-2);color:var(--gray);white-space:nowrap}
.tag.env{background:var(--blue-2);color:var(--blue)}
.cards{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.dcard{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--red);border-radius:10px;padding:14px 16px}
.dcard h3{font-size:15.5px;margin:0 0 8px}.dcard h4{font-size:12.5px;color:var(--muted);margin:14px 0 6px}
.hscroll{overflow-x:auto;max-width:100%}.cards>li,.rec,.rec>*{min-width:0}
/* 빌드 칸(report.mjs 가 Charter 앞에 넣음)도 이름-값 두 칸. 긴 경로는 줄바꿈 */
.rec>dl:not(.pairs){display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:0 0 8px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13.5px}
.rec>dl:not(.pairs) dt{color:var(--muted);font-weight:600}.rec>dl:not(.pairs) dd{margin:0}
.rec dd,.pairs dd{overflow-wrap:anywhere}
.steps{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--card)}
.steps th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:5px 8px;border-bottom:1px solid var(--line)}
.steps td{padding:5px 8px;border-top:1px solid var(--line);vertical-align:top}
.steps td.n{width:1%;color:var(--muted);font-variant-numeric:tabular-nums}.steps td.ok{width:1%;white-space:nowrap;font-weight:600;color:var(--green)}
.steps tr.no td{background:var(--red-2)}.steps tr.no td.ok{color:var(--red)}
.memo{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}
.memo li{display:grid;grid-template-columns:88px max-content minmax(0,1fr);gap:10px;align-items:baseline;padding:8px 14px;border-top:1px solid var(--line);font-size:14px}
.memo li:first-child{border-top:0}.memo p{margin:0}
.when{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px;margin:0 0 8px}
.two .steps{border:1px solid var(--line);border-radius:10px}
.sc figcaption span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
dialog .sc figcaption span,dialog figcaption span{display:block;-webkit-line-clamp:unset}
@media (max-width:640px){.sum.mini td:not(.id){grid-column:1/-1}.sum td.kinds{grid-column:1/-1}.hscroll .steps{min-width:520px}.memo li{grid-template-columns:1fr}.pairs{grid-template-columns:1fr}.pairs dt{margin-top:6px}}
@media print{.more>*{display:block}.fk,.filter{display:none}}
@media (max-width:1000px){.lane{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){main{padding:20px 16px 56px}.row{padding:14px 14px 14px 24px}.row::before{left:10px;top:14px;bottom:14px}.sum thead{display:none}.sum tr{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:8px 12px;border-top:1px solid var(--line)}.sum td{border:0;padding:0}.sum td.what,.sum td.res{grid-column:1/-1;width:auto}.shot img{max-height:48vh}}
@media print{body{background:#fff}.view{display:block}.sc,.sc[hidden]{display:flex;visibility:visible;break-inside:avoid}.arw,.thumbs{display:none}.shot{height:auto}.shot img{max-height:120mm}dialog,dialog[open]{display:none!important}.lane{grid-template-columns:1fr}}
</style>
<main>
<h1>${h.esc(title || "확인 보고서")}</h1>
${summary ? `<p class="lede">${h.esc(summary)}</p>` : ""}
${overviewPart}
${hasOverview(overview) ? `<h2>케이스 ${rows.length}</h2>` : ""}
<p class="tally">${order.filter((c) => count[c]).map((c) => `<span class="chip ${c}">${PLAIN[c]} ${count[c]}</span>`).join("")}</p>
${filter}
${table}
${notesHtml}
<h2>케이스별 확인 내용 ${rows.length}</h2>
${caseHtml}
${/* 결과·케이스를 먼저 읽도록 세션 기록(빌드·Charter·결함·메모)은 케이스 뒤. 맨 위에 빌드 경로·커밋부터 나와 요약이 안 읽힌 사례 */ ""}
${sessionHtml}
${devHref ? `<footer>개발자용 상세 기록 <a href="${h.esc(devHref)}">${h.esc(devHref)}</a></footer>` : ""}
</main>
<dialog id="lb" aria-label="장면 크게 보기"><button type="button" class="close">닫기</button><figure></figure></dialog>
<script>
const lb = document.getElementById("lb");
function go(car, i) {
  const sc = [...car.querySelectorAll(".sc")], th = [...car.querySelectorAll(".th")];
  if (!sc.length) return;
  const k = (i + sc.length) % sc.length;
  sc.forEach((f, j) => { f.classList.toggle("on", j === k); f.hidden = j !== k; });
  th.forEach((t, j) => { t.classList.toggle("on", j === k); if (j === k) t.setAttribute("aria-current", "true"); else t.removeAttribute("aria-current"); });
  if (th[k]) th[k].scrollIntoView({ block: "nearest", inline: "nearest" });
}
const at = (car) => [...car.querySelectorAll(".sc")].findIndex((f) => f.classList.contains("on"));
// 확인 종류 단추: 표의 줄과 케이스 카드를 함께 거름
document.addEventListener("click", (e) => {
  const b = e.target.closest(".fk"); if (!b) return;
  const k = b.dataset.k;
  document.querySelectorAll(".fk").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
  document.querySelectorAll("table[data-cases] tbody tr").forEach((tr) => { tr.hidden = !!k && !tr.dataset.kinds.split("|").includes(k); });
  document.querySelectorAll("article.row header[data-kinds-of]").forEach((hd) => { hd.closest("article").hidden = !!k && !hd.dataset.kindsOf.split("|").includes(k); });
});
// 썸네일은 파일에 그림을 한 번 더 심지 않고 본 장면의 그림을 가져다 쓴다. 두 번 심으면 지면 크기가 두 배가 된다.
for (const car of document.querySelectorAll(".car")) {
  const imgs = [...car.querySelectorAll(".sc")].map(scene => scene.querySelector(".shot img"));
  car.querySelectorAll(".th img").forEach((t, k) => { if (imgs[k]) t.src = imgs[k].src; });
}
// 화살표 키는 포인터가 올라가 있거나 포커스가 들어간 캐러셀만 넘긴다. 밖에서 누른 키는 건드리지 않는다.
let hot = null;
document.addEventListener("mouseover", (e) => { hot = e.target.closest(".car"); });
document.addEventListener("click", (e) => {
  if (e.target.closest("#lb .close") || e.target === lb) { lb.close(); return; }
  // 결함 장면은 작게 늘어놓고 누르면 크게
  const ds = e.target.closest("main .dshots figure");
  if (ds) { const box = lb.querySelector("figure"); box.innerHTML = ""; const img = ds.querySelector("img").cloneNode(); img.removeAttribute("style");
    img.style.cssText = "max-height:calc(100vh - 110px);max-width:calc(100vw - 32px);display:block"; box.appendChild(img);
    const cap = ds.querySelector("figcaption"); if (cap) box.appendChild(cap.cloneNode(true)); lb.showModal(); return; }
  const src = e.target.closest("main .shot.src");
  const car = e.target.closest("main .car");
  if (!car && !src) return;
  const a = e.target.closest(".arw");
  if (a) { go(car, at(car) + (a.classList.contains("next") ? 1 : -1)); return; }
  const t = e.target.closest(".th");
  if (t) { go(car, Number(t.dataset.i)); return; }
  const b = src || e.target.closest(".shot");
  if (!b) return;
  const box = lb.querySelector("figure");
  box.innerHTML = "";
  box.appendChild(b.cloneNode(true));
  const cap = b.closest("figure") && b.closest("figure").querySelector("figcaption");
  if (cap) box.appendChild(cap.cloneNode(true));
  lb.showModal();
});
document.addEventListener("keydown", (e) => {
  if (lb.open || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const car = (e.target.closest && e.target.closest(".car")) || (e.target === document.body ? hot : null);
  if (!car) return;
  go(car, at(car) + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault();
});
</script></html>`;
}

export { renderPlain, PLAIN };
