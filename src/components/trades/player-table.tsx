import Link from "next/link";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtNum } from "@/lib/nba/format";
import type { TradePlayer } from "@/lib/trades/service";

/** Read-only list of players in a trade with the numbers that matter for a decision. */
export function TradePlayerTable({ players, testId }: { players: TradePlayer[]; testId?: string }) {
  if (players.length === 0) return <p className="text-sm text-muted-foreground">No players.</p>;
  const total = players.reduce((s, p) => s + (p.projection ?? 0), 0);
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid={testId}>
      <Table data-sticky-first>
        <TableHeader>
          <TableRow>
            <TableHead>Player</TableHead>
            <TableHead className="hidden sm:table-cell">NBA</TableHead>
            <TableHead className="hidden sm:table-cell">Pos</TableHead>
            <TableHead className="hidden text-right sm:table-cell" title="Fantasy points per game last season (win bonus included)">Last FP/G</TableHead>
            <TableHead className="hidden text-right sm:table-cell" title="Total fantasy points last season (win bonus included)">Last FP</TableHead>
            <TableHead className="text-right">FP/G</TableHead>
            <TableHead className="text-right">Proj</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Win bonus/G</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {players.map((p) => (
            <TableRow key={p.playerId} data-testid="trade-player" data-player-id={p.playerId}>
              <TableCell className="font-medium whitespace-normal sm:whitespace-nowrap">
                <Link href={`/players/${p.playerId}`} className="mr-1 underline-offset-4 hover:underline">
                  {p.name}
                </Link>
                <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                <div className="text-xs font-normal text-muted-foreground sm:hidden">
                  {p.nbaAbbrev ?? "-"} · {p.positions.join("/") || "-"}
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">{p.nbaAbbrev ?? "-"}</TableCell>
              <TableCell className="hidden sm:table-cell">{p.positions.join("/") || "-"}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.lastAvg)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.lastFp, 0)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(p.seasonAvg)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(p.projection)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{fmtNum(p.winBonusPerGame)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={6} className="hidden text-right text-xs text-muted-foreground sm:table-cell">
              Total projected FP/G
            </TableCell>
            <TableCell colSpan={2} className="text-right text-xs text-muted-foreground sm:hidden">
              Total projected FP/G
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums" data-testid="proj-total">
              {fmtNum(total)}
            </TableCell>
            <TableCell className="hidden sm:table-cell" />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
