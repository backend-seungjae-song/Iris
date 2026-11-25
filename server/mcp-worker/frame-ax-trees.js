function* frameIds(tree) {
  if (tree?.frame?.id) yield tree.frame.id;
  for (const child of tree?.childFrames || []) yield* frameIds(child);
}

export async function readFrameIds(send) {
  const { frameTree } = await send("Page.getFrameTree");
  return [...frameIds(frameTree)];
}

export function frameDisappeared(error) {
  return /Frame with the given frameId is not found|No frame for given id found|Cannot find context with specified id/i.test(error.message);
}

export async function* readFrameAXTrees(send) {
  // 세션 루트는 frameId 없는 ax.tree 중계 사용 가능
  const root = await send("Accessibility.getFullAXTree");
  yield { nodes: root?.nodes || [], frameId: null };
  const [, ...children] = await readFrameIds(send);
  for (const frameId of children) {
    let tree;
    try {
      tree = await send("Accessibility.getFullAXTree", { frameId });
    } catch (error) {
      if (frameDisappeared(error)) continue;
      throw error;
    }
    yield { nodes: tree?.nodes || [], frameId };
  }
}
