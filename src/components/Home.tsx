"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "@/lib/api";
import type { LaneSummary, RouteDecision, VideoCard as Card } from "@/shared/types";
import { Refresh, Search, Settings } from "./icons";
import { Lane, type LaneActions } from "./Lane";
import { PlayerModal } from "./PlayerModal";
import { SearchPanel, type SearchState } from "./SearchPanel";

const SCHEDULE_MS = 30 * 60 * 1000;

export function Home({ initialLanes, userName }: { initialLanes: LaneSummary[]; userName: string | null }) {
  const [lanes, setLanes] = useState(initialLanes);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<{ video: Card; laneId: string | null; accent?: string } | null>(null);
  const [search, setSearch] = useState<SearchState>({ phase: "idle" });
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);

  const reloadLanes = useCallback(async () => {
    const res = await api<{ lanes: LaneSummary[] }>("/api/lanes");
    setLanes(res.lanes);
    return res.lanes;
  }, []);

  const report = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.code === "reauth") {
      setNotice("Your Google access expired. Sign in again to keep lanes fresh.");
    } else {
      setNotice(err instanceof Error ? err.message : "Something went wrong");
    }
  }, []);

  /** Refreshes stale lanes in the background, one at a time on the server. */
  const refreshStale = useCallback(async () => {
    if (busy.current) return;
    const stale = new Set(lanes.filter((l) => l.isStale).map((l) => l.id));
    if (stale.size === 0) return;
    busy.current = true;
    setRefreshing(stale);
    try {
      const res = await api<{ lanes: LaneSummary[] }>("/api/refresh", { method: "POST", body: {} });
      setLanes(res.lanes);
    } catch (err) {
      report(err);
    } finally {
      busy.current = false;
      setRefreshing(new Set());
    }
  }, [lanes, report]);

  // On load and every 30 minutes while the page is visible.
  useEffect(() => {
    const first = setTimeout(() => void refreshStale(), 0);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void reloadLanes().then(() => refreshStale());
    }, SCHEDULE_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; the timer reads fresh state via reload
  }, []);

  const refreshOne = useCallback(
    async (id: string) => {
      setRefreshing((s) => new Set(s).add(id));
      try {
        await api(`/api/lanes/${id}/refresh`, { method: "POST", body: {} });
        await reloadLanes();
      } catch (err) {
        report(err);
      } finally {
        setRefreshing((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [reloadLanes, report],
  );

  const refreshAll = async () => {
    for (const lane of lanes) await refreshOne(lane.id);
  };

  const actions: LaneActions = {
    refresh: refreshOne,
    rename: async (id, name) => {
      setLanes((ls) => ls.map((l) => (l.id === id ? { ...l, name } : l)));
      await api(`/api/lanes/${id}`, { method: "PATCH", body: { name } }).catch(report);
    },
    recolor: async (id, color) => {
      setLanes((ls) => ls.map((l) => (l.id === id ? { ...l, color } : l)));
      await api(`/api/lanes/${id}`, { method: "PATCH", body: { color } }).catch(report);
    },
    move: async (id, delta) => {
      const i = lanes.findIndex((l) => l.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= lanes.length) return;
      const next = [...lanes];
      [next[i], next[j]] = [next[j]!, next[i]!];
      setLanes(next);
      await api("/api/lanes/reorder", { body: { ids: next.map((l) => l.id) } }).catch(report);
    },
    remove: async (id) => {
      setLanes((ls) => ls.filter((l) => l.id !== id));
      await api(`/api/lanes/${id}`, { method: "DELETE" }).catch(report);
    },
    play: (video, lane) => setPlaying({ video, laneId: lane.id, accent: lane.color }),
  };

  const runSearch = async (q: string, laneId: string, corrected: boolean, autoRouted: boolean) => {
    setSearch({ phase: "searching", query: q, laneId, autoRouted });
    try {
      const res = await api<{ items: Card[]; cached: boolean }>("/api/search", { body: { query: q, laneId, corrected } });
      setSearch({ phase: "results", query: q, laneId, items: res.items, cached: res.cached, autoRouted });
    } catch (err) {
      setSearch({ phase: "error", query: q, laneId, message: err instanceof Error ? err.message : "Search failed" });
    }
  };

  /** Routing happens only here, on Enter: nothing is sent while typing. */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (lanes.length === 0) {
      setSearch({ phase: "choose", query: q, decision: { kind: "ask", reason: "Create your first lane for this search.", alternates: [] } });
      return;
    }
    setSearch({ phase: "routing", query: q });
    let decision: RouteDecision;
    try {
      decision = (await api<{ decision: RouteDecision }>("/api/route", { body: { query: q } })).decision;
    } catch {
      decision = { kind: "ask", reason: "Routing is unavailable right now; pick a lane.", alternates: [] };
    }
    if (decision.kind === "assign" && decision.autoRouted) {
      await runSearch(q, decision.laneId, false, true);
    } else {
      setSearch({ phase: "choose", query: q, decision });
    }
  };

  const onPick = (laneId: string, corrected: boolean) => {
    if (search.phase === "idle") return;
    void runSearch(search.query, laneId, corrected, false);
  };

  const onCreate = async (lane: { name: string; description: string; color: string }) => {
    if (search.phase === "idle") return;
    const q = search.query;
    try {
      const { id } = await api<{ id: string }>("/api/lanes", { body: { ...lane, fromQuery: q } });
      await runSearch(q, id, false, false);
      await reloadLanes();
    } catch (err) {
      report(err);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
        <div className="mx-auto flex h-16 w-full max-w-[1800px] items-center gap-3 px-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight" aria-label="Rabbithole home">
            <Logo />
            <span className="hidden sm:inline">Rabbithole</span>
          </Link>
          <form role="search" onSubmit={submit} className="mx-auto flex w-full max-w-2xl items-center">
            <label htmlFor="search" className="sr-only">
              Search YouTube; press Enter to file it into a lane
            </label>
            <input
              id="search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              autoComplete="off"
              maxLength={200}
              className="h-10 w-full rounded-l-full border border-border bg-bg px-4 text-[15px] outline-none focus:border-[var(--focus)]"
            />
            <button type="submit" aria-label="Search" className="flex h-10 w-16 items-center justify-center rounded-r-full border border-l-0 border-border bg-subtle">
              <Search />
            </button>
          </form>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing.size > 0 || lanes.length === 0}
            aria-label="Refresh all lanes"
            className="rounded-full p-2 hover:bg-subtle disabled:opacity-40"
          >
            <Refresh className={refreshing.size > 0 ? "animate-spin motion-reduce:animate-none" : ""} />
          </button>
          <Link href="/settings" aria-label={`Settings${userName ? ` for ${userName}` : ""}`} className="rounded-full p-2 hover:bg-subtle">
            <Settings />
          </Link>
        </div>
      </header>

      {notice && (
        <div role="alert" className="mx-auto mt-3 flex w-full max-w-[1800px] items-center gap-3 px-4 text-sm">
          <p className="rounded-lg bg-subtle px-3 py-2">{notice}</p>
          <button type="button" className="text-muted underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <SearchPanel
        state={search}
        lanes={lanes}
        onPick={onPick}
        onCreate={onCreate}
        onClose={() => setSearch({ phase: "idle" })}
        onPlay={(video, laneId) => setPlaying({ video, laneId, accent: lanes.find((l) => l.id === laneId)?.color })}
      />

      <main className={`mx-auto w-full max-w-[1800px] pb-16 ${search.phase === "idle" ? "" : "hidden"}`}>
        {lanes.length === 0 ? (
          <FirstRun onDone={(next) => setLanes(next)} />
        ) : (
          lanes.map((lane, i) => <Lane key={lane.id} lane={lane} index={i} count={lanes.length} isRefreshing={refreshing.has(lane.id)} actions={actions} />)
        )}
      </main>

      {playing && <PlayerModal video={playing.video} laneId={playing.laneId} accent={playing.accent} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function FirstRun({ onDone }: { onDone: (lanes: LaneSummary[]) => void }) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");

  const setup = async () => {
    setState("working");
    try {
      const res = await api<{ lanes: LaneSummary[] }>("/api/setup", { body: {} });
      if (res.lanes.length === 0) {
        setState("error");
        setMessage("No subscriptions were found. Create a lane and search to fill it.");
      } else onDone(res.lanes);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Setup failed");
    }
  };

  return (
    <div className="mx-auto mt-12 max-w-xl px-4 text-center">
      <h1 className="text-2xl font-bold">Build your lanes</h1>
      <p className="mt-2 text-muted">
        Rabbithole reads your YouTube subscriptions (read-only), groups them into interests with Claude, and gives each interest its own lane. You can correct any channel afterwards.
      </p>
      <button
        type="button"
        onClick={() => void setup()}
        disabled={state === "working"}
        className="mt-6 rounded-full bg-fg px-5 py-2.5 font-medium text-bg disabled:opacity-50"
      >
        {state === "working" ? "Reading subscriptions and sorting channels…" : "Set up lanes from my subscriptions"}
      </button>
      {state === "error" && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {message}
        </p>
      )}
      <form
        className="mt-8 flex items-center justify-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await api("/api/lanes", { body: { name: name.trim() } });
            onDone((await api<{ lanes: LaneSummary[] }>("/api/lanes")).lanes);
          } catch (err) {
            setState("error");
            setMessage(err instanceof Error ? err.message : "Could not create the lane");
          }
        }}
      >
        <label htmlFor="first-lane" className="text-sm text-muted">
          Or start with one lane:
        </label>
        <input id="first-lane" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Espresso" className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm" />
        <button type="submit" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-subtle">
          Create
        </button>
      </form>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#e5484d" />
      <rect x="6" y="9" width="20" height="3" rx="1.5" fill="#fff" />
      <rect x="6" y="15" width="14" height="3" rx="1.5" fill="#fff" opacity="0.85" />
      <rect x="6" y="21" width="9" height="3" rx="1.5" fill="#fff" opacity="0.7" />
    </svg>
  );
}
