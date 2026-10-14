import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  ACTIVITY_CATEGORY_LABELS,
  ACTIVITY_FILTERS,
  isCommissionerType,
  listActivity,
  parseFilter,
  typeLabel,
} from "@/lib/activity/service";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtEtDateTime } from "@/lib/nba/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const FILTER_LABEL: Record<(typeof ACTIVITY_FILTERS)[number], string> = ACTIVITY_CATEGORY_LABELS;

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueId } = await params;
  await loadLeagueView(leagueId);
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const filter = parseFilter(first(sp.type));
  const page = Math.min(1000, Math.max(1, Number(first(sp.page)) || 1));
  const { entries, total } = await listActivity(db, leagueId, { filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const base = `/leagues/${leagueId}`;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (p: number) => {
    const qs = new URLSearchParams();
    if (filter) qs.set("type", filter);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return s ? `${base}/activity?${s}` : `${base}/activity`;
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold">Activity</h2>
          <p className="text-sm text-muted-foreground">
            Everything that changes in this league, newest first. Commissioner actions always show who did them.
          </p>
        </div>
        <Link href={`${base}/transactions`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Transactions (adds and drops)
        </Link>
      </div>

      <form method="get" action={`${base}/activity`} className="flex flex-wrap gap-2" aria-label="Activity filters">
        <NativeSelect name="type" defaultValue={filter ?? ""} aria-label="Type" className="w-auto min-w-48">
          <option value="">Everything</option>
          {ACTIVITY_FILTERS.map((f) => (
            <option key={f} value={f}>
              {FILTER_LABEL[f]}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Link href={`${base}/activity`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Reset
        </Link>
      </form>

      <ul className="grid divide-y rounded-lg border" data-testid="activity-list">
        {entries.length === 0 && <li className="p-3 text-sm text-muted-foreground">Nothing here yet.</li>}
        {entries.map((e) => {
          const url = typeof e.data?.url === "string" && e.data.url.startsWith("/") ? e.data.url : null;
          const commissioner = isCommissionerType(e.type);
          return (
            <li key={e.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[10rem_1fr]" data-testid="activity-row" data-type={e.type}>
              <span className="text-xs text-muted-foreground">{fmtEtDateTime(e.createdAt)}</span>
              <div className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={commissioner ? "default" : "outline"}>{typeLabel(e.type)}</Badge>
                  <span data-testid="activity-actor" className="text-xs text-muted-foreground">
                    {e.actorUsername ? `by ${e.actorUsername}` : "by the system"}
                  </span>
                </div>
                <p>
                  {e.summary}{" "}
                  {url && (
                    <Link href={url} className="text-xs underline underline-offset-4">
                      View
                    </Link>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
        <span className="text-muted-foreground">
          {total} entries, page {Math.min(page, pageCount)} of {pageCount}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link href={href(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          )}
          {page < pageCount && (
            <Link href={href(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
