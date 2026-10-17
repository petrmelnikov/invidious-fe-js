function revision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function normalizeProgressAccount(stored = {}, name = "") {
  const progress = Object.fromEntries(Object.entries(stored.progress || {}).map(([videoId, entry]) => [videoId, {
    videoId,
    title: String(entry?.title || ""),
    author: String(entry?.author || ""),
    thumbnail: String(entry?.thumbnail || ""),
    currentTime: Math.max(0, Number(entry?.currentTime) || 0),
    duration: Math.max(0, Number(entry?.duration) || 0),
    updatedAt: Number(entry?.updatedAt) || 0
  }]));
  // Revisions survive deletion: an old player must not recreate a removed/finished video.
  const revisions = Object.fromEntries(Object.entries(stored.revisions || {}).map(([id, value]) => [id, revision(value)]));
  for (const id of Object.keys(progress)) revisions[id] ??= 0;
  return { name: name || stored.name, progress, revisions, lastOperations: { ...stored.lastOperations } };
}

export function applyProgressOperations(account, ops) {
  const results = [];
  for (const op of ops) {
    const videoId = typeof op?.videoId === "string" ? op.videoId : "";
    const currentRevision = account.revisions[videoId] || 0;
    const result = { id: op?.id, videoId, revision: currentRevision, status: "conflict" };
    const valid = videoId && typeof op.id === "string" && op.id
      && Number.isSafeInteger(op.expectedRevision) && op.expectedRevision >= 0
      && (op.type === "remove" || (op.type === "upsert" && op.entry
        && Number.isFinite(op.entry.currentTime) && op.entry.currentTime >= 0));

    if (valid && account.lastOperations[videoId] === op.id) {
      // The previous response may have been lost. Retrying must not advance the revision.
      result.status = "duplicate";
    } else if (valid && op.expectedRevision === currentRevision) {
      const nextRevision = currentRevision + 1;
      if (op.type === "remove") {
        delete account.progress[videoId];
      } else {
        const normalized = normalizeProgressAccount({ progress: { [videoId]: op.entry } });
        account.progress[videoId] = { ...normalized.progress[videoId], updatedAt: Date.now() };
      }
      account.revisions[videoId] = nextRevision;
      account.lastOperations[videoId] = op.id;
      result.revision = nextRevision;
      result.status = "applied";
    }
    results.push(result);
  }
  return results;
}
