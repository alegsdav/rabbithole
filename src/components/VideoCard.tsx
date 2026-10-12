"use client";

import type { VideoCard as Card } from "@/shared/types";
import { formatAge, formatDuration, formatViews } from "@/lib/format";

export function VideoCard({ video, onPlay }: { video: Card; onPlay: (v: Card) => void }) {
  const duration = formatDuration(video.durationSec, video.isLive);
  const meta = [formatViews(video.viewCount), formatAge(video.publishedAt)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-card=""
      onClick={() => onPlay(video)}
      className="group flex w-full flex-col gap-2 text-left"
      aria-label={`${video.title}, ${video.channelTitle}${duration ? `, ${duration}` : ""}, ${meta}`}
    >
      <span className="relative block aspect-video w-full overflow-hidden rounded-xl bg-subtle">
        {/* eslint-disable-next-line @next/next/no-img-element -- thumbnails come straight from i.ytimg.com */}
        <img
          src={video.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        {duration && (
          <span
            className={`absolute bottom-1.5 right-1.5 rounded px-1 py-0.5 text-xs font-medium text-white ${video.isLive ? "bg-red-600" : "bg-black/80"}`}
          >
            {duration}
          </span>
        )}
      </span>
      <span className="flex flex-col gap-0.5 pr-2">
        <span className="line-clamp-2 text-sm font-semibold leading-snug">{video.title}</span>
        <span className="truncate text-[13px] text-muted">{video.channelTitle}</span>
        <span className="text-[13px] text-muted">{meta}</span>
      </span>
    </button>
  );
}

export function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <div className="skeleton aspect-video w-full rounded-xl" />
      <div className="skeleton h-4 w-11/12 rounded" />
      <div className="skeleton h-3 w-1/2 rounded" />
    </div>
  );
}
