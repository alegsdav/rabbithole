"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { api } from "@/lib/api";
import { formatAge } from "@/lib/format";
import { LANE_COLORS, type LaneSummary, type VideoCard as Card } from "@/shared/types";
import { ChevronLeft, ChevronRight, More, Refresh } from "./icons";
import { CardSkeleton, VideoCard } from "./VideoCard";

export type LaneActions = {
  refresh: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  recolor: (id: string, color: string) => Promise<void>;
  move: (id: string, delta: -1 | 1) => Promise<void>;
  remove: (id: string) => Promise<void>;
  play: (video: Card, lane: LaneSummary) => void;
};

export function Lane({
  lane,
  index,
  count,
  isRefreshing,
  actions,
}: {
  lane: LaneSummary;
  index: number;
  count: number;
  isRefreshing: boolean;
  actions: LaneActions;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState(lane.items);
  const [hasMore, setHasMore] = useState(lane.hasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: false });
  const headingId = useId();

  // A refresh hands down a new first page: reset to it (adjusting state during render, not in an effect).
  const [firstPage, setFirstPage] = useState(lane.items);
  if (firstPage !== lane.items) {
    setFirstPage(lane.items);
    setItems(lane.items);
    setHasMore(lane.hasMore);
  }

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<{ items: Card[]; hasMore: boolean }>(`/api/lanes/${lane.id}/items?offset=${items.length}`);
      setItems((prev) => [...prev, ...page.items.filter((v) => !prev.some((p) => p.videoId === v.videoId))]);
      setHasMore(page.hasMore);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, items.length, lane.id]);

  const onScroll = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
    setEdges({ start: el.scrollLeft <= 8, end });
    if (el.scrollLeft + el.clientWidth >= el.scrollWidth - el.clientWidth) void loadMore();
  }, [loadMore]);

  useEffect(() => {
    onScroll();
  }, [items.length, onScroll]);

  const scrollByPage = (dir: -1 | 1) => {
    const el = gridRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const el = gridRef.current;
    if (!el) return;
    // Move focus card by card (two rows: the neighbor column is two cards away), scrolling as needed.
    const cards = Array.from(el.querySelectorAll<HTMLButtonElement>("button[data-card]"));
    const i = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) {
      scrollByPage(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    const next = cards[i + (e.key === "ArrowRight" ? 2 : -2)];
    next?.focus();
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const showSkeleton = items.length === 0 && (isRefreshing || (!lane.lastRefreshedAt && !lane.lastError));
  const isEmpty = items.length === 0 && !showSkeleton;

  return (
    <section aria-labelledby={headingId} className="py-4">
      <LaneHeader lane={lane} index={index} count={count} isRefreshing={isRefreshing} actions={actions} headingId={headingId} />

      {lane.lastError && items.length > 0 && (
        <p role="status" className="mx-4 mb-2 text-[13px] text-danger">
          Couldn&apos;t refresh: {lane.lastError} Showing the last saved videos.
        </p>
      )}

      <div className="group/lane relative">
        {showSkeleton ? (
          <div className="lane-grid" aria-busy="true" aria-label={`Loading ${lane.name}`}>
            {Array.from({ length: 10 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="mx-4 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
            {lane.lastError ? (
              <p>
                Couldn&apos;t load this lane: {lane.lastError}{" "}
                <button type="button" className="underline" onClick={() => void actions.refresh(lane.id)}>
                  Try again
                </button>
              </p>
            ) : lane.channelCount === 0 ? (
              <p>
                No videos yet. Search for something in this interest, or{" "}
                <a className="underline" href="/channels">
                  file some subscriptions here
                </a>
                .
              </p>
            ) : (
              <p>No recent videos from this lane&apos;s channels.</p>
            )}
          </div>
        ) : (
          <>
            <div
              ref={gridRef}
              className="lane-grid"
              role="region"
              aria-label={`${lane.name} videos`}
              tabIndex={0}
              onScroll={onScroll}
              onKeyDown={onKeyDown}
            >
              {items.map((video) => (
                <VideoCard key={video.videoId} video={video} onPlay={(v) => actions.play(v, lane)} />
              ))}
              {loadingMore && <CardSkeleton />}
            </div>
            {!edges.start && (
              <Chevron side="left" label={`Scroll ${lane.name} left`} onClick={() => scrollByPage(-1)} />
            )}
            {!edges.end && <Chevron side="right" label={`Scroll ${lane.name} right`} onClick={() => scrollByPage(1)} />}
          </>
        )}
      </div>
    </section>
  );
}

function Chevron({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      className={`absolute top-[calc(var(--card-w)*0.28)] z-10 hidden h-10 w-10 items-center justify-center rounded-full border border-border bg-surface shadow-md transition-opacity group-hover/lane:flex md:flex md:opacity-0 md:group-hover/lane:opacity-100 ${
        side === "left" ? "left-2" : "right-2"
      }`}
    >
      {side === "left" ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

function LaneHeader({
  lane,
  index,
  count,
  isRefreshing,
  actions,
  headingId,
}: {
  lane: LaneSummary;
  index: number;
  count: number;
  isRefreshing: boolean;
  actions: LaneActions;
  headingId: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "rename" | "recolor" | "delete">("menu");
  const [name, setName] = useState(lane.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    const first = menuRef.current?.querySelector<HTMLElement>("input, button");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, mode]);

  const close = () => {
    setOpen(false);
    setMode("menu");
    buttonRef.current?.focus();
  };

  const item = "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-subtle disabled:opacity-40";

  return (
    <div className="relative mb-3 flex items-center gap-3 px-4">
      <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: lane.color }} aria-hidden="true" />
      <h2 id={headingId} className="truncate text-xl font-bold">
        {lane.name}
      </h2>
      <span className="hidden text-[13px] text-muted sm:inline">
        {isRefreshing ? "Refreshing…" : lane.lastRefreshedAt ? `Updated ${formatAge(lane.lastRefreshedAt)}` : "Not loaded yet"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className="rounded-full p-2 hover:bg-subtle disabled:opacity-40"
          aria-label={`Refresh ${lane.name}`}
          onClick={() => void actions.refresh(lane.id)}
          disabled={isRefreshing}
        >
          <Refresh className={isRefreshing ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
        <button
          ref={buttonRef}
          type="button"
          className="rounded-full p-2 hover:bg-subtle"
          aria-label={`${lane.name} lane options`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setMode("menu");
            setName(lane.name);
            setOpen((o) => !o);
          }}
        >
          <More />
        </button>
      </div>

      {open && (
        <div ref={menuRef} role="menu" aria-label={`${lane.name} options`} className="absolute right-4 top-11 z-30 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-xl">
          {mode === "menu" && (
            <>
              <button role="menuitem" type="button" className={item} onClick={() => { close(); void actions.refresh(lane.id); }}>Refresh</button>
              <button role="menuitem" type="button" className={item} onClick={() => setMode("rename")}>Rename</button>
              <button role="menuitem" type="button" className={item} onClick={() => setMode("recolor")}>Change color</button>
              <button role="menuitem" type="button" className={item} disabled={index === 0} onClick={() => { close(); void actions.move(lane.id, -1); }}>Move up</button>
              <button role="menuitem" type="button" className={item} disabled={index === count - 1} onClick={() => { close(); void actions.move(lane.id, 1); }}>Move down</button>
              <button role="menuitem" type="button" className={`${item} text-danger`} onClick={() => setMode("delete")}>Delete lane</button>
            </>
          )}
          {mode === "rename" && (
            <form
              className="flex flex-col gap-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void actions.rename(lane.id, name.trim());
                close();
              }}
            >
              <label className="text-xs text-muted" htmlFor={`${headingId}-name`}>Lane name</label>
              <input id={`${headingId}-name`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm" />
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-subtle" onClick={close}>Cancel</button>
                <button type="submit" className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg">Save</button>
              </div>
            </form>
          )}
          {mode === "recolor" && (
            <div className="grid grid-cols-5 gap-2 p-2" role="group" aria-label="Lane color">
              {LANE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={c === lane.color}
                  className="h-9 w-9 rounded-full border-2 border-transparent aria-pressed:border-fg"
                  style={{ backgroundColor: c }}
                  onClick={() => {
                    void actions.recolor(lane.id, c);
                    close();
                  }}
                />
              ))}
            </div>
          )}
          {mode === "delete" && (
            <div className="flex flex-col gap-2 p-2 text-sm">
              <p>Delete “{lane.name}”? Its saved videos are removed and its channels become unassigned.</p>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md px-3 py-1.5 hover:bg-subtle" onClick={close}>Cancel</button>
                <button type="button" className="rounded-md bg-danger px-3 py-1.5 font-medium text-on-danger" onClick={() => { close(); void actions.remove(lane.id); }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
