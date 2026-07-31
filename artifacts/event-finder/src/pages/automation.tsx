import { useState, useEffect } from "react";
import {
  useGetAdminSettings,
  useUpdateAdminSettings,
  useGetUrlLists,
  getGetAdminSettingsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Save, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Frequency = "daily" | "weekly" | "monthly" | "custom";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1); // 1–28 (safe for all months)

const TIMEZONES = [
  { value: "America/Chicago", label: "Central Time (CT)" },
  { value: "America/New_York", label: "Eastern Time (ET)" },
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
];

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 pb-8 border-b last:border-0 last:pb-0">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      <div className="pt-3">{children}</div>
    </div>
  );
}

function frequencyFromDays(days: string[]): Frequency {
  if (days.length === 7) return "daily";
  if (days.length === 1) return "weekly";
  return "custom";
}

export default function AutomationPage() {
  const { data: settings, isLoading } = useGetAdminSettings();
  const { data: lists } = useGetUrlLists();
  const update = useUpdateAdminSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [days, setDays] = useState<string[]>(["Monday"]);
  const [monthDay, setMonthDay] = useState<number>(1);
  const [time, setTime] = useState("06:00");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [urlListId, setUrlListId] = useState<string>("all");

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setEnabled(s.scheduleEnabled ?? false);
    const savedDays: string[] = s.scheduleDays ?? ["Monday"];
    setDays(savedDays);
    setMonthDay(s.scheduleMonthDay ?? 1);
    setTime(s.scheduleTime ?? "06:00");
    setTimezone(s.scheduleTimezone ?? "America/Chicago");
    const savedListId = s.scheduleUrlListId;
    setUrlListId(savedListId ? String(savedListId) : "all");

    // Infer frequency from stored state
    if (s.scheduleFrequency) {
      setFrequency(s.scheduleFrequency);
    } else {
      setFrequency(frequencyFromDays(savedDays));
    }
  }, [settings]);

  const toggleDay = (day: string) => {
    setDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  };

  const handleFrequencyChange = (f: Frequency) => {
    setFrequency(f);
    if (f === "daily") setDays(DAYS);
    else if (f === "weekly") setDays(["Monday"]);
    else if (f === "monthly") setDays([]);
    // custom: keep current days
  };

  const effectiveDays = frequency === "daily" ? DAYS : days;

  const saveAll = () => {
    update.mutate({
      data: {
        scheduleEnabled: enabled,
        scheduleFrequency: frequency,
        scheduleDays: frequency === "monthly" ? [] : effectiveDays,
        scheduleMonthDay: frequency === "monthly" ? monthDay : null,
        scheduleTime: time,
        scheduleTimezone: timezone,
        scheduleUrlListId: urlListId === "all" ? null : parseInt(urlListId, 10),
      } as any,
    }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminSettingsQueryKey() });
        toast({ title: "Schedule saved", description: "Automation settings updated." });
      },
    });
  };

  const selectedListName = lists?.find((l) => String(l.id) === urlListId)?.name ?? "All lists";
  const tzLabel = TIMEZONES.find((t) => t.value === timezone)?.label ?? timezone;

  const scheduleDesc = (() => {
    if (!enabled) return null;
    if (frequency === "daily") return `Runs daily at ${time} ${tzLabel}`;
    if (frequency === "weekly" && days.length > 0) return `Runs every ${days.join(", ")} at ${time} ${tzLabel}`;
    if (frequency === "monthly") return `Runs on the ${ordinal(monthDay)} of each month at ${time} ${tzLabel}`;
    if (frequency === "custom" && days.length > 0) return `Runs every ${days.join(", ")} at ${time} ${tzLabel}`;
    return null;
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Automation</h1>
        <p className="text-muted-foreground mt-1">Configure automatic crawl schedules.</p>
      </div>

      <div className="bg-card border rounded-xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">Schedule Settings</h2>
          <Separator className="mt-3" />
        </div>

        {isLoading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : (
          <div className="space-y-8">
            <Section title="Automated Crawling" description="Enable automatic crawl runs on a recurring schedule.">
              <div className="flex items-center gap-3">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                <span className="text-sm font-medium">{enabled ? "Enabled" : "Disabled"}</span>
              </div>
            </Section>

            <Section
              title="URL List to Crawl"
              description="Choose which URL list the scheduler should crawl. Select a specific list or run all lists."
            >
              <div className="max-w-xs">
                <Select value={urlListId} onValueChange={setUrlListId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a list…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All lists</SelectItem>
                    {lists?.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Section>

            <Section title="Frequency" description="How often the crawler should run.">
              <div className="flex flex-wrap gap-2">
                {(["daily", "weekly", "monthly", "custom"] as Frequency[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => handleFrequencyChange(f)}
                    className={cn(
                      "px-4 py-1.5 rounded-full text-sm font-medium border capitalize transition-colors",
                      frequency === f
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50"
                    )}
                  >
                    {f === "custom" ? "Specific Days" : f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              {/* Day-of-week picker for Weekly / Custom */}
              {(frequency === "weekly" || frequency === "custom") && (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground mb-3">
                    {frequency === "weekly" ? "Select the day of the week:" : "Select one or more days:"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map((day) => (
                      <button
                        key={day}
                        onClick={() => {
                          if (frequency === "weekly") {
                            setDays([day]);
                          } else {
                            toggleDay(day);
                          }
                        }}
                        className={cn(
                          "px-4 py-1.5 rounded-full text-sm font-medium border transition-colors",
                          days.includes(day)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-border hover:border-primary/50"
                        )}
                      >
                        {day.slice(0, 3)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Day-of-month picker for Monthly */}
              {frequency === "monthly" && (
                <div className="mt-4 max-w-xs">
                  <Label className="text-sm text-muted-foreground mb-2 block">Day of the month:</Label>
                  <Select value={String(monthDay)} onValueChange={(v) => setMonthDay(Number(v))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {MONTH_DAYS.map((d) => (
                        <SelectItem key={d} value={String(d)}>{ordinal(d)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </Section>

            <Section title="Time & Timezone" description="Set the exact time the crawler starts.">
              <div className="flex flex-wrap gap-4 items-end max-w-lg">
                <div className="space-y-2">
                  <Label>Time</Label>
                  <Input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-36"
                  />
                </div>
                <div className="space-y-2 flex-1 min-w-[200px]">
                  <Label>Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Section>

            <div>
              <Button onClick={saveAll} disabled={update.isPending}>
                <Save className="w-4 h-4 mr-2" />
                {update.isPending ? "Saving…" : "Save Schedule"}
              </Button>
              {scheduleDesc && (
                <p className="text-sm text-muted-foreground mt-3 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                  {scheduleDesc} — crawls <strong>{selectedListName}</strong>
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
