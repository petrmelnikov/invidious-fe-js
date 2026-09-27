const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_SEEDS = 12;

export function mixRecommendations(lists, saved, limit = 60) {
  const seen = new Set(saved.map((entry) => entry.videoId));
  const mixed = [];
  const length = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < length && mixed.length < limit; index += 1) {
    for (const list of lists) {
      const item = list[index];
      const id = item?.videoId || item?.id;
      if (!VIDEO_ID.test(id || "") || seen.has(id) || (item.type && item.type !== "video")) continue;
      seen.add(id);
      mixed.push({ ...item, videoId: id });
      if (mixed.length >= limit) break;
    }
  }
  return mixed;
}

export async function loadRecommendations(saved, fetchVideo, isCurrent = () => true) {
  const seeds = saved.filter((entry) => VIDEO_ID.test(entry.videoId)).slice(0, MAX_SEEDS);
  const lists = seeds.map(() => []);
  let next = 0;
  let failed = 0;
  async function consume() {
    while (next < seeds.length && isCurrent()) {
      const index = next++;
      try {
        const video = await fetchVideo(seeds[index].videoId);
        const related = [video?.recommendedVideos, video?.relatedVideos]
          .find((items) => Array.isArray(items) && items.length);
        lists[index] = related || [];
      } catch {
        failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, seeds.length) }, consume));
  return { items: mixRecommendations(lists, saved), failed, total: seeds.length };
}
