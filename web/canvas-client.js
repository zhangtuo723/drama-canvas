export async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

// Apply only the changed properties. A concurrent CLI edit must not be replaced
// by an old copy of the node from the browser.
export async function commitOperations(operations) {
  const { token } = await requestJson("/api/session");
  const requestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { revision } = await requestJson("/api/state");
    try {
      return await requestJson("/api/operations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Token": token,
        },
        body: JSON.stringify({ requestId, revision, operations }),
      });
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
}

// History is tied to the revision the user saw. Unlike a property update,
// retrying an undo after a conflict could undo somebody else's newer work.
export async function commitHistory(direction, revision) {
  if (!["undo", "redo"].includes(direction)) throw new Error("无效的历史操作");
  const { token } = await requestJson("/api/session");
  return requestJson(`/api/history/${direction}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Canvas-Token": token,
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), revision }),
  });
}

// Use the actual on-screen size, including display density and object-fit,
// so zooming in upgrades to the original without loading every full image.
export function imageSource(asset, { width, height, zoom, pixelRatio = 1 }) {
  if (!asset.thumbnailUrl || !asset.width || !asset.height) return asset.url;
  const scale = Math.min(width / asset.width, height / asset.height);
  const screenWidth = asset.width * scale * zoom * pixelRatio;
  const screenHeight = asset.height * scale * zoom * pixelRatio;
  const thumbnailScale = Math.min(1, 480 / Math.max(asset.width, asset.height));
  const thumbnailWidth = asset.thumbnailWidth || asset.width * thumbnailScale;
  const thumbnailHeight =
    asset.thumbnailHeight || asset.height * thumbnailScale;
  return screenWidth <= thumbnailWidth && screenHeight <= thumbnailHeight
    ? asset.thumbnailUrl
    : asset.url;
}
