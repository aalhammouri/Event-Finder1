import {
  useGetCrawlRuns,
  useUpdateCrawlRun,
  useDeleteCrawlRun,
  useRerunCrawlRun,
  useGetAdminSettings,
  getGetCrawlRunsQueryKey,
  CrawlRun,
  CrawlRunStatus,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RunStatusBadge } from "@/components/ui/event-badges";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft, Calendar, Clock, Download, Loader2,
  MoreHorizontal, Archive, ArchiveX, Trash2, RefreshCw, Eye, Activity,
  ChevronDown, ChevronRight, CheckCircle, AlertTriangle, AlertCircle,
} from "lucide-react";
import { authFetch } from "@/lib/auth-fetch";
import { useAuth } from "@/context/AuthContext";
import { EventsTable, fmtDate } from "@/components/events/event-table";
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

// ── Coverage Dashboard ─────────────────────────────────────────────────────────
interface SiteCoverageRow {
  id: number;
  siteUrl: string;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesMissed: number;
  isComplete: boolean;
  missedUrls: string[];
  crawlErrors: Array<{ url: string; error: string }>;
}

function CoverageDashboard({ runId, run }: { runId: number; run: any }) {
  const [expanded, setExpanded] = useState(false);
  const [siteData, setSiteData] = useState<SiteCoverageRow[] | null>(null);
  const [loadingCoverage, setLoadingCoverage] = useState(false);
  const [expandedSite, setExpandedSite] = useState<number | null>(null);

  useEffect(() => {
    if (!expanded || siteData !== null) return;
    setLoadingCoverage(true);
    authFetch(`/api/crawl-runs/${runId}/coverage`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setSiteData(data))
      .catch(() => setSiteData([]))
      .finally(() => setLoadingCoverage(false));
  }, [runId, expanded, siteData]);

  const totalDiscovered: number = (run as any).pagesDiscovered ?? 0;
  const totalMissed: number = (run as any).pagesMissed ?? 0;
  const totalKeywordMatched: number = (run as any).pagesKeywordMatched ?? 0;
  const totalSentToAi: number = (run as any).pagesSentToAi ?? 0;
  const totalFallback: number = (run as any).fallbackPages ?? 0;
  const sitesComplete: number = (run as any).sitesComplete ?? 0;
  const sitesIncomplete: number = (run as any).sitesIncomplete ?? 0;
  const skippedByGeography: number = (run as any).skippedByGeography ?? 0;
  const totalSites = sitesComplete + sitesIncomplete;

  if (totalSites === 0 && totalDiscovered === 0) return null;

  return (
    <div className="bg-card rounded-md border shadow-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2.5">
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className="font-semibold text-sm">Coverage Report</span>
          {sitesIncomplete > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
              <AlertTriangle className="w-3 h-3" />
              {sitesIncomplete} site{sitesIncomplete !== 1 ? "s" : ""} incomplete
            </span>
          )}
          {sitesIncomplete === 0 && totalSites > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-800">
              <CheckCircle className="w-3 h-3" />
              All sites complete
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? "Collapse" : "Expand"}</span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t space-y-5 pt-4">
          {/* Aggregate stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <CovStat label="Sites" value={totalSites} />
            <CovStat label="Complete" value={sitesComplete} color="green" />
            <CovStat label="Incomplete" value={sitesIncomplete} color={sitesIncomplete > 0 ? "amber" : undefined} />
            <CovStat label="Discovered" value={totalDiscovered} />
            <CovStat label="Missed" value={totalMissed} color={totalMissed > 0 ? "amber" : undefined} />
            <CovStat label="Keyword match" value={totalKeywordMatched} color="blue" />
            <CovStat label="Sent to AI" value={totalSentToAi} />
          </div>
          {totalFallback > 0 && (
            <p className="text-xs text-muted-foreground">
              {totalFallback} page{totalFallback !== 1 ? "s" : ""} fetched via fallback (no Firecrawl).
            </p>
          )}
          {skippedByGeography > 0 && (
            <p className="text-xs text-muted-foreground">
              {skippedByGeography} event{skippedByGeography !== 1 ? "s" : ""} skipped — outside configured geographic scope.
            </p>
          )}

          {/* Per-site table */}
          {loadingCoverage ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading site detail…
            </div>
          ) : siteData && siteData.length > 0 ? (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs whitespace-nowrap bg-muted/40">
                    <TableHead>Site</TableHead>
                    <TableHead className="w-24 text-center">Discovered</TableHead>
                    <TableHead className="w-20 text-center">Crawled</TableHead>
                    <TableHead className="w-20 text-center">Missed</TableHead>
                    <TableHead className="w-24 text-center">Status</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {siteData.map((site) => {
                    const isOpen = expandedSite === site.id;
                    const hasMissed = site.missedUrls.length > 0;
                    const hasErrors = site.crawlErrors.length > 0;
                    return (
                      <>
                        <TableRow
                          key={site.id}
                          className={`text-sm cursor-pointer hover:bg-muted/30 transition-colors ${!site.isComplete ? "bg-amber-50/40" : ""}`}
                          onClick={() => setExpandedSite(isOpen ? null : site.id)}
                        >
                          <TableCell className="font-mono text-xs truncate max-w-[260px]" title={site.siteUrl}>
                            {site.siteUrl}
                          </TableCell>
                          <TableCell className="text-center tabular-nums">{site.pagesDiscovered}</TableCell>
                          <TableCell className="text-center tabular-nums">{site.pagesCrawled}</TableCell>
                          <TableCell className="text-center tabular-nums">
                            {site.pagesMissed > 0
                              ? <span className="text-amber-700 font-medium">{site.pagesMissed}</span>
                              : <span className="text-muted-foreground">0</span>
                            }
                          </TableCell>
                          <TableCell className="text-center">
                            {site.isComplete
                              ? <span className="inline-flex items-center gap-1 text-[11px] text-green-700"><CheckCircle className="w-3 h-3" /> Complete</span>
                              : <span className="inline-flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle className="w-3 h-3" /> Incomplete</span>
                            }
                          </TableCell>
                          <TableCell>
                            {(hasMissed || hasErrors) && (
                              isOpen
                                ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                                : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                          </TableCell>
                        </TableRow>

                        {isOpen && (hasMissed || hasErrors) && (
                          <TableRow key={`${site.id}-detail`} className="bg-muted/20">
                            <TableCell colSpan={6} className="py-3 px-4">
                              {hasMissed && (
                                <div className="mb-3">
                                  <p className="text-xs font-semibold text-amber-800 mb-1.5">
                                    Missed pages ({site.missedUrls.length}):
                                  </p>
                                  <ul className="space-y-0.5">
                                    {site.missedUrls.slice(0, 20).map((u) => (
                                      <li key={u} className="text-xs font-mono text-muted-foreground truncate">
                                        <a href={u} target="_blank" rel="noreferrer" className="hover:text-blue-600 hover:underline">
                                          {u}
                                        </a>
                                      </li>
                                    ))}
                                    {site.missedUrls.length > 20 && (
                                      <li className="text-xs text-muted-foreground italic">
                                        …and {site.missedUrls.length - 20} more
                                      </li>
                                    )}
                                  </ul>
                                </div>
                              )}
                              {hasErrors && (
                                <div>
                                  <p className="text-xs font-semibold text-red-700 mb-1.5 flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3" /> Crawl errors ({site.crawlErrors.length}):
                                  </p>
                                  <ul className="space-y-1">
                                    {site.crawlErrors.slice(0, 10).map((e, idx) => (
                                      <li key={idx} className="text-xs text-muted-foreground">
                                        <span className="font-mono truncate">{e.url}</span>
                                        {e.error && <span className="ml-2 text-red-600">— {e.error}</span>}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : siteData && siteData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No per-site coverage data available (run may pre-date this feature).</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CovStat({ label, value, color }: { label: string; value: number; color?: "green" | "amber" | "blue" }) {
  const valueClass =
    color === "green" ? "text-green-700 font-bold" :
    color === "amber" ? "text-amber-700 font-bold" :
    color === "blue" ? "text-[#214292] font-bold" :
    "font-bold";
  return (
    <div className="flex flex-col items-center justify-center bg-muted/30 rounded-md px-3 py-2.5 min-w-[60px]">
      <span className={`text-lg tabular-nums leading-none ${valueClass}`}>{value}</span>
      <span className="text-[10px] text-muted-foreground mt-1 leading-none text-center uppercase tracking-wide">{label}</span>
    </div>
  );
}

// ── Run Events Table ──────────────────────────────────────────────────────────
function RunEventsTable({ runId }: { runId: number }) {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [includePast, setIncludePast] = useState(false);
  const { data: settings } = useGetAdminSettings();
  const tiers = settings?.tiers;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(
      `/api/crawl-runs/${runId}/events${includePast ? "?includePast=true" : ""}`
    );
    if (res.ok) setEvents(await res.json());
    setLoading(false);
  }, [runId, includePast]);

  useEffect(() => { load(); }, [load]);

  const pastToggle = (
    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-input"
        checked={includePast}
        onChange={(e) => setIncludePast(e.target.checked)}
      />
      Include past events
    </label>
  );

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{pastToggle}</div>
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading events…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">{pastToggle}</div>
      {events.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No events found in this run.</div>
      ) : (
        <EventsTable events={events} tiers={tiers} variant="run" />
      )}
    </div>
  );
}

function runDisplayName(run: CrawlRun): string {
  try {
    const d = new Date(run.createdAt);
    const datePart = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const timePart = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `${run.urlListName} — ${datePart} ${timePart}`;
  } catch {
    return run.urlListName;
  }
}

// ── Stat Pill ─────────────────────────────────────────────────────────────────
function StatPill({ label, value, accent }: { label: string; value: number | null | undefined; accent?: "amber" | "primary" }) {
  const valueClass =
    accent === "amber" ? "text-amber-700 font-bold" :
    accent === "primary" ? "text-primary font-bold" :
    "font-bold";
  return (
    <div className="flex flex-col items-center justify-center px-4 py-2 min-w-[60px]">
      <span className={`text-base tabular-nums leading-none ${valueClass}`}>{value ?? 0}</span>
      <span className="text-[10px] text-muted-foreground mt-1 leading-none uppercase tracking-wide">{label}</span>
    </div>
  );
}

// ── Run Card ──────────────────────────────────────────────────────────────────
function RunCard({
  run,
  onView,
  onViewLive,
  onArchive,
  onDelete,
  onRerun,
}: {
  run: CrawlRun;
  onView: () => void;
  onViewLive: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRerun: () => void;
}) {
  const isActive = run.status === CrawlRunStatus.running || run.status === CrawlRunStatus.pending;
  const [showDelete, setShowDelete] = useState(false);

  return (
    <>
      <div className={`w-full bg-card border rounded-xl p-5 shadow-sm transition-all ${run.archived ? "opacity-50" : "hover:shadow-md hover:border-primary/30"}`}>
        <div className="flex items-start justify-between gap-4">
          <button className="min-w-0 flex-1 text-left" onClick={isActive ? onViewLive : onView}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-base truncate">{runDisplayName(run)}</span>
              <RunStatusBadge status={run.status} />
              {run.archived && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-muted text-muted-foreground">
                  <Archive className="w-3 h-3" /> Archived
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Started: {fmtDate(run.createdAt)}
              </span>
              {run.completedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {run.status === CrawlRunStatus.stopped ? "Stopped" : "Finished"}: {fmtDate(run.completedAt)}
                </span>
              )}
              {isActive && (
                <span className="flex items-center gap-1 text-blue-600 animate-pulse">
                  <Loader2 className="w-3 h-3 animate-spin" /> In progress — click to view live
                </span>
              )}
            </div>
          </button>

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-stretch divide-x divide-border border rounded-lg overflow-hidden bg-muted/40">
              <StatPill label="URLs" value={run.totalUrls} />
              <StatPill label="Pages" value={run.pagesCrawled} />
              <StatPill label="Events" value={run.eventsMatched} accent="amber" />
              {run.topScore != null && (
                <StatPill label="Top Score" value={run.topScore} accent="primary" />
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {isActive ? (
                  <DropdownMenuItem onClick={onViewLive}>
                    <Activity className="w-4 h-4 mr-2" /> View live run
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={onView}>
                    <Eye className="w-4 h-4 mr-2" /> View results
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onRerun}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Re-run
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onArchive}>
                  {run.archived
                    ? <><ArchiveX className="w-4 h-4 mr-2" /> Unarchive</>
                    : <><Archive className="w-4 h-4 mr-2" /> Archive</>
                  }
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setShowDelete(true)}
                  className="text-red-600 focus:text-red-600"
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete run
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the run and all its results. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => { setShowDelete(false); onDelete(); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function Results() {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { token } = useAuth();

  const { data: allRuns, isLoading } = useGetCrawlRuns(showArchived ? { includeArchived: true } as any : {});

  const archiveMutation = useUpdateCrawlRun({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCrawlRunsQueryKey() }) },
  });
  const deleteMutation = useDeleteCrawlRun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCrawlRunsQueryKey() });
        toast({ title: "Run deleted" });
      },
    },
  });
  const rerunMutation = useRerunCrawlRun({
    mutation: {
      onSuccess: (newRun) => {
        qc.invalidateQueries({ queryKey: getGetCrawlRunsQueryKey() });
        setLocation(`/runs/${newRun.id}`);
      },
    },
  });

  const runs = allRuns;
  const selectedRun = runs?.find((r) => r.id === selectedRunId);

  if (selectedRunId && selectedRun) {
    const isActive = selectedRun.status === CrawlRunStatus.running || selectedRun.status === CrawlRunStatus.pending;
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setSelectedRunId(null)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{selectedRun.urlListName}</h1>
            <p className="text-sm text-muted-foreground">
              {fmtDate(selectedRun.createdAt)}
              {selectedRun.completedAt ? ` — ${fmtDate(selectedRun.completedAt)}` : ""}
              {" · "}{selectedRun.eventsMatched} event{selectedRun.eventsMatched !== 1 ? "s" : ""} found
            </p>
          </div>
          <RunStatusBadge status={selectedRun.status} />
          {isActive ? (
            <Button variant="outline" onClick={() => setLocation(`/runs/${selectedRun.id}`)}>
              <Activity className="w-4 h-4 mr-2" /> View live run
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={!token}
                onClick={() => {
                  if (!token) return;
                  window.open(
                    `/api/events/export/crm?runId=${selectedRunId}&token=${encodeURIComponent(token)}`,
                    "_blank",
                  );
                }}
              >
                <Download className="w-4 h-4 mr-2" /> Export for CRM
              </Button>
              <Button
                variant="outline"
                disabled={!token}
                onClick={() => {
                  if (!token) return;
                  window.open(
                    `/api/events/export/crm/xlsx?runId=${selectedRunId}&token=${encodeURIComponent(token)}`,
                    "_blank",
                  );
                }}
              >
                <Download className="w-4 h-4 mr-2" /> Export Excel
              </Button>
              <Button
                variant="outline"
                disabled={!token}
                onClick={() => {
                  if (!token) return;
                  window.open(
                    `/api/events/export?runId=${selectedRunId}&token=${encodeURIComponent(token)}`,
                    "_blank",
                  );
                }}
              >
                <Download className="w-4 h-4 mr-2" /> Export CSV
              </Button>
            </div>
          )}
        </div>

        {isActive ? (
          <div className="text-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
            <p className="font-medium">This run is in progress.</p>
            <p className="text-sm mt-1">Results will appear here once the crawl completes.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Coverage dashboard — shown above event table */}
            <CoverageDashboard runId={selectedRunId} run={selectedRun} />

            <div className="bg-card rounded-md border shadow-sm">
              <RunEventsTable runId={selectedRunId} />
            </div>
          </div>
        )}
      </div>
    );
  }

  const activeRuns = runs?.filter((r) => r.status === CrawlRunStatus.running || r.status === CrawlRunStatus.pending) ?? [];
  const finishedRuns = runs?.filter((r) => r.status !== CrawlRunStatus.running && r.status !== CrawlRunStatus.pending) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Results</h1>
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors ${
            showArchived
              ? "bg-amber-50 border-amber-300 text-amber-800"
              : "bg-white border-gray-200 text-muted-foreground hover:border-gray-300"
          }`}
        >
          <Archive className="w-3.5 h-3.5" />
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading runs…
        </div>
      ) : (
        <>
          {activeRuns.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">In Progress</h2>
              {activeRuns.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  onView={() => setSelectedRunId(run.id)}
                  onViewLive={() => setLocation(`/runs/${run.id}`)}
                  onArchive={() => archiveMutation.mutate({ id: run.id, data: { archived: !run.archived } })}
                  onDelete={() => deleteMutation.mutate({ id: run.id })}
                  onRerun={() => rerunMutation.mutate({ id: run.id })}
                />
              ))}
            </div>
          )}

          {finishedRuns.length > 0 && (
            <div className="space-y-3">
              {activeRuns.length > 0 && (
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mt-2">Completed</h2>
              )}
              {finishedRuns.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  onView={() => setSelectedRunId(run.id)}
                  onViewLive={() => setLocation(`/runs/${run.id}`)}
                  onArchive={() => archiveMutation.mutate({ id: run.id, data: { archived: !run.archived } })}
                  onDelete={() => deleteMutation.mutate({ id: run.id })}
                  onRerun={() => rerunMutation.mutate({ id: run.id })}
                />
              ))}
            </div>
          )}

          {!runs?.length && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-lg font-medium mb-1">No runs yet</p>
              <p className="text-sm">Start a crawl from the Import Data page to see results here.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
