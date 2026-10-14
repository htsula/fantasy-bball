import Link from "next/link";
import { z } from "zod";
import { db } from "@/db";
import { RestoreButton } from "@/components/rosters/roster-controls";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TransactionType } from "@/db/schema";
import { getDraftByLeague } from "@/lib/draft/service";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtEtDateTime } from "@/lib/nba/format";
import { TRANSACTION_TYPES, listTransactions, type TransactionRow } from "@/lib/rosters/service";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const TYPE_LABEL: Record<TransactionType, string> = {
  add: "Add",
  drop: "Drop",
  trade: "Trade",
  auto_drop: "Cut by NBA",
  commissioner_add: "Commissioner add",
  commissioner_drop: "Commissioner drop",
};

type Entry =
  | { kind: "row"; row: TransactionRow }
  | { kind: "trade"; groupId: string; first: TransactionRow; rows: TransactionRow[] };

/** One entry per executed trade (all of its player rows grouped), other transactions as they are. */
function groupEntries(rows: TransactionRow[]): Entry[] {
  const out: Entry[] = [];
  const trades = new Map<string, Extract<Entry, { kind: "trade" }>>();
  for (const row of rows) {
    if (row.type === "trade" && row.groupId) {
      const existing = trades.get(row.groupId);
      if (existing) existing.rows.push(row);
      else {
        const entry = { kind: "trade" as const, groupId: row.groupId, first: row, rows: [row] };
        trades.set(row.groupId, entry);
        out.push(entry);
      }
    } else out.push({ kind: "row", row });
  }
  return out;
}

const paramsSchema = z.object({
  team: z.string().uuid().optional().catch(undefined),
  type: z.enum(TRANSACTION_TYPES as [TransactionType, ...TransactionType[]]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const q = paramsSchema.parse(raw);
  const [result, draft] = await Promise.all([
    listTransactions(db, leagueId, { teamId: q.team, type: q.type, limit: PAGE_SIZE, offset: (q.page - 1) * PAGE_SIZE }),
    getDraftByLeague(db, leagueId),
  ]);
  const base = `/leagues/${leagueId}`;
  const entries = groupEntries(result.rows);
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const href = (page: number) => {
    const qs = new URLSearchParams();
    if (q.team) qs.set("team", q.team);
    if (q.type) qs.set("type", q.type);
    if (page > 1) qs.set("page", String(page));
    const s = qs.toString();
    return s ? `${base}/transactions?${s}` : `${base}/transactions`;
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Transactions</h2>
        <p className="text-sm text-muted-foreground">Adds, drops, players cut by the NBA and commissioner moves.</p>
      </div>

      {draft && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Draft</CardTitle>
            <CardDescription>
              {draft.status === "complete"
                ? "The draft is complete. Every pick is in the draft recap."
                : "The draft is in progress."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={`${base}/draft`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {draft.status === "complete" ? "View draft picks" : "Go to the draft room"}
            </Link>
          </CardContent>
        </Card>
      )}

      <form method="get" action={`${base}/transactions`} className="grid gap-2 sm:grid-cols-4" aria-label="Transaction filters">
        <NativeSelect name="team" defaultValue={q.team ?? ""} aria-label="Team">
          <option value="">All teams</option>
          {view.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="type" defaultValue={q.type ?? ""} aria-label="Type">
          <option value="">All types</option>
          {TRANSACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            Apply
          </Button>
          <Link href={`${base}/transactions`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Reset
          </Link>
        </div>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (ET)</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Move</TableHead>
              <TableHead>Player</TableHead>
              <TableHead>By</TableHead>
              {view.isCommissioner && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={view.isCommissioner ? 6 : 5} className="text-muted-foreground">
                  No transactions yet.
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => {
              if (entry.kind === "trade") {
                const byTeam = new Map<string, { name: string; players: string[] }>();
                for (const r of entry.rows) {
                  const t = byTeam.get(r.teamId) ?? { name: r.teamName, players: [] };
                  t.players.push(r.playerName);
                  byTeam.set(r.teamId, t);
                }
                return (
                  <TableRow key={entry.groupId} data-testid="transaction-row" data-type="trade">
                    <TableCell className="whitespace-nowrap">{fmtEtDateTime(entry.first.createdAt)}</TableCell>
                    <TableCell>{[...byTeam.values()].map((t) => t.name).join(" ⇄ ")}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{TYPE_LABEL.trade}</Badge>
                    </TableCell>
                    <TableCell className="font-medium" data-testid="trade-summary-cell">
                      {[...byTeam.values()].map((t) => (
                        <div key={t.name}>
                          <span className="font-normal text-muted-foreground">{t.name} receives </span>
                          {t.players.join(", ")}
                        </div>
                      ))}
                      <Link href={`${base}/trades/${entry.groupId}`} className="text-xs font-normal underline underline-offset-4">
                        View trade
                      </Link>
                    </TableCell>
                    <TableCell>{entry.first.actorUsername ?? "System"}</TableCell>
                    {view.isCommissioner && <TableCell />}
                  </TableRow>
                );
              }
              const r = entry.row;
              return (
              <TableRow key={r.id} data-testid="transaction-row" data-type={r.type}>
                <TableCell className="whitespace-nowrap">{fmtEtDateTime(r.createdAt)}</TableCell>
                <TableCell>
                  <Link href={`${base}/teams/${r.teamId}`} className="underline-offset-4 hover:underline">
                    {r.teamName}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={r.type === "auto_drop" || r.type.endsWith("drop") ? "secondary" : "outline"}>{TYPE_LABEL[r.type]}</Badge>
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/players/${r.playerId}`} className="underline-offset-4 hover:underline">
                    {r.playerName}
                  </Link>
                  {r.note ? <span className="ml-2 text-xs font-normal text-muted-foreground">{r.note}</span> : null}
                </TableCell>
                <TableCell>{r.actorUsername ?? "System"}</TableCell>
                {view.isCommissioner && (
                  <TableCell>
                    {r.restorable ? <RestoreButton leagueId={leagueId} transactionId={r.id} playerName={r.playerName} /> : null}
                  </TableCell>
                )}
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
        <span className="text-muted-foreground">
          {result.total} transactions, page {Math.min(q.page, pageCount)} of {pageCount}
        </span>
        <div className="flex gap-2">
          {q.page > 1 && (
            <Link href={href(q.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          )}
          {q.page < pageCount && (
            <Link href={href(q.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
