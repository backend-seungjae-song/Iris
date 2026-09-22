// 받은 탭 순서를 유지한 채, 서버가 확인한 pane 부모 연결만 트리로 묶는다.
// 부모가 없거나 다른 workspace이거나 순환을 만들면 그 행은 루트에 남긴다.

const paneIdOf = (agent) => typeof agent?.paneId === "string" && agent.paneId ? agent.paneId : null;

export function agentBranchKey(agent) {
  return `pane:${agent?.workspaceId || ""}:${agent?.paneId || ""}`;
}

export function buildAgentForest(agents) {
  const nodes = (agents || []).map((agent, index) => ({ agent, index, parent: null, children: [] }));
  const counts = new Map();
  for (const node of nodes) {
    const id = paneIdOf(node.agent);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const byPane = new Map();
  for (const node of nodes) {
    const id = paneIdOf(node.agent);
    if (id && counts.get(id) === 1) byPane.set(id, node);
  }

  // 먼저 후보 edge를 모은 뒤 순환에 든 node의 edge만 끊는다. 순환으로 들어오는 정상 후손은
  // 루트가 된 순환 node 아래에 그대로 붙을 수 있어, 어느 행도 사라지지 않는다.
  const parentOf = new Map();
  for (const node of nodes) {
    const parentId = typeof node.agent?.parentPaneId === "string" ? node.agent.parentPaneId : "";
    const parent = byPane.get(parentId);
    if (!parent || parent === node || parent.agent.workspaceId !== node.agent.workspaceId) continue;
    parentOf.set(node, parent);
  }
  const cyclic = new Set();
  for (const start of nodes) {
    const path = [];
    const at = new Map();
    let cur = start;
    while (cur && parentOf.has(cur) && !at.has(cur)) {
      at.set(cur, path.length);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur && at.has(cur)) for (const node of path.slice(at.get(cur))) cyclic.add(node);
  }

  const roots = [];
  const parentByPane = new Map();
  for (const node of nodes) {
    const parent = cyclic.has(node) ? null : parentOf.get(node);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
      const id = paneIdOf(node.agent);
      if (id) parentByPane.set(id, parent.agent);
    } else roots.push(node);
  }
  return { roots, nodes, parentByPane };
}

export function visibleAgentNodes(forest, collapsedBranches) {
  const out = [];
  const walk = (node, depth) => {
    out.push({ node, depth });
    if (collapsedBranches?.has(agentBranchKey(node.agent))) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of forest?.roots || []) walk(root, 0);
  return out;
}

export function ancestorBranchKeys(forest, paneId) {
  const node = (forest?.nodes || []).find((candidate) => paneIdOf(candidate.agent) === paneId);
  const keys = [];
  const seen = new Set();
  let cur = node?.parent || null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    keys.push(agentBranchKey(cur.agent));
    cur = cur.parent;
  }
  return keys;
}

// 자식에서 시작해도 소속 루트의 순서로 이동한다. 접힘 상태는 순환 대상을 바꾸지 않는다.
export function nextRootAgentPane(agents, currentPaneId, direction) {
  const forest = buildAgentForest(agents);
  if (!forest.roots.length) return null;
  let current = forest.nodes.find((node) => node.agent.paneId === currentPaneId);
  while (current?.parent) current = current.parent;
  const index = forest.roots.indexOf(current);
  const next = index < 0 ? 0 : (index + direction + forest.roots.length) % forest.roots.length;
  return forest.roots[next].agent.paneId;
}
