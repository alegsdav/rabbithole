"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { formatViews } from "@/lib/format";
import type { VideoCard } from "@/shared/types";
import { Close, External, ThumbUp } from "./icons";

type YTPlayer = { destroy: () => void; getCurrentTime: () => number };
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
        onReady?: () => void;
      };
    },
  ) => YTPlayer;
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

/** Loads the YouTube IFrame Player API once. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error("Could not load the YouTube player"));
      };
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

const PLAYING = 1;
const EMBED_ERRORS: Record<number, string> = {
  2: "This video link is invalid.",
  5: "This video can't play in an embedded player.",
  100: "This video was removed or made private.",
  101: "The owner doesn't allow this video to play outside YouTube.",
  150: "The owner doesn't allow this video to play outside YouTube.",
};

export function PlayerModal({ video, laneId, accent, onClose }: { video: VideoCard; laneId: string | null; accent?: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const watched = useRef(0);
  const clickSent = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (!clickSent.current) {
      clickSent.current = true;
      void api("/api/signals", { body: { videoId: video.videoId, kind: "click", laneId, channelId: video.channelId } }).catch(() => {});
    }

    let player: YTPlayer | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        const host = document.createElement("div");
        mountRef.current.appendChild(host);
        player = new YT.Player(host, {
          videoId: video.videoId,
          width: "100%",
          height: "100%",
          playerVars: { autoplay: 1, rel: 0, playsinline: 1, origin: window.location.origin },
          events: {
            onStateChange: (e) => {
              if (e.data === PLAYING && !timer) {
                timer = setInterval(() => (watched.current += 1), 1000);
              } else if (e.data !== PLAYING && timer) {
                clearInterval(timer);
                timer = null;
              }
            },
            onError: (e) => setError(EMBED_ERRORS[e.data] ?? "This video can't be played here."),
          },
        });
      })
      .catch((err: Error) => setError(err.message));

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      player?.destroy();
      if (watched.current > 0) {
        const seconds = watched.current;
        watched.current = 0;
        void api("/api/signals", { body: { videoId: video.videoId, kind: "watch", value: seconds, laneId, channelId: video.channelId } }).catch(() => {});
      }
    };
  }, [video.videoId, video.channelId, laneId]);

  const like = () => {
    if (liked) return;
    setLiked(true);
    void api("/api/signals", { body: { videoId: video.videoId, kind: "like", laneId, channelId: video.channelId } }).catch(() => setLiked(false));
  };

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="player-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-auto w-[min(1100px,96vw)] max-w-none overflow-visible rounded-2xl bg-surface p-0 text-fg shadow-2xl"
    >
      <div className="flex flex-col">
        <div className="relative aspect-video w-full overflow-hidden rounded-t-2xl bg-black" ref={mountRef}>
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
              <p>{error}</p>
              <a href={watchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-black">
                Watch on YouTube <External />
              </a>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 p-4" style={accent ? { borderTop: `3px solid ${accent}` } : undefined}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="player-title" className="text-lg font-semibold leading-snug">
                {video.title}
              </h2>
              <p className="text-sm text-muted">
                {video.channelTitle}
                {video.viewCount !== null ? ` · ${formatViews(video.viewCount)}` : ""}
              </p>
            </div>
            <button type="button" aria-label="Close player" className="rounded-full p-2 hover:bg-subtle" onClick={() => dialogRef.current?.close()}>
              <Close />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={like}
              aria-pressed={liked}
              className="inline-flex items-center gap-2 rounded-full bg-subtle px-4 py-2 text-sm font-medium aria-pressed:bg-fg aria-pressed:text-bg"
            >
              <ThumbUp /> {liked ? "Liked" : "Like"}
            </button>
            <a href={watchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-subtle px-4 py-2 text-sm font-medium">
              Open on YouTube <External />
            </a>
          </div>
          <p className="text-xs text-muted">
            Likes and watch time here only tune Rabbithole&apos;s own ranking; nothing is posted to YouTube. Videos played in this embedded player may not be added to your YouTube watch history, so open them on YouTube when you want them to count there.
          </p>
        </div>
      </div>
    </dialog>
  );
}
