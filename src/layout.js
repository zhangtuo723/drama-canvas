const bounds = (n) => ({
  x: n.position.x,
  y: n.position.y,
  width: n.style?.width || 320,
  height: n.style?.height || 260,
});
export function freePosition(nodes, width = 320, height = 260) {
  const boxes = nodes.map(bounds);
  for (let i = 0; i < nodes.length * 16 + 32; i++) {
    const candidate = {
      x: (i % 4) * (width + 100),
      y: Math.floor(i / 4) * (height + 100),
      width,
      height,
    };
    if (
      !boxes.some(
        (b) =>
          candidate.x < b.x + b.width + 40 &&
          candidate.x + width + 40 > b.x &&
          candidate.y < b.y + b.height + 40 &&
          candidate.y + height + 40 > b.y,
      )
    )
      return { x: candidate.x, y: candidate.y };
  }
  return { x: Math.max(0, ...boxes.map((b) => b.x + b.width)) + 100, y: 0 };
}
export function arrange(
  nodes,
  edges,
  { mode = "grid", columns = 3, gap = 100, x, y } = {},
) {
  if (!nodes.length) return [];
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    !Number.isFinite(gap) ||
    gap < 0
  )
    throw new Error("列数须为正整数，间距不能为负");
  x ??= Math.min(...nodes.map((n) => n.position.x));
  y ??= Math.min(...nodes.map((n) => n.position.y));
  if (![x, y].every(Number.isFinite)) throw new Error("布局坐标无效");
  let groups;
  if (mode === "dependencies") {
    const ids = new Set(nodes.map((n) => n.id));
    const dependencies = edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    const remaining = new Set(ids),
      depth = new Map();
    while (remaining.size) {
      const ready = nodes.filter(
        (n) =>
          remaining.has(n.id) &&
          !dependencies.some(
            (e) => e.target === n.id && remaining.has(e.source),
          ),
      );
      if (!ready.length) throw new Error("依赖存在环路，无法排列");
      for (const n of ready) {
        depth.set(
          n.id,
          Math.max(
            0,
            ...dependencies
              .filter((e) => e.target === n.id)
              .map((e) => depth.get(e.source) + 1),
          ),
        );
        remaining.delete(n.id);
      }
    }
    groups = Array.from({ length: Math.max(...depth.values()) + 1 }, (_, i) =>
      nodes.filter((n) => depth.get(n.id) === i),
    );
  } else if (mode === "grid") {
    groups = Array.from({ length: Math.ceil(nodes.length / columns) }, (_, i) =>
      nodes.slice(i * columns, (i + 1) * columns),
    );
  } else throw new Error("布局模式应为 grid 或 dependencies");
  const result = [];
  let outer = mode === "grid" ? y : x;
  for (const group of groups) {
    let inner = mode === "grid" ? x : y;
    for (const n of group) {
      result.push({
        op: "node.move",
        id: n.id,
        position:
          mode === "grid" ? { x: inner, y: outer } : { x: outer, y: inner },
      });
      inner += (mode === "grid" ? bounds(n).width : bounds(n).height) + gap;
    }
    outer +=
      Math.max(
        ...group.map((n) =>
          mode === "grid" ? bounds(n).height : bounds(n).width,
        ),
      ) + gap;
  }
  return result;
}
