import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EventStatus, CrawlRunStatus, ScoringTier } from "@workspace/api-client-react";

const TIER_RANK_COLORS: Record<number, string> = {
  0: "bg-amber-500 text-amber-950 border-transparent hover:bg-amber-600",
  1: "bg-blue-500 text-white border-transparent hover:bg-blue-600",
  2: "bg-slate-300 text-slate-800 border-transparent hover:bg-slate-400",
};
const TIER_FALLBACK_COLOR = "bg-gray-200 text-gray-700 border-transparent hover:bg-gray-300";

function tierRankColor(tier: string, tiers?: ScoringTier[]): string {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    if (tier === "A" || tier === "Tier A") return TIER_RANK_COLORS[0];
    if (tier === "B" || tier === "Tier B") return TIER_RANK_COLORS[1];
    if (tier === "C" || tier === "Tier C") return TIER_RANK_COLORS[2];
    return TIER_FALLBACK_COLOR;
  }
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  const rank = sorted.findIndex((t) => t.name === tier);
  return TIER_RANK_COLORS[rank] ?? TIER_FALLBACK_COLOR;
}

export function TierBadge({ tier, tiers }: { tier: string; tiers?: ScoringTier[] }) {
  return (
    <Badge className={tierRankColor(tier, tiers)}>{tier}</Badge>
  );
}

export function StatusBadge({ status }: { status: EventStatus }) {
  const styles = {
    [EventStatus.NEW]: "bg-green-100 text-green-800 border-green-200",
    [EventStatus.UPDATED]: "bg-amber-100 text-amber-800 border-amber-200",
    [EventStatus.UNCHANGED]: "bg-slate-100 text-slate-800 border-slate-200",
  };
  return <Badge variant="outline" className={styles[status]}>{status}</Badge>;
}

export function ScorePill({ score, tiers, clickable }: { score: number; tiers?: ScoringTier[]; clickable?: boolean }) {
  let color = "bg-red-100 text-red-800";
  if (Array.isArray(tiers) && tiers.length > 0) {
    const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
    if (score >= sorted[0].minScore) color = "bg-green-100 text-green-800";
    else if (sorted.length > 1 && score >= sorted[1].minScore) color = "bg-amber-100 text-amber-800";
  } else {
    if (score >= 70) color = "bg-green-100 text-green-800";
    else if (score >= 45) color = "bg-amber-100 text-amber-800";
  }

  return (
    <span className={cn(
      "px-2 py-1 rounded-full text-xs font-semibold whitespace-nowrap font-mono",
      color,
      clickable && "cursor-pointer underline decoration-dotted underline-offset-2",
    )}>
      {score}
    </span>
  );
}

export function RunStatusBadge({ status }: { status: CrawlRunStatus }) {
  const styles: Record<CrawlRunStatus, string> = {
    [CrawlRunStatus.pending]: "bg-slate-100 text-slate-800",
    [CrawlRunStatus.running]: "bg-blue-100 text-blue-800 animate-pulse",
    [CrawlRunStatus.completed]: "bg-green-100 text-green-800",
    [CrawlRunStatus.failed]: "bg-red-100 text-red-800",
    [CrawlRunStatus.stopped]: "bg-orange-100 text-orange-800",
    [CrawlRunStatus.paused]: "bg-purple-100 text-purple-800",
  };
  return <Badge variant="outline" className={styles[status]}>{status.toUpperCase()}</Badge>;
}
