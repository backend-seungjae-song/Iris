// join.js를 herdr 라이브에 연결해 검증한다. 계측 대상은 실제 herdr 상태다.
import { HerdrClient } from "./herdr.js";
import { buildMonitorState } from "./join.js";

const h = new HerdrClient();
h.on("error", (e) => console.error("herdr err:", e.message));
h.connect();

h.once("connect", async () => {
  const agents = await h.agentList();
  const state = buildMonitorState(agents);
  const withSub = state.filter((s) => s.subagents.length > 0);
  const cross = state.filter((s) => s.cross);
  console.log(`에이전트 ${state.length}개`);
  console.log(`  서브트리 있는 에이전트: ${withSub.length}`);
  console.log(`  Cross(codex 포함) 에이전트: ${cross.length}`);
  const countRunning = (nodes) =>
    nodes.reduce((n, x) => n + 1 + countRunning(x.children), 0);
  const totalRunning = state.reduce((n, s) => n + countRunning(s.subagents), 0);
  console.log(`  실행 중 서브에이전트 총계: ${totalRunning}`);
  // 트리 깊이 표본
  const deep = state.find((s) => s.subagents.some((n) => n.children.length));
  if (deep) {
    console.log("  중첩 예시:", JSON.stringify(deep.subagents.find((n) => n.children.length), null, 1).slice(0, 300));
  }
  process.exit(0);
});

setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
