"use strict";

// 접근성 트리 노드에서 snapshot 엔진(server/mcp-worker/snapshot-engine.js)이 읽는 필드만 남김
// 엔진이 새 필드를 읽게 되면 이 목록도 함께 바꿔야 함 (메인 재설치 필요)
// 읽는 필드(snapshot-engine.js 줄): nodeId 33·56 · childIds 207~208 · ignored 178 · role.value 179 · name.value 180 ·
//   backendDOMNodeId 194~201 · properties 중 첫 focusable 의 value.value 212~214
function pruneAxNodes(nodes) {
  if (!Array.isArray(nodes)) return nodes;  // 배열이 아니면 그대로 · 옛 경로와 같은 오류가 엔진에서 남
  return nodes.map((node) => {
    const out = { nodeId: node.nodeId };
    if (node.ignored) out.ignored = true;
    if (node.role && node.role.value !== undefined) out.role = { value: node.role.value };
    if (node.name && node.name.value !== undefined) out.name = { value: node.name.value };
    if (node.childIds) out.childIds = node.childIds;
    if (node.backendDOMNodeId != null) out.backendDOMNodeId = node.backendDOMNodeId;
    const focusable = Array.isArray(node.properties) ? node.properties.find((p) => p.name === "focusable") : undefined;
    if (focusable) out.properties = [{ name: "focusable", value: { value: focusable.value?.value } }];
    return out;
  });
}

module.exports = { pruneAxNodes };
