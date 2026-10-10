import { requestJson } from "./canvas-client.js";

// Deliberately memory-only: sessionStorage is copied when duplicating tabs.
export function createSelectionPublisher({
  request = requestJson,
  sessionId = crypto.randomUUID(),
} = {}) {
  let sequence = 0;
  let cachedToken;
  return {
    sessionId,
    async publish(
      selectedIds,
      revision,
      { closed = false, keepalive = false } = {},
    ) {
      // Allocate before the token request so late network responses cannot win.
      const update = {
        sessionId,
        sequence: ++sequence,
        selectedIds: [...selectedIds],
        revision,
        closed,
      };
      // pagehide must dispatch its keepalive POST before any await. A new token
      // read could be cancelled by navigation before the close is even sent.
      let token = cachedToken;
      if (!closed || !token) {
        ({ token } = await request("/api/session"));
        cachedToken = token;
      }
      return request("/api/selection", {
        method: "POST",
        keepalive,
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Token": token,
        },
        body: JSON.stringify(update),
      });
    },
  };
}

export function selectionReference(selection) {
  return JSON.stringify(
    {
      kind: "drama-canvas-selection",
      project: selection.project,
      projectId: selection.projectId,
      sessionId: selection.sessionId,
      selectedIds: selection.selectedIds,
      revision: selection.revision,
      updatedAt: selection.updatedAt,
      expiresAt: selection.expiresAt,
    },
    null,
    2,
  );
}
