import { useGetDashboardSummary, useGetTopEvents, useGetTierBreakdown, useGetCrawlRuns, useStopCrawlRun, useGetAdminSettings, CrawlRunStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TierBadge, ScorePill, StatusBadge } from "@/components/ui/event-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Activity, List, Calendar, AlertCircle, Square, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const TIER_DOT_COLORS = ["bg-amber-500", "bg-blue-500", "bg-slate-400"];
const TIER_DOT_FALLBACK = "bg-gray-300";
const normalizeTier = (s: string) => s.replace(/^tier\s+/i, "").trim().toLowerCase();

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary();
  const { data: topEvents, isLoading: loadingTopEvents } = useGetTopEvents();
  const { data: tierBreakdown, isLoading: loadingTierBreakdown } = useGetTierBreakdown();
  const { data: runs } = useGetCrawlRuns({});
  const { data: settings } = useGetAdminSettings();
  const tiersRaw = settings?.tiers;
  const tiers = Array.isArray(tiersRaw) ? tiersRaw : undefined;
  const qc = useQueryClient();

  const tierCountByNorm = new Map<string, number>();
  (tierBreakdown ?? []).forEach((row) => {
    const key = normalizeTier(row.tier);
    tierCountByNorm.set(key, (tierCountByNorm.get(key) ?? 0) + row.count);
  });
  const sortedTiers = tiers ? [...tiers].sort((a, b) => b.minScore - a.minScore) : [];
  const tierRows =
    sortedTiers.length > 0
      ? sortedTiers.map((t, idx) => ({
          name: t.name,
          count: tierCountByNorm.get(normalizeTier(t.name)) ?? 0,
          color: TIER_DOT_COLORS[idx] ?? TIER_DOT_FALLBACK,
        }))
      : (tierBreakdown ?? []).map((row, idx) => ({
          name: row.tier,
          count: row.count,
          color: TIER_DOT_COLORS[idx] ?? TIER_DOT_FALLBACK,
        }));

  const activeRun = runs?.find(
    (r) => r.status === CrawlRunStatus.running || r.status === CrawlRunStatus.pending
  );

  const stopMutation = useStopCrawlRun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/crawl-runs"] });
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
      </div>

      {/* Active run banner */}
      {activeRun && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-blue-900 truncate">
                Run in progress — {activeRun.urlListName}
              </p>
              <p className="text-xs text-blue-700 mt-0.5">
                {activeRun.pagesCrawled} pages crawled · {activeRun.eventsMatched} events found
              </p>
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="shrink-0 gap-1.5">
                <Square className="w-3.5 h-3.5 fill-current" /> Stop Run
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                <AlertDialogDescription>
                  The crawler will finish its current page and stop. Events found so far will be saved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => stopMutation.mutate({ id: activeRun.id })}
                >
                  Stop Run
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {loadingSummary ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : summary ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Lists</CardTitle>
              <List className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalLists}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Runs</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalRuns}</div>
              <p className="text-xs text-muted-foreground">
                Last run: {summary.lastRunAt ? new Date(summary.lastRunAt).toLocaleDateString() : "Never"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Events Found</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalEvents}</div>
              <p className="text-xs text-muted-foreground">
                {summary.newEvents || 0} new, {summary.updatedEvents || 0} updated
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tier Breakdown</CardTitle>
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingTierBreakdown ? (
                <div className="space-y-2.5">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : tierRows.length > 0 ? (
                <div className="space-y-2.5">
                  {tierRows.map((row) => (
                    <div key={row.name} className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", row.color)} />
                        <span className="truncate text-sm text-muted-foreground">{row.name}</span>
                      </div>
                      <span
                        className={cn(
                          "text-lg font-bold tabular-nums",
                          row.count === 0 && "text-muted-foreground/60"
                        )}
                      >
                        {row.count}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No tiers configured</span>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 grid-cols-1">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Top Scoring Events</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingTopEvents ? (
              <Skeleton className="h-64 w-full" />
            ) : topEvents?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Score</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Event Name</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Venue</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topEvents.map(evt => (
                    <TableRow key={evt.id}>
                      <TableCell><ScorePill score={evt.score} tiers={tiers} /></TableCell>
                      <TableCell><TierBadge tier={evt.tier} tiers={tiers} /></TableCell>
                      <TableCell className="font-medium">{evt.eventName || 'Unnamed Event'}</TableCell>
                      <TableCell>{evt.eventDate || '-'}</TableCell>
                      <TableCell>{evt.eventVenue || '-'}</TableCell>
                      <TableCell><StatusBadge status={evt.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8 text-muted-foreground">No events found yet.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
