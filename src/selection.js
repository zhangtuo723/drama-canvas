import { queryState } from "./queries.js";
import { projectId } from "./runtime.js";

const fail = (message, code, status = 409) =>
  Object.assign(new Error(message), { code, status });
const validSession = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(id);

// Ephemeral viewer state: never stored in SQLite, revisions or undo history.
export class SelectionRegistry {
  constructor(store, { now = Date.now, ttl = 60000 } = {}) {
    this.store = store;
    this.now = now;
    this.ttl = ttl;
    this.sessions = new Map();
  }
  identity() {
    return { project: this.store.dir, projectId: projectId(this.store.dir) };
  }
  summary(session) {
    return {
      ...session,
      status: session.expiresAt > this.now() ? "active" : "expired",
    };
  }
  update(body) {
    const {
      sessionId,
      sequence,
      selectedIds,
      revision,
      closed = false,
    } = body || {};
    if (
      !validSession(sessionId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Array.isArray(selectedIds) ||
      selectedIds.length > 1000 ||
      !selectedIds.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 1000,
      ) ||
      !Number.isSafeInteger(revision) ||
      typeof closed !== "boolean"
    )
      throw fail("无效的浏览器选择会话", "INVALID_ARGUMENT", 400);
    const previous = this.sessions.get(sessionId);
    if (previous && sequence <= previous.sequence)
      throw fail("忽略较早的选择更新", "SELECTION_OUT_OF_ORDER");
    // Bound memory without evicting an active tab. Keep expired entries briefly
    // so references can explain expiry instead of silently selecting another tab.
    for (const [id, session] of this.sessions)
      if (session.expiresAt + this.ttl * 10 < this.now())
        this.sessions.delete(id);
    if (!previous && this.sessions.size >= 1000)
      throw fail("浏览器会话过多，请稍后重试", "SELECTION_SESSION_LIMIT", 429);
    const timestamp = this.now();
    const session = {
      sessionId,
      sequence,
      selectedIds: [...new Set(selectedIds)],
      revision,
      updatedAt: timestamp,
      expiresAt: closed ? timestamp : timestamp + this.ttl,
    };
    const state = this.store.get();
    const existing = new Set(state.nodes.map((node) => node.id));
    const invalid =
      !closed && revision !== state.revision
        ? fail("画布已变化，请等待页面同步后重新选择", "SELECTION_STALE")
        : !closed && selectedIds.some((id) => !existing.has(id))
          ? fail("选中节点已删除，请重新选择", "SELECTION_NODE_DELETED")
          : null;
    // A newer rejected selection must invalidate the old one and advance the
    // sequence barrier. Never expose the previous target after the user changed it.
    if (invalid) session.invalidCode = invalid.code;
    this.sessions.set(sessionId, session);
    if (invalid) throw invalid;
    return { ...this.identity(), ...this.summary(session) };
  }
  list() {
    return {
      ...this.identity(),
      sessions: [...this.sessions.values()].map((s) => this.summary(s)),
    };
  }
  get(sessionId) {
    if (sessionId !== undefined && !validSession(sessionId))
      throw fail("无效的 session ID", "INVALID_ARGUMENT", 400);
    let session;
    if (sessionId !== undefined) {
      session = this.sessions.get(sessionId);
      if (!session)
        throw fail(
          "此工程没有该浏览器会话；请运行 selection sessions",
          "SELECTION_SESSION_NOT_FOUND",
          404,
        );
    } else {
      const active = [...this.sessions.values()].filter(
        (s) => s.expiresAt > this.now(),
      );
      if (active.length > 1)
        throw fail(
          "多个浏览器标签页可用；请运行 selection sessions，并使用 --session 指定目标，或复制页面中的选择引用",
          "SELECTION_AMBIGUOUS",
        );
      session = active[0];
      if (!session)
        throw fail(
          "没有新鲜的浏览器选择；请打开画布并重新选择节点",
          this.sessions.size ? "SELECTION_EXPIRED" : "SELECTION_UNAVAILABLE",
        );
    }
    if (session.expiresAt <= this.now())
      throw fail(
        "浏览器选择已过期；请返回目标标签页重新选择",
        "SELECTION_EXPIRED",
      );
    if (session.invalidCode)
      throw fail(
        "浏览器选择尚未同步，请返回标签页等待同步并重新选择",
        session.invalidCode,
      );
    if (!session.selectedIds.length)
      throw fail("目标标签页没有选中节点，请先点击节点", "SELECTION_EMPTY");
    const state = this.store.get();
    const existing = new Set(state.nodes.map((node) => node.id));
    if (session.selectedIds.some((id) => !existing.has(id)))
      throw fail(
        "选中节点已删除；不会返回部分选择，请重新选择",
        "SELECTION_NODE_DELETED",
      );
    const assets = this.store.assets();
    return {
      ...this.identity(),
      ...this.summary(session),
      observedRevision: session.revision,
      revision: state.revision,
      nodes: session.selectedIds.map((node) =>
        queryState(state, assets, this.store.dir, { node }),
      ),
    };
  }
}
