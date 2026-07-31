import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TierBadge, ScorePill } from "@/components/ui/event-badges";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ExternalLink, Loader2, Check, X } from "lucide-react";
import { authFetch } from "@/lib/auth-fetch";
import { ScoringTier } from "@workspace/api-client-react";
import { useState, useEffect, useRef } from "react";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function fmtEventDate(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  } catch {}
  return raw;
}

function AuctionBadge({ type }: { type: string | null | undefined }) {
  if (!type || type === "none") return <span className="text-muted-foreground text-xs">—</span>;
  const colors: Record<string, string> = {
    silent: "bg-purple-100 text-purple-800",
    live: "bg-orange-100 text-orange-800",
    both: "bg-indigo-100 text-indigo-800",
    online: "bg-cyan-100 text-cyan-800",
  };
  const label: Record<string, string> = {
    silent: "Silent",
    live: "Live",
    both: "Silent + Live",
    online: "Online",
  };
  const cls = colors[type.toLowerCase()] ?? "bg-gray-100 text-gray-700";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label[type.toLowerCase()] ?? type}</span>;
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const cfg: Record<string, { cls: string; label: string }> = {
    NEW: { cls: "bg-green-100 text-green-800", label: "New" },
    UPDATED: { cls: "bg-amber-100 text-amber-800", label: "Updated" },
    UNCHANGED: { cls: "bg-gray-100 text-gray-600", label: "Same" },
  };
  const { cls, label } = cfg[status] ?? { cls: "bg-gray-100 text-gray-600", label: status };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>;
}

function FlagDots({ hasOnlineAuction, hasRaffle, hasDonationRequest }: {
  hasOnlineAuction?: boolean | null;
  hasRaffle?: boolean | null;
  hasDonationRequest?: boolean | null;
}) {
  const flags = [
    { val: hasOnlineAuction, label: "Online auction" },
    { val: hasRaffle, label: "Raffle" },
    { val: hasDonationRequest, label: "Donation ask" },
  ].filter((f) => f.val === true);
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {flags.map((f) => (
        <span key={f.label} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
          {f.label}
        </span>
      ))}
    </div>
  );
}

// ── Score Breakdown Popover ───────────────────────────────────────────────────
interface BreakdownFactor {
  label: string;
  description: string;
  points: number;
  triggered: boolean;
}

interface ScoreBreakdownData {
  factors: BreakdownFactor[];
  total: number;
  tier: string;
  tiers?: ScoringTier[];
}

export function ScoreBreakdownPopover({ eventId, score, tiers }: { eventId: number; score: number; tiers?: ScoringTier[] }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ScoreBreakdownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const fetchBreakdown = async () => {
    if (data || loading) return;
    setLoading(true);
    setErrored(false);
    try {
      const res = await authFetch(`/api/events/${eventId}/score-breakdown`);
      if (res.ok) {
        setData(await res.json());
      } else {
        setErrored(true);
      }
    } catch {
      setErrored(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) fetchBreakdown(); }}>
      <PopoverTrigger asChild>
        <button
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
          title="Click to see score breakdown"
        >
          <ScorePill score={score} tiers={tiers} clickable />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="px-4 py-3 border-b">
          <p className="text-sm font-semibold">Score breakdown</p>
          <p className="text-xs text-muted-foreground mt-0.5">How this score was calculated</p>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {errored && !loading && (
          <div className="py-6 text-center text-sm text-muted-foreground">Failed to load breakdown.</div>
        )}

        {data && !loading && (
          <>
            <div className="divide-y">
              {data.factors.map((factor) => (
                <div
                  key={factor.label}
                  className={`flex items-start gap-3 px-4 py-2.5 ${factor.triggered ? "" : "opacity-50"}`}
                >
                  <div className={`mt-0.5 flex-shrink-0 rounded-full p-0.5 ${factor.triggered ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400"}`}>
                    {factor.triggered
                      ? <Check className="w-3 h-3" />
                      : <X className="w-3 h-3" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium leading-snug">{factor.label}</span>
                      <span className={`text-xs font-mono font-semibold flex-shrink-0 ${
                        factor.points > 0 ? "text-green-700" :
                        factor.points < 0 ? "text-red-600" :
                        "text-muted-foreground"
                      }`}>
                        {factor.points > 0 ? `+${factor.points}` : factor.points === 0 ? "0" : factor.points}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{factor.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t px-4 py-3 bg-muted/30">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground">Total score</span>
                  <div className="text-lg font-bold font-mono leading-none mt-0.5">{data.total}</div>
                </div>
                <div className="text-right">
                  <span className="text-xs text-muted-foreground">Tier</span>
                  <div className="mt-0.5">
                    <TierBadge tier={data.tier} tiers={tiers} />
                  </div>
                </div>
              </div>
              {(!Array.isArray(tiers) || tiers.length === 0) ? (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Tier A ≥ 70 &nbsp;·&nbsp; Tier B ≥ 45 &nbsp;·&nbsp; Tier C below
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-2 flex flex-wrap gap-x-2 gap-y-1">
                  {tiers.map((t, idx) => (
                    <span key={t.name}>
                      {t.name} ≥ {t.minScore}{idx < tiers.length - 1 ? " ·" : ""}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Rich Events Table ─────────────────────────────────────────────────────────
// Shared presentational table used by the per-run Results view and the
// Past Events page. `variant` controls which contextual columns appear:
//   - "run":  Status + Found-at columns (events scoped to a single run)
//   - "past": Source list/run column (events span many runs)
export function EventsTable({
  events,
  tiers,
  variant = "run",
}: {
  events: any[];
  tiers?: ScoringTier[];
  variant?: "run" | "past";
}) {
  const topScrollRef = useRef<HTMLDivElement>(null);
  const bottomScrollRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const el = bottomScrollRef.current;
    if (!el) return;
    const update = () => setContentWidth(el.scrollWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [events]);

  const syncFromTop = () => {
    const top = topScrollRef.current;
    const bottom = bottomScrollRef.current;
    if (top && bottom && bottom.scrollLeft !== top.scrollLeft) {
      bottom.scrollLeft = top.scrollLeft;
    }
  };
  const syncFromBottom = () => {
    const top = topScrollRef.current;
    const bottom = bottomScrollRef.current;
    if (top && bottom && top.scrollLeft !== bottom.scrollLeft) {
      top.scrollLeft = bottom.scrollLeft;
    }
  };

  const showStatus = variant === "run";
  const showFoundAt = variant === "run";
  const showSource = variant === "past";

  return (
    <div>
      <div
        ref={topScrollRef}
        onScroll={syncFromTop}
        className="overflow-x-auto"
        aria-hidden="true"
      >
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div ref={bottomScrollRef} onScroll={syncFromBottom} className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="whitespace-nowrap text-xs">
              <TableHead className="w-14">Score</TableHead>
              <TableHead className="w-16">Tier</TableHead>
              {showStatus && <TableHead className="w-20">Status</TableHead>}
              <TableHead className="min-w-[200px]">Event</TableHead>
              <TableHead className="w-28">Date</TableHead>
              <TableHead className="min-w-[120px]">Venue</TableHead>
              <TableHead className="w-32">Auction / Extras</TableHead>
              <TableHead className="w-20">Ticket</TableHead>
              <TableHead className="w-20">Table</TableHead>
              <TableHead className="min-w-[160px]">Organization</TableHead>
              <TableHead className="min-w-[160px]">Contact</TableHead>
              {showSource && <TableHead className="min-w-[140px]">Source list</TableHead>}
              {showFoundAt && <TableHead className="w-36">Found at</TableHead>}
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((evt) => (
              <TableRow key={evt.id} className="whitespace-nowrap align-top">
                <TableCell className="pt-3"><ScoreBreakdownPopover eventId={evt.id} score={evt.score} tiers={tiers} /></TableCell>
                <TableCell className="pt-3"><TierBadge tier={evt.tier} tiers={tiers} /></TableCell>
                {showStatus && <TableCell className="pt-3"><StatusBadge status={evt.status} /></TableCell>}
                <TableCell className="max-w-[220px] pt-2 pb-2">
                  <div className="font-medium leading-snug line-clamp-2 whitespace-normal" title={evt.eventName || ""}>
                    {evt.eventName || <span className="text-muted-foreground italic text-xs">Unnamed event</span>}
                  </div>
                  {evt.eventDescription && (
                    <div className="text-xs text-muted-foreground mt-1 whitespace-normal line-clamp-2 max-w-[200px]">
                      {evt.eventDescription}
                    </div>
                  )}
                </TableCell>
                <TableCell className="pt-3 text-sm">{fmtEventDate(evt.eventDate)}</TableCell>
                <TableCell className="pt-2 pb-2 max-w-[160px]">
                  <div className="text-sm whitespace-normal line-clamp-2">{evt.eventVenue || <span className="text-muted-foreground">—</span>}</div>
                  {evt.eventAddress && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{evt.eventAddress}</div>}
                </TableCell>
                <TableCell className="pt-2 pb-2">
                  <AuctionBadge type={evt.auctionType} />
                  <FlagDots
                    hasOnlineAuction={evt.hasOnlineAuction}
                    hasRaffle={evt.hasRaffle}
                    hasDonationRequest={evt.hasDonationRequest}
                  />
                </TableCell>
                <TableCell className="pt-3 text-sm">{evt.ticketPrice ? `$${Number(evt.ticketPrice).toLocaleString()}` : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="pt-3 text-sm">{evt.tablePrice ? `$${Number(evt.tablePrice).toLocaleString()}` : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="pt-2 pb-2 max-w-[180px]">
                  <div className="text-sm font-medium whitespace-normal line-clamp-2">{evt.orgName || <span className="text-muted-foreground">—</span>}</div>
                  {(evt.orgCity || evt.orgState || evt.orgZip) && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {[evt.orgCity, evt.orgState, evt.orgZip].filter(Boolean).join(", ")}
                    </div>
                  )}
                </TableCell>
                <TableCell className="pt-2 pb-2 max-w-[200px]">
                  {(evt.contactTitle || evt.contactFirstName || evt.contactLastName || evt.contactName) && (
                    <div className="text-sm font-medium">
                      {[evt.contactTitle, evt.contactFirstName, evt.contactLastName].filter(Boolean).join(" ") || evt.contactName}
                    </div>
                  )}
                  {evt.contactEmail && (
                    <a href={`mailto:${evt.contactEmail}`} className="text-xs text-blue-600 hover:underline block truncate">{evt.contactEmail}</a>
                  )}
                  {evt.contactPhone && <div className="text-xs text-muted-foreground mt-0.5">{evt.contactPhone}</div>}
                  {!evt.contactTitle && !evt.contactFirstName && !evt.contactLastName && !evt.contactName && !evt.contactEmail && !evt.contactPhone && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {showSource && (
                  <TableCell className="pt-2 pb-2 max-w-[160px]">
                    <div className="text-sm whitespace-normal line-clamp-2">
                      {evt.runName || <span className="text-muted-foreground">—</span>}
                    </div>
                  </TableCell>
                )}
                {showFoundAt && (
                  <TableCell className="pt-3 text-xs text-muted-foreground whitespace-nowrap">
                    {evt.createdAt ? fmtDate(evt.createdAt) : "—"}
                  </TableCell>
                )}
                <TableCell className="pt-3">
                  {evt.eventPageUrl ? (
                    <a href={evt.eventPageUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
