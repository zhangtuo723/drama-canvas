import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  Background,
  Controls,
  ControlButton,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./style.css";
import {
  commitHistory,
  commitOperations,
  imageSource,
  requestJson,
} from "./canvas-client.js";

function MediaImage({ asset, title, width, height }) {
  const preferredSource = useStore(
    useCallback(
      (state) =>
        imageSource(asset, {
          width,
          height,
          zoom: state.transform[2],
          pixelRatio: window.devicePixelRatio || 1,
        }),
      [asset, width, height],
    ),
  );
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const src = originalLoaded || thumbnailFailed ? asset.url : preferredSource;
  return (
    <img
      src={src}
      alt={title}
      draggable={false}
      loading="lazy"
      decoding="async"
      onLoad={() => {
        if (src === asset.url) setOriginalLoaded(true);
      }}
      onError={() => {
        if (src !== asset.url) setThumbnailFailed(true);
      }}
    />
  );
}

function MediaNode({ id, data, type, width, height }) {
  const { deleteElements } = useReactFlow();
  const badges = [];
  if (data.status === "running") badges.push(["running", "生成中"]);
  else if (data.status === "failed") badges.push(["failed", "失败"]);
  else if (["waiting", "pending"].includes(data.status))
    badges.push(["waiting", "待生成"]);
  if (data.stale) badges.push(["stale", "输入已变化"]);
  const details = [
    data.title,
    data.provenanceUnknown ? "此图片尚未记录生成时使用的输入版本" : "",
    data.generation?.tool ? `生成工具：${data.generation.tool}` : "",
    data.generation?.prompt ? `提示词：${data.generation.prompt}` : "",
    data.generation?.error ? `生成失败：${data.generation.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className={`card ${type}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="node-label">
        <span className="node-title" title={details}>
          {data.title}
        </span>
        {badges.map(([kind, label]) => (
          <small
            key={kind}
            className={`node-status ${kind}`}
            title={
              kind === "failed"
                ? data.generation?.error
                : kind === "stale"
                  ? "输入图片或依赖已变化，可让 Codex 重新生成"
                  : label
            }
          >
            {label}
          </small>
        ))}
        <button
          className="node-delete nodrag nopan"
          type="button"
          aria-label={`删除 ${data.title}`}
          title="删除节点"
          onClick={(event) => {
            event.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          ×
        </button>
      </div>
      {type === "image" &&
        (data.asset ? (
          <div className="image-content">
            <MediaImage
              key={data.asset.id}
              asset={data.asset}
              title={data.title}
              width={width || 300}
              height={Math.max(1, (height || 240) - 40)}
            />
          </div>
        ) : (
          <div className="placeholder">等待图片</div>
        ))}
      {type === "video" &&
        (data.asset ? (
          <video
            className="nodrag nopan nowheel"
            src={data.asset.url}
            controls
            preload="metadata"
          />
        ) : (
          <div className="placeholder">等待视频</div>
        ))}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = {
  image: MediaNode,
  video: MediaNode,
};
function App() {
  const [state, setState] = useState({
    nodes: [],
    edges: [],
    assets: [],
    name: "画布",
  });
  const [nodes, setNodes] = useState([]);
  const [status, setStatus] = useState("连接中");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(0);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const flow = useReactFlow();
  const mounted = useRef(false);
  const sequence = useRef(0);
  const revision = useRef(-1);
  const confirmed = useRef(null);
  const writes = useRef(Promise.resolve());
  const dragging = useRef(new Set());
  const pendingMoves = useRef(new Map());
  const pendingDeletes = useRef(new Set());
  const viewSequence = useRef(0);
  const showState = useCallback((data) => {
    confirmed.current = data;
    revision.current = data.revision;
    setState(data);
    setNodes((old) => {
      const previousNodes = new Map(old.map((node) => [node.id, node]));
      const assets = new Map(data.assets.map((asset) => [asset.id, asset]));
      return data.nodes
        .filter(
          (n) =>
            ["image", "video"].includes(n.type) &&
            !pendingDeletes.current.has(n.id),
        )
        .map((n) => {
          const previous = previousNodes.get(n.id);
          return {
            ...n,
            selected: previous?.selected || false,
            measured: previous?.measured,
            position:
              (dragging.current.has(n.id)
                ? previous?.position
                : pendingMoves.current.get(n.id)?.position) || n.position,
            data: {
              ...n.data,
              asset: assets.get(n.data.assetId),
            },
          };
        });
    });
  }, []);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    const [data, nextHistory] = await Promise.all([
      requestJson("/api/state"),
      requestJson("/api/history?limit=1").catch(() => null),
    ]);
    if (
      !mounted.current ||
      current !== sequence.current ||
      data.revision < revision.current
    )
      return;
    showState(data);
    if (nextHistory) setHistory(nextHistory);
  }, [showState]);
  const followView = useCallback(
    async (request) => {
      if (
        !request ||
        !["fit", "focus"].includes(request.action) ||
        typeof request.requestId !== "string"
      )
        return;
      const ids =
        Array.isArray(request.ids) && request.ids.length
          ? [...new Set(request.ids.filter((id) => typeof id === "string"))]
          : undefined;
      if (request.action === "focus" && !ids?.length) return;
      const ticket = ++viewSequence.current;
      await refresh();
      // SSE can arrive before React has committed/measured the newly added nodes.
      // Read the live Flow store after frames, and retry only for this view request.
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!mounted.current || ticket !== viewSequence.current) return;
        const allNodes = flow.getNodes();
        const targets = ids
          ? allNodes.filter((node) => ids.includes(node.id))
          : allNodes;
        if (
          (!ids || targets.length === ids.length) &&
          targets.length &&
          targets.every(
            (node) => node.measured?.width > 0 && node.measured?.height > 0,
          )
        ) {
          await flow.fitView({
            padding: 0.2,
            duration: 300,
            ...(ids ? { nodes: ids.map((id) => ({ id })) } : {}),
          });
          return;
        }
        if (attempt > 0 && attempt % 30 === 0) await refresh();
      }
      if (mounted.current && ticket === viewSequence.current && ids)
        setError("定位的节点尚未就绪，请重试定位命令");
    },
    [flow, refresh],
  );
  useEffect(() => {
    mounted.current = true;
    const read = () =>
      refresh().catch((e) => {
        if (mounted.current) setError(e.message);
      });
    const events = new EventSource("/api/events");
    events.onmessage = read;
    events.onopen = () => {
      setStatus("已同步");
      read();
    };
    events.onerror = () => setStatus("正在重连");
    events.addEventListener("view", (event) => {
      try {
        followView(JSON.parse(event.data)).catch((e) => {
          if (mounted.current) setError(e.message);
        });
      } catch {
        // Ignore malformed events without interrupting state synchronization.
      }
    });
    read();
    return () => {
      mounted.current = false;
      viewSequence.current++;
      events.close();
    };
  }, [refresh, followView]);
  const queueWrite = useCallback(
    (
      commit,
      release = () => {},
      failureLabel = "保存失败，已恢复上次同步状态：",
    ) => {
      setSaving((count) => count + 1);
      const run = writes.current.then(async () => {
        let failed = false;
        try {
          const result = await commit();
          const saved = result.state || result;
          if (mounted.current) {
            if (saved.revision >= revision.current)
              showState({ ...saved, assets: confirmed.current?.assets || [] });
            setError("");
          }
        } catch (e) {
          failed = true;
          if (mounted.current)
            setError(
              e.status === 409
                ? "画布已有新修改，请同步后重试此操作"
                : failureLabel + e.message,
            );
        } finally {
          release();
          // Restore immediately even if the server is unreachable. Later queued
          // edits and active drags are preserved by showState's overlays.
          if (mounted.current && confirmed.current)
            showState(confirmed.current);
          try {
            await refresh();
          } catch (e) {
            if (mounted.current && !failed)
              setError("已保存，刷新失败：" + e.message);
          }
          if (mounted.current) setSaving((count) => count - 1);
        }
      });
      writes.current = run.catch(() => {});
    },
    [refresh, showState],
  );
  const save = (operations, release) =>
    queueWrite(() => commitOperations(operations), release);
  const changeHistory = useCallback(
    (direction) => {
      if (dragging.current.size) return;
      queueWrite(
        () => commitHistory(direction, revision.current),
        undefined,
        direction === "undo" ? "撤销失败：" : "重做失败：",
      );
    },
    [queueWrite],
  );
  useEffect(() => {
    const onKeyDown = (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "z" ||
        event.repeat
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, video, [contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      event.preventDefault();
      const direction = event.shiftKey ? "redo" : "undo";
      if (!saving && history[direction === "undo" ? "canUndo" : "canRedo"])
        changeHistory(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeHistory, history, saving]);
  const finishDrag = (_, node, moved) => {
    const entries = (moved?.length ? moved : [node]).map((n) => {
      dragging.current.delete(n.id);
      const move = { position: { ...n.position } };
      pendingMoves.current.set(n.id, move);
      return [n.id, move];
    });
    save(
      entries.map(([id, move]) => ({
        op: "node.move",
        id,
        position: move.position,
      })),
      () => {
        for (const [id, move] of entries)
          if (pendingMoves.current.get(id) === move)
            pendingMoves.current.delete(id);
      },
    );
  };
  const deleteNodes = (removed) => {
    const ids = removed.map((n) => n.id);
    ids.forEach((id) => pendingDeletes.current.add(id));
    save(
      ids.map((id) => ({ op: "node.delete", id })),
      () => ids.forEach((id) => pendingDeletes.current.delete(id)),
    );
  };
  const edges = useMemo(() => {
    const visibleIds = new Set(nodes.map((node) => node.id));
    return state.edges
      .filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      )
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }));
  }, [nodes, state.edges]);
  return (
    <main className="viewer">
      <header>
        <strong>{state.name}</strong>
        <span className="connection">
          <i className={!saving && status === "已同步" ? "live" : ""} />
          {saving ? "保存中" : status}
        </span>
      </header>
      <ReactFlow
        nodes={nodes}
        onNodesChange={(changes) => {
          for (const change of changes) {
            if (
              (change.type === "position" && change.dragging === false) ||
              change.type === "remove"
            )
              dragging.current.delete(change.id);
          }
          setNodes((ns) => applyNodeChanges(changes, ns));
        }}
        onNodeDragStart={(_, node, moved) =>
          (moved?.length ? moved : [node]).forEach((n) =>
            dragging.current.add(n.id),
          )
        }
        onNodeDragStop={finishDrag}
        onNodesDelete={deleteNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        edgesReconnectable={false}
        nodesFocusable={true}
        disableKeyboardA11y={true}
        edgesFocusable={false}
        deleteKeyCode={["Backspace", "Delete"]}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={8}
        fitView
        defaultEdgeOptions={{
          type: "default",
          selectable: false,
          deletable: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#a0aa9a" },
          style: { stroke: "#a0aa9a" },
        }}
      >
        <Background color="#d8dcd5" gap={24} size={1} />
        <Controls showInteractive={false}>
          <ControlButton
            title="撤销（Ctrl / ⌘ Z）"
            aria-label="撤销"
            disabled={saving > 0 || !history.canUndo}
            onClick={() => changeHistory("undo")}
          >
            <span className="history-icon" aria-hidden="true">
              ↶
            </span>
          </ControlButton>
          <ControlButton
            title="重做（Ctrl / ⌘ Shift Z）"
            aria-label="重做"
            disabled={saving > 0 || !history.canRedo}
            onClick={() => changeHistory("redo")}
          >
            <span className="history-icon" aria-hidden="true">
              ↷
            </span>
          </ControlButton>
        </Controls>
      </ReactFlow>
      {!nodes.length && (
        <div className="empty">
          <h1>把想法放到画布上</h1>
          <p>告诉 Codex：「添加一个图片节点」</p>
          <small>生成的图片和视频会在这里显示</small>
        </div>
      )}
      <div className="view-tools">
        <span>{nodes.length} 个节点</span>
        <button onClick={() => flow.fitView({ padding: 0.2, duration: 300 })}>
          查看全部 ↗
        </button>
      </div>
      <div className="hint">拖动节点移动 · 滚轮缩放 · 右上角 × 删除</div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
