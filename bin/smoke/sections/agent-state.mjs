// 에이전트 상태 점(작업 중·작업 완료·비활성화·멈춤·질문 있음)의 검사.
//
// 소유 범위
//   점을 그리는 자리가 모두 web/js/core/agent-state.js 로 class 와 툴팁을 정하는가, 색이 --st-* 토큰
//   다섯으로만 정해지는가, 질문 판정을 하는 앱 셸 서버 모듈이 채팅 보기 기능의 해석기를 가져오지 않는가.
//
// 설계 이유
//   점을 그리는 곳마다 상태 → class 표를 따로 두었을 때 한 곳(창 번호 줄)만 unknown 을 빠뜨렸다.
//   판정을 한 파일에 모으고, 따로 만든 표가 다시 생기면 이 검사가 실패한다.
//
// 영향 범위
//   러너(bin/smoke.mjs)가 default run 을 부른다. 현재 목록 확인: node bin/importers.mjs bin/smoke/sections/agent-state.mjs
import { check, checkAsync, read, ROOT, sourceFiles } from "../core.mjs";

const url = (rel) => new URL(`file://${ROOT}/${rel}`).href;
const STATES = ["working", "done", "idle", "blocked", "question"];

// 점을 그리는 자리와 그 자리가 불러야 하는 agent-state 함수. 개수는 그 파일 안의 호출 수다.
const DOT_SITES = [
  { file: "web/js/herdr/agents.js", call: "agentState", count: 1, what: "에이전트 줄" },
  { file: "web/js/explorer/tree.js", call: "spaceState", count: 1, what: "스페이스 줄" },
  { file: "web/js/main.js", call: "paintStateDot", count: 2, what: "오른쪽 머리(선택·방송)" },
  { file: "web/js/herdr/sync.js", call: "paintStateDot", count: 1, what: "오른쪽 머리(herdr 역동기화)" },
  { file: "web/js/panel/herdr-tabs.js", call: "agentState", count: 1, what: "창 번호 줄" },
];

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");

export default async function run() {
  console.log("[에이전트 상태 점]");

  check("점을 그리는 여섯 자리가 core/agent-state.js 로 상태를 정하고, 따로 만든 상태 표가 없다", () => {
    const bad = [];
    for (const site of DOT_SITES) {
      const src = stripComments(read(site.file));
      if (!/from\s+["'][./]*core\/agent-state\.js["']/.test(src)) bad.push(`${site.file}: agent-state import 없음`);
      const calls = (src.match(new RegExp(`\\b${site.call}\\(`, "g")) || []).length;
      if (calls !== site.count) bad.push(`${site.file}(${site.what}): ${site.call}( 호출 ${calls}회, 기대 ${site.count}회`);
      if (/tDot\.className\s*=/.test(src)) bad.push(`${site.file}: 오른쪽 머리 점 class 를 직접 쓴다`);
      if (site.call !== "paintStateDot" && !src.includes('aria-label="${STATE_LABEL[st]}"')) bad.push(`${site.file}: 점에 스크린리더 이름(aria-label)이 없다`);
    }
    for (const rel of sourceFiles("web").filter((r) => r.endsWith(".js"))) {
      const src = stripComments(read(rel));
      if (/\bstatusClass\b|\bDOT_STATUS\b/.test(src)) bad.push(`${rel}: 개별 statusClass/DOT_STATUS 가 남아 있다`);
    }
    if (!/setAttribute\("aria-label", STATE_LABEL\[st\]\)/.test(read("web/js/core/agent-state.js"))) bad.push("paintStateDot 이 aria-label 을 달지 않는다");
    // 오른쪽 머리의 상태 글자도 점과 같은 이름이어야 한다. herdr 원래 값(done)을 적으면 점이 질문 있음일 때 어긋난다.
    for (const [rel, n] of [["web/js/main.js", 2], ["web/js/herdr/sync.js", 1]]) {
      const src = stripComments(read(rel));
      const labels = (src.match(/\bstateLabel\(a\)/g) || []).length;
      if (labels !== n) bad.push(`${rel}: 오른쪽 머리 상태 글자의 stateLabel(a) ${labels}회, 기대 ${n}회`);
      if (/escHtml\(a\.status\)|textContent:\s*a\.status/.test(src)) bad.push(`${rel}: 오른쪽 머리 상태 글자가 herdr 원래 값을 적는다`);
    }
    if (bad.length) throw new Error(bad.join("; "));
    return true;
  });

  await checkAsync("agent-state 판정: herdr 상태 다섯과 question 이 상태 다섯으로 간다", async () => {
    const { agentState, spaceState, STATE_LABEL } = await import(url("web/js/core/agent-state.js"));
    const cases = [
      ["working", false, "working"], ["working", true, "working"],
      ["done", false, "done"], ["done", true, "question"],
      ["idle", false, "idle"], ["idle", true, "question"],
      ["blocked", false, "blocked"], ["blocked", true, "blocked"],
      ["unknown", false, "idle"], ["unknown", true, "idle"], [undefined, false, "idle"],
    ];
    const wrong = cases.filter(([s, q, want]) => agentState(s, q) !== want).map(([s, q, want]) => `${s}+${q}→${agentState(s, q)}(기대 ${want})`);
    const agents = [{ workspaceId: "w1", question: true }, { workspaceId: "w2", question: false }];
    if (spaceState("done", agents, "w1") !== "question") wrong.push("질문 남긴 에이전트가 있는 done 스페이스가 question 이 아니다");
    if (spaceState("done", agents, "w2") !== "done") wrong.push("질문 없는 스페이스가 question 이 됐다");
    if (spaceState("working", agents, "w1") !== "working") wrong.push("working 스페이스가 question 이 됐다");
    for (const s of STATES) if (!STATE_LABEL[s]) wrong.push(`${s} 이름 없음`);
    if (wrong.length) throw new Error(wrong.join("; "));
    return true;
  });

  check("상태 색은 --st-* 토큰 다섯이고, 점 규칙은 10-sidebar 한 벌이 그 토큰만 쓴다", () => {
    const bad = [];
    const tokens = read("web/css/00-tokens.css");
    const light = read("web/css/01-base.css");
    for (const s of STATES) {
      const m = new RegExp(`--st-${s}\\s*:([^;]+);`).exec(tokens);
      if (!m) bad.push(`00-tokens.css 에 --st-${s} 없음`);
      else if (/#[0-9a-f]{3,8}\b/i.test(m[1])) bad.push(`--st-${s} 가 hex 를 직접 쓴다(팔레트를 참조해야 한다)`);
      if (!new RegExp(`\\[data-theme="light"\\][^}]*--st-${s}\\s*:`).test(light)) bad.push(`라이트 테마에 --st-${s} 없음`);
    }
    const sidebar = read("web/css/10-sidebar.css");
    const idle = /\.dot\.idle\s*\{([^}]*)\}/.exec(sidebar);
    if (!idle || !/box-shadow:inset 0 0 0 1px var\(--st-idle\)/.test(idle[1])) bad.push(".dot.idle 이 --st-idle 로 속 빈 테두리를 그리지 않는다");
    for (const s of STATES.filter((x) => x !== "idle")) {
      const rule = new RegExp(`\\.dot\\.${s}\\s*\\{([^}]*)\\}`).exec(sidebar);
      if (!rule) bad.push(`.dot.${s} 규칙 없음`);
      else if (!new RegExp(`background:var\\(--st-${s}\\)`).test(rule[1])) bad.push(`.dot.${s} 가 --st-${s} 로 칠하지 않는다`);
    }
    // 다른 CSS 가 점의 색을 다시 정하면 두 벌이 된다. 크기 외의 색 속성은 10-sidebar 에만 둔다.
    for (const rel of sourceFiles("web").filter((r) => r.endsWith(".css") && r !== "web/css/10-sidebar.css")) {
      for (const m of read(rel).matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        if (!/\.dot(?:st)?(?![\w-])/.test(m[1])) continue;
        if (/background|box-shadow|border|color/.test(m[2])) bad.push(`${rel}: ${m[1].trim()} 가 점의 색을 다시 정한다`);
      }
    }
    if (bad.length) throw new Error(bad.join("; "));
    return true;
  });

  check("앱 셸 서버 모듈이 채팅 보기 기능의 해석기(agent-chat-transcript)를 가져오지 않는다", () => {
    const users = sourceFiles("server").filter((rel) => /from\s+["']\.\/agent-chat-transcript\.js["']|import\(\s*["']\.\/agent-chat-transcript\.js/.test(read(rel)));
    const foreign = users.filter((rel) => rel !== "server/agent-chat.js");
    if (!read("server/agent-question.js").includes("attachQuestionState")) throw new Error("server/agent-question.js 에 attachQuestionState 가 없다");
    if (foreign.length) throw new Error(`채팅 보기 밖에서 가져온다: ${foreign.join(", ")}`);
    return true;
  });
}
