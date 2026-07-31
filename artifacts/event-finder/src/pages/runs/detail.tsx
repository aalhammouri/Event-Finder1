import { useParams, useLocation } from "wouter";
import { useGetCrawlRun, useStopCrawlRun, usePauseCrawlRun, useResumeCrawlRun, useGetAdminSettings, getGetCrawlRunQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { authFetch, sseUrl } from "@/lib/auth-fetch";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Globe, AlertTriangle, CheckCircle2, Loader2, StopCircle, PauseCircle, PlayCircle, Zap, ExternalLink,
  Sparkles, RotateCw, Ban, ChevronRight, ChevronDown, SkipForward, TrendingDown,
} from "lucide-react";
import { RunStatusBadge, TierBadge, ScorePill } from "@/components/ui/event-badges";
import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errors";

// ── Types ─────────────────────────────────────────────────────────────────────
type CrawledEvent = {
  eventPageUrl?: string;
  eventName?: string;
  eventDate?: string;
  eventVenue?: string;
  orgName?: string;
  hasSilentAuction?: boolean;
  hasLiveAuction?: boolean;
  contactEmail?: string;
  contactPhone?: string;
  score?: number;
  tier?: string;
  [k: string]: unknown;
};

type LogEntry = {
  ts: string;
  type: string;
  url?: string;
  msg: string;
  score?: number;
  durationMs?: number;
  errorType?: string;
  reason?: string;
  textLength?: number;
  eventData?: CrawledEvent;
};

type LiveStats = { pagesCrawled: number; eventsMatched: number; errorCount: number; done: number; total: number };

type ErrorAnalysis = {
  summary?: string;
  patterns?: { pattern: string; affectedCount?: number; suggestion?: string }[];
  configSuggestions?: { setting: string; currentValue?: string; suggestedValue?: string; reason?: string }[];
  siteIssues?: { domain: string; issue?: string; workaround?: string }[];
  possibleMissedEvents?: { url: string; likelyReason?: string }[];
  overallHealthScore?: number;
};

// ── Log entry styling ─────────────────────────────────────────────────────────
function logIcon(type: string) {
  switch (type) {
    case "event_found": return <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />;
    case "error":       return <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />;
    case "skipped":     return <SkipForward className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />;
    case "url_done":    return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />;
    case "complete":    return <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />;
    case "url_start":   return <Globe className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />;
    default:            return <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0 mt-1.5 ml-1" />;
  }
}

function logRowClass(type: string) {
  switch (type) {
    case "event_found": return "bg-amber-50/60 border-l-2 border-amber-400";
    case "error":       return "bg-red-50/60 border-l-2 border-red-400";
    case "skipped":     return "bg-gray-100/70 border-l-2 border-gray-300";
    case "url_done":    return "border-l-2 border-green-400";
    case "complete":    return "bg-green-50/60 border-l-2 border-green-500 font-medium";
    case "url_start":   return "border-l-2 border-blue-400";
    default:            return "border-l-2 border-transparent";
  }
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return ts; }
}

function fmtDuration(ms?: number) {
  if (ms == null) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Activity Log Panel ────────────────────────────────────────────────────────
function ActivityLog({ entries, isLive }: { entries: LogEntry[]; isLive: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm gap-2">
        {isLive ? <><Loader2 className="w-5 h-5 animate-spin" /> Waiting for crawl activity…</> : "No log entries recorded."}
      </div>
    );
  }

  return (
    <div className="relative">
      {isLive && (
        <div className="flex items-center gap-1.5 text-xs text-green-600 font-medium mb-2">
          <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Live — streaming activity
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        tabIndex={-1}
        className="h-[560px] overflow-y-auto rounded-lg bg-muted/20 font-mono text-xs space-y-0.5 p-1 outline-none focus:outline-none [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {entries.map((entry, i) => {
          const dur = fmtDuration(entry.durationMs);
          return (
            <div key={i} className={cn("flex gap-2 items-start px-2 py-1 rounded-sm", logRowClass(entry.type))}>
              {logIcon(entry.type)}
              <span className="text-muted-foreground shrink-0 tabular-nums">{fmtTime(entry.ts)}</span>
              <span className={cn("break-all flex-1", entry.type === "error" ? "text-red-700" : entry.type === "skipped" ? "text-gray-500" : entry.type === "event_found" ? "text-amber-800 font-medium" : "text-foreground/80")}>
                {entry.msg}
                {entry.score !== undefined && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold not-italic">score {entry.score}</span>
                )}
              </span>
              {dur && (
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] tabular-nums">{dur}</span>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && isLive && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
          className="absolute bottom-3 right-3 text-xs bg-primary text-primary-foreground px-2 py-1 rounded shadow"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}

// ── Live Event Card ───────────────────────────────────────────────────────────
function LiveEventCard({ event, tiers }: { event: CrawledEvent; tiers?: any }) {
  const meta = [event.orgName, event.eventDate, event.eventVenue].filter(Boolean).join(" · ");
  return (
    <div className="border rounded-lg p-3 bg-card shadow-sm animate-in slide-in-from-top-2 fade-in duration-300">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <ScorePill score={event.score ?? 0} tiers={tiers} />
        <TierBadge tier={event.tier ?? "Tier C"} tiers={tiers} />
        {event.hasSilentAuction && <Badge variant="outline" className="text-xs">Silent Auction</Badge>}
        {event.hasLiveAuction && <Badge variant="outline" className="text-xs">Live Auction</Badge>}
      </div>
      <p className="font-semibold text-sm truncate">{event.eventName || "Unnamed"}</p>
      {meta && <p className="text-xs text-muted-foreground truncate">{meta}</p>}
      {(event.contactEmail || event.contactPhone) && (
        <p className="text-xs text-muted-foreground mt-1 truncate">
          {event.contactEmail}{event.contactEmail && event.contactPhone ? " · " : ""}{event.contactPhone}
        </p>
      )}
      {event.eventPageUrl && (
        <a href={event.eventPageUrl} target="_blank" rel="noopener noreferrer"
           className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1">
          Open page <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}

// ── Error Summary Panel ───────────────────────────────────────────────────────
function ErrorSummary({ entries, runId }: { entries: LogEntry[]; runId: number }) {
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [analysis, setAnalysis] = useState<ErrorAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);

  const errors = entries.filter((e) => e.type === "error");
  const skipped = entries.filter((e) => e.type === "skipped");

  const grouped = new Map<string, LogEntry[]>();
  for (const e of [...errors, ...skipped]) {
    const key = e.errorType || e.reason || e.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  const failedUrls = Array.from(
    new Set([...errors, ...skipped].map((e) => e.url).filter((u): u is string => !!u))
  );

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await authFetch(`/api/crawl-runs/${runId}/analyze-errors`, { method: "POST" });
      if (!res.ok) {
        setAnalyzeError(res.status === 503 ? "AI is not configured." : "Analysis failed. Try again.");
        return;
      }
      setAnalysis(await res.json());
    } catch {
      setAnalyzeError("Analysis failed. Try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  const coerce = (v?: string): unknown => {
    if (v == null) return v;
    const t = v.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) return n;
    if (t.includes(",")) return t.split(",").map((s) => s.trim()).filter(Boolean);
    return v;
  };

  const applyConfig = async (setting: string, suggestedValue?: string) => {
    const key = `cfg:${setting}`;
    try {
      const res = await authFetch(`/api/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [setting]: coerce(suggestedValue) }),
      });
      if (res.ok) setApplied((p) => new Set(p).add(key));
    } catch { /* ignore — button stays actionable */ }
  };

  const blacklist = async (domain: string) => {
    const key = `bl:${domain}`;
    try {
      const res = await authFetch(`/api/admin/domain-blacklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (res.ok) setApplied((p) => new Set(p).add(key));
    } catch { /* ignore */ }
  };

  const retryFailed = async () => {
    if (failedUrls.length === 0) return;
    setRetrying(true);
    try {
      const res = await authFetch(`/api/crawl-runs/${runId}/retry-urls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: failedUrls }),
      });
      if (res.ok) {
        const newRun = await res.json();
        if (newRun?.id) setLocation(`/runs/${newRun.id}`);
      }
    } catch { /* ignore */ } finally {
      setRetrying(false);
    }
  };

  if (errors.length === 0 && skipped.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm flex flex-col items-center gap-2">
        <CheckCircle2 className="w-6 h-6 text-green-500" />
        No errors or skipped pages.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Counts */}
      <div className="flex items-center gap-2 flex-wrap">
        {Array.from(grouped.entries()).map(([key, list]) => (
          <Badge key={key} variant="outline" className="text-xs font-medium">
            {key}: {list.length}
          </Badge>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="default" onClick={runAnalysis} disabled={analyzing} className="gap-1.5">
          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Analyze Errors with AI
        </Button>
        {failedUrls.length > 0 && (
          <Button size="sm" variant="outline" onClick={retryFailed} disabled={retrying} className="gap-1.5">
            {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
            Re-crawl {failedUrls.length} failed
          </Button>
        )}
      </div>
      {analyzeError && <p className="text-xs text-red-600">{analyzeError}</p>}

      {/* Expandable per-type URL lists */}
      <div className="space-y-1">
        {Array.from(grouped.entries()).map(([key, list]) => {
          const open = expanded.has(key);
          return (
            <div key={key} className="border rounded-md">
              <button
                onClick={() => toggle(key)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/40"
              >
                <span className="flex items-center gap-1.5">
                  {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span className="font-medium">{key}</span>
                  <span className="text-muted-foreground">({list.length})</span>
                </span>
              </button>
              {open && (
                <ul className="px-3 pb-2 space-y-1 max-h-48 overflow-y-auto">
                  {list.map((e, i) => (
                    <li key={i} className="text-xs text-muted-foreground break-all flex items-start gap-1.5">
                      <span className="text-muted-foreground/50 shrink-0">·</span>
                      <span>{e.url || e.msg}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* AI analysis result */}
      {analysis && (
        <div className="border rounded-lg p-3 bg-muted/20 space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="font-semibold">AI Diagnosis</span>
            {typeof analysis.overallHealthScore === "number" && (
              <Badge variant="outline" className="text-xs ml-auto">Health {analysis.overallHealthScore}/100</Badge>
            )}
          </div>
          {analysis.summary && <p className="text-muted-foreground">{analysis.summary}</p>}

          {analysis.patterns && analysis.patterns.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Patterns</p>
              {analysis.patterns.map((p, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">{p.pattern}</span>
                  {p.affectedCount != null && <span className="text-muted-foreground"> ({p.affectedCount})</span>}
                  {p.suggestion && <span className="text-muted-foreground"> — {p.suggestion}</span>}
                </div>
              ))}
            </div>
          )}

          {analysis.configSuggestions && analysis.configSuggestions.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Config suggestions</p>
              {analysis.configSuggestions.map((c, i) => {
                const key = `cfg:${c.setting}`;
                return (
                  <div key={i} className="flex items-start justify-between gap-2 text-xs border rounded-md px-2 py-1.5">
                    <div className="min-w-0">
                      <span className="font-mono font-medium">{c.setting}</span>
                      <span className="text-muted-foreground"> {c.currentValue} → {c.suggestedValue}</span>
                      {c.reason && <p className="text-muted-foreground">{c.reason}</p>}
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs shrink-0"
                      disabled={applied.has(key)} onClick={() => applyConfig(c.setting, c.suggestedValue)}>
                      {applied.has(key) ? "Applied" : "Apply"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {analysis.siteIssues && analysis.siteIssues.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Site issues</p>
              {analysis.siteIssues.map((s, i) => {
                const key = `bl:${s.domain}`;
                return (
                  <div key={i} className="flex items-start justify-between gap-2 text-xs border rounded-md px-2 py-1.5">
                    <div className="min-w-0">
                      <span className="font-mono font-medium">{s.domain}</span>
                      {s.issue && <p className="text-muted-foreground">{s.issue}</p>}
                      {s.workaround && <p className="text-muted-foreground italic">{s.workaround}</p>}
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs shrink-0 gap-1"
                      disabled={applied.has(key)} onClick={() => blacklist(s.domain)}>
                      <Ban className="w-3 h-3" />{applied.has(key) ? "Blacklisted" : "Blacklist"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {analysis.possibleMissedEvents && analysis.possibleMissedEvents.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Possibly missed events</p>
              {analysis.possibleMissedEvents.map((m, i) => (
                <div key={i} className="text-xs break-all">
                  <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{m.url}</a>
                  {m.likelyReason && <span className="text-muted-foreground"> — {m.likelyReason}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type AuditFunnel = {
  sitesAttempted: number;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesKeywordMatched: number;
  pagesSentToAi: number;
  eventsExtracted: number;
  eventsStored: number;
};
function StatCard({ label, value, sub, warn }: { label: string; value: number | string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-card border rounded-xl p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
      <p className={cn("text-3xl font-bold tabular-nums", warn && Number(value) > 0 ? "text-red-500" : "")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

// ── Token Usage Panel ─────────────────────────────────────────────────────────
type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TokenUsagePanel({ tokenUsage }: { tokenUsage: TokenUsage }) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = tokenUsage;
  const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
  const totalTokens = totalInput + outputTokens;
  const cacheHitPct = totalInput > 0
    ? Math.round((cacheReadTokens / totalInput) * 100)
    : 0;

  return (
    <div className="bg-card border rounded-xl p-4 shadow-sm">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-violet-500" /> AI Token Usage
        <span className="ml-auto text-xs font-normal text-muted-foreground">claude-opus-5</span>
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-muted/40 rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Total Tokens</p>
          <p className="text-xl font-bold tabular-nums">{fmtTokens(totalTokens)}</p>
        </div>
        <div className="bg-muted/40 rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Input (uncached)</p>
          <p className="text-xl font-bold tabular-nums">{fmtTokens(inputTokens)}</p>
        </div>
        <div className="bg-violet-50 border border-violet-100 rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-violet-600 uppercase tracking-wide mb-1">Cache Hits</p>
          <p className="text-xl font-bold tabular-nums text-violet-700">{fmtTokens(cacheReadTokens)}</p>
          <p className="text-[10px] text-violet-500">{cacheHitPct}% of input</p>
        </div>
        <div className="bg-muted/40 rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Output</p>
          <p className="text-xl font-bold tabular-nums">{fmtTokens(outputTokens)}</p>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function RunDetail() {
  const { id } = useParams();
  const runId = Number(id);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: settings } = useGetAdminSettings();
  const tiers = settings?.tiers;

  const { data: run, isLoading } = useGetCrawlRun(runId, {
    query: {
      enabled: !!runId,
      queryKey: getGetCrawlRunQueryKey(runId),
      refetchInterval: (q) => {
        const status = (q.state.data as any)?.status;
        return status === "running" || status === "pending" ? 3000 : false;
      },
    },
  });

  const isActive = run?.status === "running" || run?.status === "pending";
  const isPaused = run?.status === "paused";

  const stopMutation = useStopCrawlRun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCrawlRunQueryKey(runId) });
      },
      onError: (err) => {
        toast({ title: "Couldn't stop run", description: getErrorMessage(err), variant: "destructive" });
      },
    },
  });

  const pauseMutation = usePauseCrawlRun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCrawlRunQueryKey(runId) });
      },
      onError: (err) => {
        toast({ title: "Couldn't pause run", description: getErrorMessage(err), variant: "destructive" });
      },
    },
  });

  const resumeMutation = useResumeCrawlRun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCrawlRunQueryKey(runId) });
      },
      onError: (err) => {
        toast({ title: "Couldn't resume run", description: getErrorMessage(err), variant: "destructive" });
      },
    },
  });

  // Live stats from SSE
  const [liveLog, setLiveLog] = useState<LogEntry[]>([]);
  const [liveEvents, setLiveEvents] = useState<CrawledEvent[]>([]);
  const [liveStats, setLiveStats] = useState<LiveStats>({ pagesCrawled: 0, eventsMatched: 0, errorCount: 0, done: 0, total: 0 });
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [sseConnected, setSseConnected] = useState(false);

  // Stored log for completed runs
  const [storedLog, setStoredLog] = useState<LogEntry[]>([]);
  const [logLoaded, setLogLoaded] = useState(false);
  // Fallback events for completed runs whose stored log predates inline eventData
  const [fallbackEvents, setFallbackEvents] = useState<CrawledEvent[]>([]);

  const addEvent = useCallback((ev?: CrawledEvent) => {
    if (!ev) return;
    setLiveEvents((prev) => {
      const k = `${ev.eventPageUrl ?? ""}::${ev.eventName ?? ""}`;
      if (prev.some((p) => `${p.eventPageUrl ?? ""}::${p.eventName ?? ""}` === k)) return prev;
      return [...prev, ev];
    });
  }, []);

  // Reset all run-local state when navigating between runs (e.g. after a
  // retry-urls re-crawl) — the route param changes without remounting.
  useEffect(() => {
    setLiveLog([]);
    setLiveEvents([]);
    setLiveStats({ pagesCrawled: 0, eventsMatched: 0, errorCount: 0, done: 0, total: 0 });
    setCurrentUrl("");
    setSseConnected(false);
    setStoredLog([]);
    setLogLoaded(false);
    setFallbackEvents([]);
  }, [runId]);

  // Connect SSE when run is active
  useEffect(() => {
    if (!runId || !isActive) return;

    const es = new EventSource(sseUrl(`/api/crawl-runs/${runId}/progress`));
    setSseConnected(true);

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as any;

      // Bulk replay of historical log entries (preserves original ts + msg)
      if (ev.type === "log_replay") {
        if (Array.isArray(ev.entries)) {
          const entries = ev.entries as LogEntry[];
          setLiveLog((prev) => [...prev, ...entries]);
          for (const en of entries) if (en.type === "event_found" && en.eventData) addEvent(en.eventData);

          const doneCount = entries.filter((e) => e.type === "url_done").length;
          const lastStart = [...entries].reverse().find((e) => e.type === "url_start");
          if (doneCount > 0) {
            setLiveStats((p) => ({ ...p, done: Math.max(p.done, doneCount) }));
          }
          if (lastStart?.url) {
            setCurrentUrl(lastStart.url);
          }
        }
        return;
      }

      // Build log entry from live events
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        type: ev.type,
        url: ev.url ?? ev.pageUrl,
        msg: "",
        score: ev.score,
        durationMs: ev.durationMs,
        errorType: ev.errorType,
        reason: ev.reason,
        textLength: ev.textLength,
        eventData: ev.eventData,
      };
      switch (ev.type) {
        case "url_start":
          entry.msg = ev.url ? `Starting crawl of ${ev.url}` : "Crawl run started";
          if (ev.url) setCurrentUrl(ev.url);
          break;
        case "page_crawled":
          entry.msg = `Crawled: ${ev.pageUrl ?? ""}${ev.textLength != null ? ` (${ev.textLength} chars)` : ""}`;
          setLiveStats((p) => ({ ...p, pagesCrawled: p.pagesCrawled + 1, done: ev.progress?.done ?? p.done, total: ev.progress?.total ?? p.total }));
          break;
        case "event_found":
          entry.msg = `Found event: "${ev.eventName ?? "Unknown"}"`;
          setLiveStats((p) => ({ ...p, eventsMatched: p.eventsMatched + 1 }));
          addEvent(ev.eventData);
          break;
        case "skipped":
          entry.msg = `Skipped: ${ev.pageUrl ?? ev.url ?? ""} (${ev.reason ?? "unknown"})`;
          break;
        case "error":
          entry.msg = `Error on ${ev.url ?? ev.pageUrl ?? "unknown"}: ${ev.errorMessage ?? ""}`;
          setLiveStats((p) => ({ ...p, errorCount: p.errorCount + 1 }));
          break;
        case "url_done":
          entry.msg = `Finished: ${ev.url}`;
          setLiveStats((p) => ({ ...p, done: ev.progress?.done ?? p.done, total: ev.progress?.total ?? p.total }));
          setCurrentUrl("");
          break;
        case "complete":
          entry.msg = "Crawl run complete";
          qc.invalidateQueries({ queryKey: getGetCrawlRunQueryKey(runId) });
          es.close();
          setSseConnected(false);
          break;
        default:
          entry.msg = JSON.stringify(ev);
      }
      setLiveLog((prev) => [...prev, entry]);
    };

    es.onerror = () => {
      setSseConnected(false);
      es.close();
    };

    return () => { es.close(); setSseConnected(false); };
  }, [runId, isActive, addEvent]);

  // Load stored log for completed/failed runs
  useEffect(() => {
    if (!runId || isActive || logLoaded) return;
    authFetch(`/api/crawl-runs/${runId}/logs`)
      .then((r) => r.json())
      .then((data) => { setStoredLog(Array.isArray(data) ? data : []); setLogLoaded(true); });
  }, [runId, isActive, logLoaded]);

  // Fallback: completed run whose stored log has no inline eventData → fetch events
  useEffect(() => {
    if (!runId || isActive || !logLoaded) return;
    const hasInline = storedLog.some((e) => e.type === "event_found" && e.eventData);
    if (hasInline) return;
    authFetch(`/api/crawl-runs/${runId}/events`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setFallbackEvents(Array.isArray(data) ? data : []));
  }, [runId, isActive, logLoaded, storedLog]);

  // Sync initial live stats from run data
  useEffect(() => {
    if (run && isActive) {
      setLiveStats((p) => ({
        ...p,
        pagesCrawled: Math.max(p.pagesCrawled, run.pagesCrawled ?? 0),
        eventsMatched: Math.max(p.eventsMatched, run.eventsMatched ?? 0),
        errorCount: Math.max(p.errorCount, run.errorCount ?? 0),
        total: run.totalUrls ?? 0,
      }));
    }
  }, [run]);

  if (isLoading) return <div className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading run…</div>;
  if (!run) return <div className="p-8 text-muted-foreground">Run not found.</div>;

  const displayPages = isActive ? liveStats.pagesCrawled : (run.pagesCrawled ?? 0);
  const displayEvents = isActive ? liveStats.eventsMatched : (run.eventsMatched ?? 0);
  const displayErrors = isActive ? liveStats.errorCount : (run.errorCount ?? 0);
  const progressTotal = run.totalUrls ?? liveStats.total;
  const progressDone = isActive ? liveStats.done : progressTotal;
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  const duration = run.completedAt && run.createdAt
    ? Math.round((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000)
    : null;

  const displayLog = isActive ? liveLog : storedLog;

  // Speed: average seconds per crawled page from durationMs
  const durations = displayLog
    .filter((e) => e.type === "page_crawled" && typeof e.durationMs === "number")
    .map((e) => e.durationMs as number);
  const avgSpeed = durations.length > 0
    ? (durations.reduce((a, b) => a + b, 0) / durations.length / 1000)
    : null;

  // Event cards: live SSE events while active; for completed runs prefer inline
  // log eventData, falling back to the fetched events list.
  const storedInlineEvents = storedLog
    .filter((e) => e.type === "event_found" && e.eventData)
    .map((e) => e.eventData as CrawledEvent);
  const cardSource = isActive
    ? liveEvents
    : (storedInlineEvents.length > 0 ? storedInlineEvents : fallbackEvents);
  const eventCards = [...cardSource].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/runs")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold truncate">{run.urlListName}</h1>
          <p className="text-sm text-muted-foreground">
            {run.triggeredBy === "scheduled" ? "Scheduled" : "Manual"} run · Started {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
        {isActive && (
          <Button
            variant="outline"
            size="sm"
            disabled={pauseMutation.isPending}
            className="flex items-center gap-1.5"
            onClick={() => pauseMutation.mutate({ id: runId })}
          >
            <PauseCircle className="w-4 h-4" />
            Pause
          </Button>
        )}
        {isPaused && (
          <Button
            variant="default"
            size="sm"
            disabled={resumeMutation.isPending}
            className="flex items-center gap-1.5"
            onClick={() => resumeMutation.mutate({ id: runId })}
          >
            <PlayCircle className="w-4 h-4" />
            Resume
          </Button>
        )}
        {isActive && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={stopMutation.isPending}
                className="flex items-center gap-1.5"
              >
                <StopCircle className="w-4 h-4" />
                Stop
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                <AlertDialogDescription>
                  The crawl will finish its current URL, then stop. All results collected so far will be saved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => stopMutation.mutate({ id: runId })}
                >
                  Stop run
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Progress bar — shown when active */}
      {isActive && (
        <div className="bg-card border rounded-xl p-4 shadow-sm space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              {currentUrl ? (
                <span className="text-muted-foreground truncate max-w-[500px]">Crawling: <span className="text-foreground font-mono text-xs">{currentUrl}</span></span>
              ) : "Starting up…"}
            </span>
            <span className="text-muted-foreground tabular-nums">{progressDone} / {progressTotal} sites</span>
          </div>
          <Progress value={progressPct} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">{progressPct}% complete</p>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Pages Crawled" value={displayPages} />
        <StatCard label="Events Found" value={displayEvents} />
        <StatCard label="Errors" value={displayErrors} warn />
        <StatCard
          label="Duration"
          value={duration !== null ? `${duration}s` : "—"}
          sub={duration !== null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : undefined}
        />
        <StatCard
          label="Speed"
          value={avgSpeed !== null ? `${avgSpeed.toFixed(1)}s` : "—"}
          sub={avgSpeed !== null ? "avg / page" : undefined}
        />
      </div>

      {/* AI Token Usage */}
      {run.tokenUsage && (
        <TokenUsagePanel tokenUsage={run.tokenUsage} />
      )}

      {/* Run Funnel — shown for finished runs only */}
      {!isActive && !isPaused && (
        <div className="bg-card border rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <TrendingDown className="w-4 h-4 text-muted-foreground" /> Run Funnel
          </h2>
          <RunFunnel runId={runId} />
        </div>
      )}

      {/* 3-panel layout: Activity Log (40%) | Live Events + Error Summary (60%) */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        {/* Activity Log */}
        <div className="md:col-span-2 bg-card border rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Globe className="w-4 h-4 text-muted-foreground" /> Activity Log
            {isActive && liveLog.length > 0 && (
              <span className="ml-auto px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold tabular-nums">{liveLog.length}</span>
            )}
          </h2>
          <ActivityLog entries={displayLog} isLive={isActive && sseConnected} />
        </div>

        {/* Right column: live events + error summary */}
        <div className="md:col-span-3 space-y-6">
          <div className="bg-card border rounded-xl p-4 shadow-sm">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-500" /> Events Found
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-bold tabular-nums">{eventCards.length}</span>
            </h2>
            {eventCards.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">
                {isActive ? "Events will appear here as they are found…" : "No events found in this run."}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-[520px] overflow-y-auto pr-1">
                {eventCards.map((ev, i) => (
                  <LiveEventCard key={`${ev.eventPageUrl ?? ""}-${i}`} event={ev} tiers={tiers} />
                ))}
              </div>
            )}
          </div>

          <div className="bg-card border rounded-xl p-4 shadow-sm">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-red-500" /> Error Summary
            </h2>
            <ErrorSummary entries={displayLog} runId={runId} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RunFunnel({ runId }: { runId: number }) {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`/api/crawl-runs/${runId}/audit`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setAudit(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading funnel…
      </div>
    );
  }
  if (!audit) return null;

  const { funnel, dropOffs, warnings } = audit;

  const stages: { label: string; key: keyof AuditFunnel; dropLabel?: string }[] = [
    { label: "Sites", key: "sitesAttempted" },
    { label: "Pages discovered", key: "pagesDiscovered" },
    { label: "Pages crawled", key: "pagesCrawled" },
    { label: "Keyword matched", key: "pagesKeywordMatched" },
    { label: "Sent to AI", key: "pagesSentToAi" },
    { label: "Events extracted", key: "eventsExtracted" },
    { label: "Stored", key: "eventsStored" },
  ];

  const maxVal = Math.max(...stages.map((s) => funnel[s.key] ?? 0), 1);

  // Find biggest non-zero drop-off reason for labeling
  const biggestDrop = Object.entries(dropOffs)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="space-y-3">
      {/* Funnel bars */}
      <div className="space-y-1.5">
        {stages.map((stage, i) => {
          const val = funnel[stage.key] ?? 0;
          const prev = i > 0 ? (funnel[stages[i - 1].key] ?? 0) : val;
          const drop = prev - val;
          const pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
          return (
            <div key={stage.key}>
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className="text-muted-foreground font-medium">{stage.label}</span>
                <span className="tabular-nums font-semibold">{val.toLocaleString()}</span>
              </div>
              <div className="h-5 bg-muted/40 rounded overflow-hidden relative">
                <div
                  className="h-full bg-primary/70 rounded transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
                {i > 0 && drop > 0 && (
                  <span className="absolute right-1 top-0.5 text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <TrendingDown className="w-2.5 h-2.5" />−{drop.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Top drop-off summary */}
      {biggestDrop && (
        <div className="text-xs text-muted-foreground border-t pt-2">
          <span className="font-medium">Top drop-off:</span>{" "}
          <span className="font-mono">{biggestDrop[0]}</span> ({biggestDrop[1].toLocaleString()} pages)
        </div>
      )}

      {/* Skip reason breakdown */}
      {Object.keys(dropOffs).length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {Object.entries(dropOffs)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => (
              <span
                key={reason}
                className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono"
              >
                {reason}: {count}
              </span>
            ))}
        </div>
      )}

      {/* Warnings from the log */}
      {warnings.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

type AuditResult = {
  funnel: AuditFunnel;
  dropOffs: Record<string, number>;
  config: {
    aiConfigured: boolean;
    firecrawlConfigured: boolean;
    avoidKeywords: string[];
    geographicStates: string[];
    minEventScore: number;
    imageReadingEnabled: boolean;
  };
  warnings: string[];
};
