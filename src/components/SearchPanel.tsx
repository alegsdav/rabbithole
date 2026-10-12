"use client";

import { useState } from "react";

import { LANE_COLORS, MAX_LANES_SOFT, type LaneSummary, type RouteDecision, type VideoCard as Card } from "@/shared/types";
import { Close } from "./icons";
import { CardSkeleton, VideoCard } from "./VideoCard";

export type SearchState =
  | { phase: "idle" }
  | { phase: "routing"; query: string }
  | { phase: "choose"; query: string; decision: RouteDecision; creating?: boolean }
  | { phase: "searching"; query: string; laneId: string; autoRouted: boolean }
  | { phase: "results"; query: string; laneId: string; items: Card[]; cached: boolean; autoRouted: boolean }
  | { phase: "error"; query: string; laneId?: string; message: string };

type Props = {
  state: SearchState;
  lanes: LaneSummary[];
  onPick: (laneId: string, corrected: boolean) => void;
  onCreate: (lane: { name: string; description: string; color: string }) => Promise<void>;
  onClose: () => void;
  onPlay: (video: Card, laneId: string) => void;
};

function LaneChip({ lane }: { lane: Pick<LaneSummary, "name" | "color"> }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium" style={{ borderColor: lane.color }}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: lane.color }} aria-hidden="true" />
      {lane.name}
    </span>
  );
}

export function SearchPanel({ state, lanes, onPick, onCreate, onClose, onPlay }: Props) {
  if (state.phase === "idle") return null;
  const laneOf = (id: string) => lanes.find((l) => l.id === id);

  return (
    <section aria-live="polite" aria-label="Search" className="mx-auto w-full max-w-[1800px] px-4 pt-4">
      <div className="flex items-center gap-3">
        <h2 className="truncate text-lg font-semibold">“{state.query}”</h2>
        {state.phase === "routing" && <span className="text-sm text-muted">Routing…</span>}
        {(state.phase === "searching" || state.phase === "results") && laneOf(state.laneId) && <LaneChip lane={laneOf(state.laneId)!} />}
        {(state.phase === "searching" || state.phase === "results") && (
          <ChangeLane lanes={lanes} current={state.laneId} onPick={(id) => onPick(id, true)} />
        )}
        <button type="button" onClick={onClose} className="ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm hover:bg-subtle">
          <Close /> Close search
        </button>
      </div>

      {state.phase === "choose" && <Choose state={state} lanes={lanes} onPick={onPick} onCreate={onCreate} />}

      {state.phase === "error" && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {state.message}
        </p>
      )}

      {state.phase === "routing" || state.phase === "searching" ? (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-6" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : null}

      {state.phase === "results" && (
        <div className="mt-4 rounded-2xl border-t-4 pt-4" style={{ borderColor: laneOf(state.laneId)?.color }}>
          {state.items.length === 0 ? (
            <p className="text-sm text-muted">No results.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-6">
              {state.items.map((v) => (
                <VideoCard key={v.videoId} video={v} onPlay={(video) => onPlay(video, state.laneId)} />
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-muted">
            {state.cached ? "Saved results from the last 24 hours." : "Fresh results."} This search now also feeds the{" "}
            {laneOf(state.laneId)?.name ?? "selected"} lane.
          </p>
        </div>
      )}
    </section>
  );
}

function ChangeLane({ lanes, current, onPick }: { lanes: LaneSummary[]; current: string; onPick: (id: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="sr-only sm:not-sr-only">Change lane</span>
      <select
        value={current}
        onChange={(e) => onPick(e.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg"
      >
        {lanes.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Choose({
  state,
  lanes,
  onPick,
  onCreate,
}: {
  state: Extract<SearchState, { phase: "choose" }>;
  lanes: LaneSummary[];
  onPick: (laneId: string, corrected: boolean) => void;
  onCreate: Props["onCreate"];
}) {
  const d = state.decision;
  const proposal = d.kind === "create" ? d.newLane : null;
  const [showForm, setShowForm] = useState(!!proposal);
  const [name, setName] = useState(proposal?.name ?? titleCase(state.query));
  const [description, setDescription] = useState(proposal?.description ?? "");
  const [color, setColor] = useState(proposal?.color ?? LANE_COLORS[lanes.length % LANE_COLORS.length]);
  const [busy, setBusy] = useState(false);

  // Low confidence: the top two lanes; otherwise the router's alternates, or every lane when it couldn't decide.
  const ids = d.kind === "assign" ? [d.laneId, ...d.alternates].slice(0, 2) : d.alternates.length ? d.alternates : lanes.map((l) => l.id);
  const ranked = ids.map((id) => lanes.find((l) => l.id === id)).filter((l): l is LaneSummary => !!l);
  const options = ranked.length ? ranked : lanes;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {d.kind === "ask" && <p className="text-sm text-muted">{d.reason}</p>}
      {!showForm && (
        <div>
          <p className="mb-2 text-sm">Which lane should this search teach?</p>
          <div className="flex flex-wrap gap-2">
            {options.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onPick(l.id, d.kind !== "assign" || l.id !== d.laneId)}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-subtle"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} aria-hidden="true" />
                {l.name}
              </button>
            ))}
            <button type="button" onClick={() => setShowForm(true)} className="rounded-full border border-dashed border-border px-4 py-2 text-sm font-medium hover:bg-subtle">
              New lane
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          className="max-w-xl rounded-2xl border border-border bg-surface p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            try {
              await onCreate({ name: name.trim(), description: description.trim(), color });
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3 className="font-semibold">{proposal ? "This looks like a new interest" : "New lane"}</h3>
          <p className="mb-3 text-sm text-muted">Nothing is created until you confirm.</p>
          {lanes.length >= MAX_LANES_SOFT && (
            <p role="note" className="mb-3 text-sm text-danger">
              You already have {lanes.length} lanes. Consider filing this under an existing one so each lane stays meaningful.
            </p>
          )}
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Description <span className="text-xs text-muted">(helps route future searches)</span>
              <input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5" />
            </label>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="mb-1 text-sm">Color</legend>
              {LANE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={c === color}
                  onClick={() => setColor(c)}
                  className="h-8 w-8 rounded-full border-2 border-transparent aria-pressed:border-fg"
                  style={{ backgroundColor: c }}
                />
              ))}
            </fieldset>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="rounded-full bg-fg px-4 py-2 text-sm font-medium text-bg disabled:opacity-50">
              {busy ? "Creating…" : "Create lane and search"}
            </button>
            {lanes.length > 0 && (
              <button type="button" onClick={() => setShowForm(false)} className="rounded-full px-4 py-2 text-sm hover:bg-subtle">
                Use an existing lane
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
