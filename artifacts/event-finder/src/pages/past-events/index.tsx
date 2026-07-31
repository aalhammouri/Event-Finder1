import { useGetEvents, useGetAdminSettings } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EventsTable } from "@/components/events/event-table";
import { History, Loader2, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useState, useEffect } from "react";

const PAGE_SIZE = 50;

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "score", label: "Score" },
  { value: "eventDate", label: "Event date" },
  { value: "eventName", label: "Event name" },
  { value: "orgName", label: "Organization" },
  { value: "createdAt", label: "Found at" },
];

export default function PastEvents() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("eventDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const { data: settings } = useGetAdminSettings();
  const tiers = settings?.tiers;

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, isFetching } = useGetEvents({
    pastOnly: true,
    search: search || undefined,
    sortBy,
    sortDir,
    page,
    limit: PAGE_SIZE,
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Past Events</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Events whose date has already passed, collected across all runs. Revisit them next year.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search event, org, venue, contact…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setPage(1); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>Sort: {o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortDir} onValueChange={(v) => { setSortDir(v as "asc" | "desc"); setPage(1); }}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Descending</SelectItem>
              <SelectItem value="asc">Ascending</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading past events…
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <History className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium mb-1">
            {search ? "No matching past events" : "No past events yet"}
          </p>
          <p className="text-sm">
            {search
              ? "Try a different search term."
              : "Events automatically move here once their date passes."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-card rounded-md border shadow-sm">
            <EventsTable events={events} tiers={tiers} variant="past" />
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {total} past event{total !== 1 ? "s" : ""}
                {isFetching && <Loader2 className="inline w-3 h-3 ml-2 animate-spin" />}
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm border bg-white text-muted-foreground hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <button
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm border bg-white text-muted-foreground hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
