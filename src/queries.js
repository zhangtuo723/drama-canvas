import path from "node:path";

const invalid = (message, code = "INVALID_ARGUMENT", status = 400) =>
  Object.assign(new Error(message), { code, status });

export function queryState(state, assets, dir, query = {}) {
  if (query.node) {
    const nodes = new Map(state.nodes.map((n) => [n.id, n]));
    const media = new Map(
      assets.map((a) => [
        a.id,
        { ...a, path: path.join(dir, "assets", a.file) },
      ]),
    );
    const node = nodes.get(query.node);
    if (!node)
      throw invalid("节点不存在: " + query.node, "NODE_NOT_FOUND", 404);
    return {
      revision: state.revision,
      node,
      asset: media.get(node.data.assetId) || null,
      inputs: state.edges
        .filter((e) => e.target === node.id)
        .map((e) => {
          const input = nodes.get(e.source);
          return {
            nodeId: e.source,
            title: input?.data.title,
            type: input?.type,
            status: input?.data.status,
            stale: input?.data.stale,
            asset: media.get(input?.data.assetId) || null,
          };
        }),
      outputs: state.edges
        .filter((e) => e.source === node.id)
        .map((e) => e.target),
      generationInputs: (node.data.generation?.inputs || []).map((i) => ({
        ...i,
        asset: media.get(i.assetId) || null,
      })),
    };
  }
  if (query.summary)
    return {
      name: state.name,
      revision: state.revision,
      nodes: state.nodes.length,
      edges: state.edges.length,
      assets: assets.length,
      stale: state.nodes.filter((n) => n.data.stale).length,
      running: state.nodes.filter((n) => n.data.status === "running").length,
    };
  if (
    query.type !== undefined ||
    query.limit !== undefined ||
    query.offset !== undefined
  ) {
    if (query.type && !["image", "video"].includes(query.type))
      throw invalid("type应为image或video");
    const offset = Number(query.offset ?? 0),
      limit = Number(query.limit ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw invalid("limit须1–1000，offset须非负整数");
    const nodes = state.nodes.filter(
      (n) => !query.type || n.type === query.type,
    );
    return {
      revision: state.revision,
      total: nodes.length,
      offset,
      nodes: nodes.slice(offset, offset + limit),
    };
  }
  return { ...state, assets };
}
