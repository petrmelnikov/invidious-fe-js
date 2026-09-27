import { escapeHtml, relativeTime, secondsToDuration } from "./utils.js";

export function progressCard(entry) {
  const title = entry.title || "Untitled video";
  const href = `/watch?v=${encodeURIComponent(entry.videoId)}`;
  const resumeAt = secondsToDuration(entry.currentTime) || "0:00";
  const duration = secondsToDuration(entry.duration);
  const updatedAt = relativeTime(Math.floor(Number(entry.updatedAt || 0) / 1000));

  return `
    <article class="video-card video-card-compact progress-card">
      <a class="thumb" href="${href}" data-link aria-label="${escapeHtml(title)}">
        ${entry.thumbnail ? `<img src="${escapeHtml(entry.thumbnail)}" alt="" loading="lazy">` : '<span class="thumb-fallback">Resume</span>'}
        <span class="duration">${escapeHtml(duration ? `${resumeAt} / ${duration}` : resumeAt)}</span>
      </a>

      <div class="video-info">
        <h2><a href="${href}" data-link>${escapeHtml(title)}</a></h2>
        ${entry.author ? `<p class="meta">${escapeHtml(entry.author)}</p>` : ""}
        <p class="meta">Resume at ${escapeHtml(resumeAt)}${updatedAt ? ` · Updated ${escapeHtml(updatedAt)}` : ""}</p>
      </div>

      <button class="button button-ghost card-remove" type="button"
        data-remove-progress="${escapeHtml(entry.videoId)}"
        data-remove-title="${escapeHtml(title)}"
        title="Remove from saved progress" aria-label="Remove ${escapeHtml(title)} from saved progress">✕</button>
    </article>
  `;
}
