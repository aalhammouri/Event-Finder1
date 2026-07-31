import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminSettings,
  useUpdateAdminSettings,
  getGetAdminSettingsQueryKey,
  useGetEmailRecipients,
  useCreateEmailRecipient,
  useUpdateEmailRecipient,
  useDeleteEmailRecipient,
  getGetEmailRecipientsQueryKey,
  useGetDomainBlacklist,
  useAddDomainBlacklist,
  useDeleteDomainBlacklist,
  getGetDomainBlacklistQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Search,
  Ban,
  Clock,
  SlidersHorizontal,
  Mail,
  Globe,
  Users,
  User,
  Trash2,
  Plus,
  Save,
  X,
  CheckCircle2,
  Shield,
  Eye,
  Copy,
  KeyRound,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "scraping", label: "Scraping Settings", icon: Search },
  { id: "scoring", label: "Scoring & Tiers", icon: SlidersHorizontal },
  { id: "blacklist", label: "Domain Blacklist", icon: Ban },
  { id: "email", label: "Email Notifications", icon: Mail },
  { id: "export", label: "Export & Geography", icon: Globe },
  { id: "users", label: "Users", icon: Users },
  { id: "account", label: "My Account", icon: User },
];


// ── Keyword chip list ─────────────────────────────────────────────────────────
function KeywordList({
  keywords,
  onAdd,
  onRemove,
  placeholder,
  colorClass = "bg-primary text-primary-foreground",
}: {
  keywords: string[];
  onAdd: (k: string) => void;
  onRemove: (k: string) => void;
  placeholder: string;
  colorClass?: string;
}) {
  const [input, setInput] = useState("");
  const submit = () => {
    const val = input.trim();
    if (!val || keywords.includes(val)) return;
    onAdd(val);
    setInput("");
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={placeholder}
          className="max-w-sm"
        />
        <Button onClick={submit} size="sm"><Plus className="w-4 h-4 mr-1" /> Add</Button>
      </div>
      <div className="flex flex-wrap gap-2 min-h-[32px]">
        {keywords.map((k) => (
          <span key={k} className={cn("px-3 py-1 rounded-full text-sm flex items-center gap-1.5 font-medium", colorClass)}>
            {k}
            <button onClick={() => onRemove(k)} className="opacity-70 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {keywords.length === 0 && <span className="text-muted-foreground text-sm italic">None added</span>}
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 pb-8 border-b last:border-0 last:pb-0">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      <div className="pt-3">{children}</div>
    </div>
  );
}

// ── Scraping Settings ─────────────────────────────────────────────────────────
function ScrapingSettings() {
  const { data: settings, isLoading } = useGetAdminSettings();
  const update = useUpdateAdminSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [maxPages, setMaxPages] = useState(30);
  const [timeout, setTimeoutVal] = useState(30);
  const [imageReading, setImageReading] = useState(true);
  const [concurrentSites, setConcurrentSites] = useState(5);
  const [domainDelay, setDomainDelay] = useState(1000);
  const [retries, setRetries] = useState(3);

  useEffect(() => {
    if (settings) {
      setMaxPages(settings.maxPagesPerSite ?? 30);
      setTimeoutVal(settings.timeoutPerPage ?? 30);
      setImageReading(settings.imageReadingEnabled ?? true);
      setConcurrentSites(settings.maxConcurrentSites ?? 5);
      setDomainDelay(settings.perDomainDelayMs ?? 1000);
      setRetries(settings.maxRetries ?? 3);
    }
  }, [settings]);

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  const save = (patch: object) => {
    update.mutate({ data: patch as any }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
        toast({ title: "Saved", description: "Settings updated." });
      },
    });
  };

  const addKeyword = (field: "searchKeywords" | "avoidKeywords" | "overrideKeywords", val: string) => {
    if (!settings) return;
    save({ [field]: [...settings[field], val] });
  };

  const removeKeyword = (field: "searchKeywords" | "avoidKeywords" | "overrideKeywords", val: string) => {
    if (!settings) return;
    save({ [field]: settings[field].filter((k: string) => k !== val) });
  };

  return (
    <div className="space-y-8">
      <Section title="Keywords to Look For" description="Pages containing these terms are flagged as potential events.">
        <KeywordList
          keywords={settings?.searchKeywords ?? []}
          onAdd={(k) => addKeyword("searchKeywords", k)}
          onRemove={(k) => removeKeyword("searchKeywords", k)}
          placeholder="e.g. silent auction"
          colorClass="bg-primary text-primary-foreground"
        />
      </Section>

      <Section title="Keywords to Avoid" description="Pages containing these terms are deprioritized or skipped.">
        <KeywordList
          keywords={settings?.avoidKeywords ?? []}
          onAdd={(k) => addKeyword("avoidKeywords", k)}
          onRemove={(k) => removeKeyword("avoidKeywords", k)}
          placeholder="e.g. bingo"
          colorClass="bg-destructive/10 text-destructive border border-destructive/20"
        />
      </Section>

      <Section title="Override Keywords" description="Pages with these terms are always included regardless of score.">
        <KeywordList
          keywords={settings?.overrideKeywords ?? []}
          onAdd={(k) => addKeyword("overrideKeywords", k)}
          onRemove={(k) => removeKeyword("overrideKeywords", k)}
          placeholder="e.g. silent auction"
          colorClass="bg-amber-100 text-amber-800 border border-amber-200"
        />
      </Section>

      <Section title="Crawler Limits" description="Control how deep the crawler goes per site.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-lg">
          <div className="space-y-2">
            <Label>Max pages per site</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                min={1}
                max={200}
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
                className="w-24"
              />
              <Button size="sm" variant="outline" onClick={() => save({ maxPagesPerSite: maxPages })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Timeout per page (seconds)</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                min={5}
                max={120}
                value={timeout}
                onChange={(e) => setTimeoutVal(Number(e.target.value))}
                className="w-24"
              />
              <Button size="sm" variant="outline" onClick={() => save({ timeoutPerPage: timeout })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Performance & Rate Limiting" description="How many sites are crawled in parallel, spacing between requests to the same site, and retries on transient failures.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl">
          <div className="space-y-2">
            <Label>Concurrent sites</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                min={1}
                max={50}
                value={concurrentSites}
                onChange={(e) => setConcurrentSites(Number(e.target.value))}
                className="w-24"
              />
              <Button size="sm" variant="outline" onClick={() => save({ maxConcurrentSites: concurrentSites })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Per-domain delay (ms)</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                min={0}
                max={60000}
                step={250}
                value={domainDelay}
                onChange={(e) => setDomainDelay(Number(e.target.value))}
                className="w-24"
              />
              <Button size="sm" variant="outline" onClick={() => save({ perDomainDelayMs: domainDelay })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Max retries per page</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                min={0}
                max={10}
                value={retries}
                onChange={(e) => setRetries(Number(e.target.value))}
                className="w-24"
              />
              <Button size="sm" variant="outline" onClick={() => save({ maxRetries: retries })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="AI Image Reading" description="Use AI vision to extract event info from flyer images and banners.">
        <div className="flex items-center gap-3">
          <Switch
            checked={imageReading}
            onCheckedChange={(v) => {
              setImageReading(v);
              save({ imageReadingEnabled: v });
            }}
          />
          <span className="text-sm text-muted-foreground">{imageReading ? "Enabled" : "Disabled"}</span>
        </div>
      </Section>
    </div>
  );
}

// ── Scoring & Tiers ───────────────────────────────────────────────────────────
const SCORING_DEFAULTS = {
  hasAuction: 30,
  auctionTypeBonus: 10,
  highTicketPrice: 30,
  midTicketPrice: 20,
  lowTicketPrice: 8,
  formalityBonus: 15,
  timingPrime: 25,
  timingGood: 10,
  timingPenalty: -20,
  beneficiaryBonus: 10,
};

const DEFAULT_MIN_SCORE = 45;

const DEFAULT_TIERS_UI = [
  { id: "tier-a", name: "Tier A", description: "High-priority events with strong auction and donor signals", minScore: 70 },
  { id: "tier-b", name: "Tier B", description: "Moderate-priority events worth tracking", minScore: 45 },
  { id: "tier-c", name: "Tier C", description: "Low-priority or uncertain events", minScore: 0 },
];

type WeightKey = keyof typeof SCORING_DEFAULTS;

interface TierDraft {
  id: string;
  name: string;
  description: string;
  minScore: number;
}

const WEIGHT_FACTORS: Array<{ key: WeightKey; label: string; description: string }> = [
  { key: "hasAuction",       label: "Has silent or live auction",                    description: "Core requirement — no auction means no table to place a gift certificate on." },
  { key: "auctionTypeBonus", label: "Auction type clearly named (silent or live)",   description: "Confirms the format, helping plan the right type of gift." },
  { key: "highTicketPrice",  label: "High-price event ($500+/ticket or $5k+/table)", description: "Indicates affluent donors with high donation potential." },
  { key: "midTicketPrice",   label: "Mid-price event ($250+/ticket or $2.5k+/table)",description: "Still a strong indicator of donor capacity." },
  { key: "lowTicketPrice",   label: "Entry-level event ($100+/ticket)",              description: "Worth tracking, but lower engagement likelihood." },
  { key: "formalityBonus",   label: "Formal event (black-tie or gala)",              description: "Formal events typically attract higher-value donors." },
  { key: "timingPrime",      label: "Prime timing window (6–12 weeks out)",          description: "Enough lead time to make contact and prepare a gift." },
  { key: "timingGood",       label: "Good timing (2–6 or 12–17 weeks out)",          description: "Workable window, but not quite ideal." },
  { key: "timingPenalty",    label: "Too soon or already past (<2 weeks or past)",   description: "Not enough time to act, or the opportunity has passed." },
  { key: "beneficiaryBonus", label: "Recognized nonprofit beneficiary",              description: "Hospitals, universities, museums — indicates a serious fundraiser." },
];

const BENEFICIARY_KEYWORDS = ["hospital", "foundation", "museum", "symphony", "opera", "ballet", "university", "college"];

const SAMPLE_EVENT = {
  hasSilentAuction: true,
  auctionType: "silent",
  ticketPrice: 300,
  tablePrice: null as number | null,
  formality: "gala",
  orgName: "Children's Hospital Foundation",
  weeksOut: 8,
};

function computePreview(w: typeof SCORING_DEFAULTS, tiers: TierDraft[]) {
  let score = 0;
  if (SAMPLE_EVENT.hasSilentAuction) score += w.hasAuction;
  const at = SAMPLE_EVENT.auctionType?.toLowerCase() || "";
  if (at === "silent" || at === "live") score += w.auctionTypeBonus;
  const ticket = SAMPLE_EVENT.ticketPrice ?? 0;
  const table = SAMPLE_EVENT.tablePrice ?? 0;
  if (ticket >= 500 || table >= 5000) score += w.highTicketPrice;
  else if (ticket >= 250 || table >= 2500) score += w.midTicketPrice;
  else if (ticket >= 100) score += w.lowTicketPrice;
  if (SAMPLE_EVENT.formality === "gala" || SAMPLE_EVENT.formality === "black-tie") score += w.formalityBonus;
  score += w.timingPrime;
  const orgLower = SAMPLE_EVENT.orgName.toLowerCase();
  if (BENEFICIARY_KEYWORDS.some((k) => orgLower.includes(k))) score += w.beneficiaryBonus;
  score = Math.min(100, Math.max(0, score));
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  let tierName = sorted.length > 0 ? sorted[sorted.length - 1].name : "—";
  for (const t of sorted) {
    if (score >= t.minScore) { tierName = t.name; break; }
  }
  const rank = sorted.findIndex((t) => t.name === tierName);
  return { score, tierName, rank };
}

const PREVIEW_RANK_STYLE: Record<number, string> = {
  0: "text-amber-700 bg-amber-50 border-amber-300",
  1: "text-blue-700 bg-blue-50 border-blue-300",
  2: "text-gray-600 bg-gray-50 border-gray-300",
};

function tierPreviewStyle(rank: number) {
  return PREVIEW_RANK_STYLE[rank] ?? "text-gray-600 bg-gray-50 border-gray-300";
}

function ScoringSettings() {
  const { data: settings, isLoading } = useGetAdminSettings();
  const update = useUpdateAdminSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [weights, setWeights] = useState<typeof SCORING_DEFAULTS>({ ...SCORING_DEFAULTS });
  const [tiers, setTiers] = useState<TierDraft[]>(DEFAULT_TIERS_UI);
  const [minScore, setMinScore] = useState(DEFAULT_MIN_SCORE);
  const [minEventScore, setMinEventScore] = useState(1);

  useEffect(() => {
    if (settings) {
      const sw = settings.scoringWeights as any ?? {};
      setWeights({
        hasAuction:       sw.hasAuction       ?? SCORING_DEFAULTS.hasAuction,
        auctionTypeBonus: sw.auctionTypeBonus ?? SCORING_DEFAULTS.auctionTypeBonus,
        highTicketPrice:  sw.highTicketPrice  ?? SCORING_DEFAULTS.highTicketPrice,
        midTicketPrice:   sw.midTicketPrice   ?? SCORING_DEFAULTS.midTicketPrice,
        lowTicketPrice:   sw.lowTicketPrice   ?? SCORING_DEFAULTS.lowTicketPrice,
        formalityBonus:   sw.formalityBonus   ?? SCORING_DEFAULTS.formalityBonus,
        timingPrime:      sw.timingPrime      ?? SCORING_DEFAULTS.timingPrime,
        timingGood:       sw.timingGood       ?? SCORING_DEFAULTS.timingGood,
        timingPenalty:    sw.timingPenalty    ?? SCORING_DEFAULTS.timingPenalty,
        beneficiaryBonus: sw.beneficiaryBonus ?? SCORING_DEFAULTS.beneficiaryBonus,
      });
      const settingsTiers = settings.tiers as TierDraft[] | undefined;
      setTiers(settingsTiers && settingsTiers.length > 0 ? settingsTiers : DEFAULT_TIERS_UI);
      setMinScore(settings.minScoreForEmail ?? DEFAULT_MIN_SCORE);
      setMinEventScore((settings as any).minEventScore ?? 1);
    }
  }, [settings]);

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  const setWeight = (key: WeightKey, val: number) =>
    setWeights((prev) => ({ ...prev, [key]: val }));

  const updateTier = (id: string, field: keyof TierDraft, value: string | number) =>
    setTiers((prev) => prev.map((t) => t.id === id ? { ...t, [field]: value } : t));

  const addTier = () => {
    const newId = `tier-${Date.now()}`;
    setTiers((prev) => [...prev, { id: newId, name: "New Tier", description: "", minScore: 0 }]);
  };

  const deleteTier = (id: string) => {
    setTiers((prev) => prev.filter((t) => t.id !== id));
  };

  const resetToDefaults = () => {
    setWeights({ ...SCORING_DEFAULTS });
    setTiers(DEFAULT_TIERS_UI);
    setMinScore(DEFAULT_MIN_SCORE);
    setMinEventScore(1);
  };

  const save = () => {
    update.mutate({
      data: {
        scoringWeights: weights,
        tiers,
        minEventScore,
        minScoreForEmail: minScore,
      } as any,
    }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
        toast({ title: "Saved", description: "Scoring settings updated." });
      },
    });
  };

  const preview = computePreview(weights, tiers);
  const previewStyle = tierPreviewStyle(preview.rank);

  const sortedTiers = [...tiers].sort((a, b) => b.minScore - a.minScore);

  return (
    <div className="space-y-8">
      <div className="flex gap-8">

        {/* ── Left: factors + tiers ── */}
        <div className="flex-1 min-w-0 space-y-8">

          <Section title="Scoring Factors" description="Adjust how many points each factor adds (or subtracts) from an event's total score (0–100).">
            <div className="space-y-2">
              {WEIGHT_FACTORS.map(({ key, label, description }) => (
                <div key={key} className="flex items-start gap-4 p-3 rounded-lg border bg-background hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={-50}
                      max={100}
                      value={weights[key]}
                      onChange={(e) => setWeight(key, Number(e.target.value))}
                      className={cn(
                        "w-20 text-center font-mono text-sm",
                        weights[key] < 0 ? "text-red-600" : "text-green-700"
                      )}
                    />
                    <span className="text-xs text-muted-foreground">pts</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Tiers" description="Define scoring tiers by name, description, and minimum score. Events are assigned the highest-ranked tier whose minimum score they meet.">
            <div className="space-y-3">
              {sortedTiers.map((tier, idx) => (
                <div key={tier.id} className="rounded-lg border bg-background p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-xs font-bold px-2 py-0.5 rounded-full",
                        idx === 0 ? "bg-amber-100 text-amber-800" :
                        idx === 1 ? "bg-blue-100 text-blue-800" :
                        "bg-slate-100 text-slate-700"
                      )}>#{idx + 1}</span>
                      <span className="text-xs text-muted-foreground">
                        {idx === sortedTiers.length - 1
                          ? `Score < ${sortedTiers[idx - 1]?.minScore ?? tier.minScore}`
                          : `Score ≥ ${tier.minScore}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      disabled={tiers.length <= 1}
                      onClick={() => deleteTier(tier.id)}
                      title="Delete tier"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
                    <div className="space-y-2">
                      <Label className="text-xs">Tier Name</Label>
                      <Input
                        value={tier.name}
                        onChange={(e) => updateTier(tier.id, "name", e.target.value)}
                        placeholder="e.g. Premium"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Min Score</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={tier.minScore}
                        onChange={(e) => updateTier(tier.id, "minScore", Number(e.target.value))}
                        className="w-20 h-8 text-sm text-center font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Description</Label>
                    <Textarea
                      value={tier.description}
                      onChange={(e) => updateTier(tier.id, "description", e.target.value)}
                      placeholder="Describe what qualifies an event for this tier…"
                      className="text-sm resize-none min-h-[56px]"
                      rows={2}
                    />
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addTier} type="button">
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Tier
              </Button>
            </div>
          </Section>

          <Section title="Minimum Event Score" description="Events scoring below this threshold are silently discarded during a crawl and never appear in results. Set to 0 to keep all events regardless of score.">
            <div className="space-y-2">
              <Label>Minimum score to keep an event</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={minEventScore}
                onChange={(e) => setMinEventScore(Number(e.target.value))}
                className="w-24"
              />
              <p className="text-xs text-muted-foreground">
                Default: 1 — keeps any event that matched at least one scoring criterion.
              </p>
            </div>
          </Section>

          <Section title="Email Alert Threshold" description="Only send email digest for events scoring at or above this value.">
            <div className="space-y-2">
              <Label>Minimum score for email</Label>
              <Input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-24" />
            </div>
          </Section>
        </div>

        {/* ── Right: live preview ── */}
        <div className="w-64 shrink-0">
          <div className="sticky top-4 space-y-3">
            <div>
              <p className="text-sm font-semibold">Live Preview</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Sample: silent auction · gala · $300 ticket · 8 weeks out · nonprofit
              </p>
            </div>
            <div className={cn("border rounded-xl p-4 space-y-3 transition-colors", previewStyle)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm truncate">Sample Gala Event</span>
                <span className={cn("text-xs font-bold px-2 py-0.5 rounded border shrink-0", previewStyle)}>
                  {preview.tierName}
                </span>
              </div>
              <div className="text-xs space-y-0.5 opacity-80">
                <p>Children's Hospital Foundation</p>
                <p>Silent auction · Black-tie gala</p>
                <p>$300/ticket · 8 weeks out</p>
              </div>
              <div className="pt-1 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span>Score</span>
                  <span className="font-bold tabular-nums text-base">{preview.score}</span>
                </div>
                <div className="h-2 bg-white/50 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-current rounded-full transition-all duration-300"
                    style={{ width: `${preview.score}%` }}
                  />
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Edit any weight or tier to see the score update instantly.
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t">
        <Button onClick={save} disabled={update.isPending}>
          <Save className="w-4 h-4 mr-2" />
          {update.isPending ? "Saving…" : "Save Scoring Settings"}
        </Button>
        <Button variant="outline" onClick={resetToDefaults} type="button">
          Reset to Defaults
        </Button>
      </div>
    </div>
  );
}

// ── Domain Blacklist ──────────────────────────────────────────────────────────
function BlacklistSettings() {
  const { data: blacklist, isLoading } = useGetDomainBlacklist();
  const addDomain = useAddDomainBlacklist();
  const deleteDomain = useDeleteDomainBlacklist();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [input, setInput] = useState("");

  const handleAdd = () => {
    const val = input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!val) return;
    addDomain.mutate({ data: { domain: val } }, {
      onSuccess: () => {
        setInput("");
        qc.invalidateQueries({ queryKey: getGetDomainBlacklistQueryKey() });
        toast({ title: "Domain blocked" });
      },
    });
  };

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Domains on this list will be skipped entirely during crawls.</p>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="example.com"
          className="max-w-sm"
        />
        <Button onClick={handleAdd}><Plus className="w-4 h-4 mr-1" /> Block Domain</Button>
      </div>
      {(blacklist?.length ?? 0) > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {blacklist?.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.domain}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{new Date(row.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => deleteDomain.mutate({ id: row.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetDomainBlacklistQueryKey() }) })}>
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">No domains blocked</div>
      )}
    </div>
  );
}

// ── Email Notifications ───────────────────────────────────────────────────────
function EmailSettings() {
  const { data: emails, isLoading } = useGetEmailRecipients();
  const createEmail = useCreateEmailRecipient();
  const updateEmail = useUpdateEmailRecipient();
  const deleteEmail = useDeleteEmailRecipient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");

  const handleAdd = () => {
    if (!newEmail) return;
    createEmail.mutate({ data: { email: newEmail } }, {
      onSuccess: () => {
        setNewEmail("");
        qc.invalidateQueries({ queryKey: getGetEmailRecipientsQueryKey() });
        toast({ title: "Recipient added" });
      },
    });
  };

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">These addresses receive the weekly event digest email after each automated crawl.</p>
      <div className="flex gap-2">
        <Input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="name@company.com"
          className="max-w-sm"
        />
        <Button onClick={handleAdd}><Plus className="w-4 h-4 mr-1" /> Add</Button>
      </div>
      {(emails?.length ?? 0) > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emails?.map((email) => (
              <TableRow key={email.id}>
                <TableCell>{email.email}</TableCell>
                <TableCell>
                  <Switch
                    checked={email.active}
                    onCheckedChange={(checked) => {
                      updateEmail.mutate({ id: email.id, data: { active: checked } }, {
                        onSuccess: () => qc.invalidateQueries({ queryKey: getGetEmailRecipientsQueryKey() }),
                      });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => deleteEmail.mutate({ id: email.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetEmailRecipientsQueryKey() }) })}>
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">No recipients added</div>
      )}
    </div>
  );
}

// ── User Management ───────────────────────────────────────────────────────────
interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string;
  activatedAt: string | null;
  createdAt: string;
}

function ActivationBadge({ activatedAt }: { activatedAt: string | null }) {
  if (activatedAt) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
        <CheckCircle2 className="w-3 h-3" /> Activated
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
      <Clock className="w-3 h-3" /> Pending
    </span>
  );
}

interface ShareableLink {
  userEmail: string;
  url: string;
  kind: "invite" | "reset";
  emailSent: boolean;
  expiresAt?: string;
}

function ShareableLinkPanel({ link, onDismiss }: { link: ShareableLink; onDismiss: () => void }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      toast({ title: "Link copied", description: "Paste it in a chat or message to the user." });
    } catch {
      toast({ title: "Could not copy automatically", description: "Select the link text and copy it manually.", variant: "destructive" });
    }
  };
  return (
    <div className="border border-primary/30 bg-primary/5 rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {link.kind === "invite" ? "Activation link" : "Password reset link"} for {link.userEmail}
        </p>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={link.url} className="text-xs font-mono" onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" onClick={copy}>
          <Copy className="w-3.5 h-3.5 mr-1" /> Copy
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {link.emailSent
          ? "An email was also sent, but you can share this link directly to be safe."
          : "The email could not be delivered — share this link with the user directly (chat, text, etc.)."}
        {link.kind === "reset" && " This link expires in 1 hour and can be used once."}
        {link.kind === "invite" && " This link expires in 7 days."}
      </p>
    </div>
  );
}

function AIStatusBanner() {
  const [status, setStatus] = useState<{ configured: boolean; reachable: boolean; error: string | null } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    fetch("/api/admin/ai-status", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status || (status.configured && status.reachable)) return null;

  return (
    <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 rounded-lg p-3">
      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      <div className="text-sm text-amber-800">
        <p className="font-medium">
          {!status.configured ? "AI extraction is not configured" : "AI is configured but not reachable"}
        </p>
        <p className="text-xs mt-0.5">
          {!status.configured
            ? "Set ANTHROPIC_API_KEY in Replit Secrets and restart the server — crawl runs will be blocked until AI is ready."
            : `claude-opus-5 is unreachable: ${status.error ?? "unknown error"}`}
        </p>
      </div>
    </div>
  );
}

function EmailStatusBanner() {
  const [status, setStatus] = useState<{ deliverable: boolean; reason: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    fetch("/api/admin/email-status", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status || status.deliverable) return null;

  return (
    <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 rounded-lg p-3">
      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      <div className="text-sm text-amber-800">
        <p className="font-medium">Emails are not being delivered</p>
        <p className="text-xs mt-0.5">{status.reason}</p>
        <p className="text-xs mt-0.5">Until then, use the copy-link buttons below — they work without email.</p>
      </div>
    </div>
  );
}

function UserManagement() {
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "viewer" });
  const [busy, setBusy] = useState<number | null>(null);
  const [shareLink, setShareLink] = useState<ShareableLink | null>(null);

  const fetchUsers = async () => {
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/admin/users", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setUsers(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, []);

  const addUser = async () => {
    if (!form.name || !form.email) return;
    const token = localStorage.getItem("auth_token");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      const created = await res.json();
      setForm({ name: "", email: "", role: "viewer" });
      setShowForm(false);
      fetchUsers();
      if (created.activationUrl) {
        setShareLink({
          userEmail: created.email,
          url: created.activationUrl,
          kind: "invite",
          emailSent: !!created.emailSent,
        });
      }
      toast({
        title: "User invited",
        description: created.emailSent
          ? "An activation email has been sent."
          : "Email delivery failed — copy the activation link below and share it directly.",
      });
    } else {
      toast({ title: "Error", description: "Email may already exist.", variant: "destructive" });
    }
  };

  const removeUser = async (id: number) => {
    const token = localStorage.getItem("auth_token");
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast({ title: "Cannot remove user", description: body?.error ?? "Something went wrong.", variant: "destructive" });
      return;
    }
    fetchUsers();
    toast({ title: "User removed" });
  };

  const updateRole = async (id: number, role: string) => {
    const token = localStorage.getItem("auth_token");
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast({ title: "Cannot change role", description: body?.error ?? "Something went wrong.", variant: "destructive" });
    }
    fetchUsers();
  };

  const resendInvite = async (user: AdminUser) => {
    setBusy(user.id);
    const token = localStorage.getItem("auth_token");
    const res = await fetch(`/api/admin/users/${user.id}/resend-invite`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    setBusy(null);
    if (res.ok) {
      const body = await res.json();
      setShareLink({
        userEmail: user.email,
        url: body.activationUrl,
        kind: "invite",
        emailSent: !!body.emailSent,
      });
      toast({
        title: body.emailSent ? "Invitation resent" : "Activation link ready",
        description: body.emailSent
          ? "A new activation email has been sent — the link is also shown below."
          : "Email delivery failed — copy the link below and share it directly.",
      });
    } else {
      toast({ title: "Error", description: "Could not generate an invitation link.", variant: "destructive" });
    }
  };

  const createResetLink = async (user: AdminUser) => {
    setBusy(user.id);
    const token = localStorage.getItem("auth_token");
    const res = await fetch(`/api/admin/users/${user.id}/reset-link`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    setBusy(null);
    if (res.ok) {
      const body = await res.json();
      setShareLink({
        userEmail: user.email,
        url: body.resetUrl,
        kind: "reset",
        emailSent: false,
        expiresAt: body.expiresAt,
      });
      toast({ title: "Reset link ready", description: "Copy the link below and share it with the user." });
    } else {
      const body = await res.json().catch(() => null);
      toast({ title: "Error", description: body?.error ?? "Could not generate a reset link.", variant: "destructive" });
    }
  };

  if (loading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <AIStatusBanner />
      <EmailStatusBanner />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Manage who has access to this application.</p>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-1" /> Add User
        </Button>
      </div>

      {shareLink && <ShareableLinkPanel link={shareLink} onDismiss={() => setShareLink(null)} />}

      {showForm && (
        <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
          <h4 className="font-medium text-sm">Invite New User</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={addUser}>Invite User</Button>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {users.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  <ActivationBadge activatedAt={u.activatedAt} />
                </TableCell>
                <TableCell>
                  <Select value={u.role} onValueChange={(v) => updateRole(u.id, v)}>
                    <SelectTrigger className="w-28 h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">
                        <span className="flex items-center gap-1.5"><Shield className="w-3 h-3" /> Admin</span>
                      </SelectItem>
                      <SelectItem value="viewer">
                        <span className="flex items-center gap-1.5"><Eye className="w-3 h-3" /> Viewer</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {!u.activatedAt && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Get activation link (also tries email)"
                        disabled={busy === u.id}
                        onClick={() => resendInvite(u)}
                      >
                        <Mail className="w-3.5 h-3.5 text-primary" />
                      </Button>
                    )}
                    {u.activatedAt && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Get password reset link"
                        disabled={busy === u.id}
                        onClick={() => createResetLink(u)}
                      >
                        <KeyRound className="w-3.5 h-3.5 text-primary" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeUser(u.id)}>
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">No users added yet</div>
      )}
    </div>
  );
}

// ── My Account ────────────────────────────────────────────────────────────────
function MyAccount() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwLoading, setPwLoading] = useState(false);

  const changePassword = async () => {
    if (!pwForm.next || pwForm.next !== pwForm.confirm) {
      toast({ title: "Error", description: "Passwords don't match.", variant: "destructive" });
      return;
    }
    if (pwForm.next.length < 8) {
      toast({ title: "Error", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }
    setPwLoading(true);
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
      });
      if (res.ok) {
        setPwForm({ current: "", next: "", confirm: "" });
        toast({ title: "Password updated" });
      } else {
        const data = await res.json();
        toast({ title: "Error", description: data.error ?? "Failed to update password.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error.", variant: "destructive" });
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-lg">
      <Section title="Profile Information" description="Your account details.">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary text-lg font-bold">
              {user?.name?.charAt(0).toUpperCase() ?? "?"}
            </div>
            <div>
              <p className="font-medium">{user?.name}</p>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Role" description="Your access level in this application.">
        <div className="flex items-center gap-2">
          <Badge className="bg-primary text-primary-foreground gap-1.5">
            <Shield className="w-3 h-3" /> {user?.role === "admin" ? "Admin" : "Viewer"}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {user?.role === "admin" ? "Full access to all settings and data." : "Read-only access to event data."}
          </span>
        </div>
      </Section>

      <Section title="Change Password" description="Update your login password.">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Current Password</Label>
            <Input type="password" value={pwForm.current} onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>New Password</Label>
            <Input type="password" value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Confirm New Password</Label>
            <Input type="password" value={pwForm.confirm} onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })} />
          </div>
          <Button variant="outline" onClick={changePassword} disabled={pwLoading}>
            {pwLoading ? "Updating…" : "Update Password"}
          </Button>
        </div>
      </Section>
    </div>
  );
}

// ── Export & Geography Settings ───────────────────────────────────────────────
function ExportSettings() {
  const { data: settings, isLoading } = useGetAdminSettings();
  const update = useUpdateAdminSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [group1, setGroup1] = useState("");
  const [group3, setGroup3] = useState("");
  const [mailingState, setMailingState] = useState("");
  const [states, setStates] = useState("");

  useEffect(() => {
    if (settings) {
      setGroup1(settings.primaryGroup1Label ?? "");
      setGroup3(settings.primaryGroup3Label ?? "");
      setMailingState(settings.defaultMailingState ?? "");
      setStates((settings.geographicStates ?? []).join(", "));
    }
  }, [settings]);

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>;

  const save = (patch: object) => {
    update.mutate({ data: patch as any }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
        toast({ title: "Saved", description: "Settings updated." });
      },
    });
  };

  const parseStates = (raw: string): string[] =>
    Array.from(new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)));

  return (
    <div className="space-y-8">
      <Section title="CRM Export Labels" description="Values written into the ACT CRM import file for every exported contact.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
          <div className="space-y-2">
            <Label>Primary Group 1</Label>
            <div className="flex gap-2 items-center">
              <Input value={group1} onChange={(e) => setGroup1(e.target.value)} placeholder="e.g. 2026 Events" className="max-w-xs" />
              <Button size="sm" variant="outline" onClick={() => save({ primaryGroup1Label: group1 })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Primary Group 3</Label>
            <div className="flex gap-2 items-center">
              <Input value={group3} onChange={(e) => setGroup3(e.target.value)} placeholder="Optional" className="max-w-xs" />
              <Button size="sm" variant="outline" onClick={() => save({ primaryGroup3Label: group3 })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Default Mailing State</Label>
            <div className="flex gap-2 items-center">
              <Input
                value={mailingState}
                onChange={(e) => setMailingState(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="TX"
                maxLength={2}
                className="w-20"
              />
              <Button size="sm" variant="outline" onClick={() => save({ defaultMailingState: mailingState })}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Used when an event's state is unknown.</p>
          </div>
        </div>
      </Section>

      <Section title="Geographic Scope" description="Only keep events whose organization is located in these states. Leave blank to disable filtering.">
        <div className="space-y-2 max-w-lg">
          <Label>Allowed states (comma-separated)</Label>
          <div className="flex gap-2 items-center">
            <Input
              value={states}
              onChange={(e) => setStates(e.target.value)}
              placeholder="e.g. TX, OK, LA"
              className="max-w-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const parsed = parseStates(states);
                setStates(parsed.join(", "));
                save({ geographicStates: parsed });
              }}
            >
              <Save className="w-3.5 h-3.5 mr-1" /> Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            2-letter codes. Events with no detected state are always kept.
          </p>
        </div>
      </Section>
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────
const CONTENT: Record<string, React.ReactNode> = {
  scraping: <ScrapingSettings />,
  scoring: <ScoringSettings />,
  blacklist: <BlacklistSettings />,
  email: <EmailSettings />,
  export: <ExportSettings />,
  users: <UserManagement />,
  account: <MyAccount />,
};

export default function Admin() {
  const [active, setActive] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const section = params.get("section");
    return section && SECTIONS.some((s) => s.id === section) ? section : "scraping";
  });
  const current = SECTIONS.find((s) => s.id === active)!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your scraping, automation, and account preferences.</p>
      </div>

      <div className="flex gap-8">
        {/* Left nav */}
        <nav className="w-52 shrink-0 space-y-1">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-left transition-colors",
                active === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        {/* Right panel */}
        <div className="flex-1 min-w-0 bg-card border rounded-xl p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold">{current.label}</h2>
            <Separator className="mt-3" />
          </div>
          {CONTENT[active]}
        </div>
      </div>
    </div>
  );
}
