"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { counterTradeAction, proposeTradeAction } from "@/app/(app)/leagues/[leagueId]/trades/actions";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { fmtNum } from "@/lib/nba/format";
import type { TradePlayer } from "@/lib/trades/service";

type TeamOpt = { id: string; name: string };

function Picker({
  title,
  players,
  selected,
  onToggle,
  testId,
}: {
  title: string;
  players: TradePlayer[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  testId: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return players;
    return players.filter((p) => `${p.name} ${p.nbaAbbrev ?? ""} ${p.positions.join(" ")}`.toLowerCase().includes(needle));
  }, [players, q]);
  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{selected.size} selected</CardDescription>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, team or position" aria-label={`Search ${title}`} />
      </CardHeader>
      <CardContent>
        <ul className="grid max-h-96 gap-1 overflow-y-auto pr-1">
          {shown.length === 0 && <li className="text-sm text-muted-foreground">No players.</li>}
          {shown.map((p) => (
            <li key={p.playerId}>
              <label
                className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                data-testid="pick-row"
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={selected.has(p.playerId)}
                  onChange={() => onToggle(p.playerId)}
                  aria-label={`Select ${p.name}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{p.name}</span> <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                  <span className="block text-xs text-muted-foreground">
                    {p.nbaAbbrev ?? "FA"} &middot; {p.positions.join("/") || "-"}
                  </span>
                </span>
                <span className="grid shrink-0 grid-cols-4 gap-2 text-right text-xs tabular-nums">
                  <span title="Last season: fantasy points per game and total (win bonus included)">
                    <span className="block text-muted-foreground">Last</span>
                    {fmtNum(p.lastAvg)}
                    <span className="block text-muted-foreground">{fmtNum(p.lastFp, 0)} FP</span>
                  </span>
                  <span title="Fantasy points per game this season">
                    <span className="block text-muted-foreground">FP/G</span>
                    {fmtNum(p.seasonAvg)}
                  </span>
                  <span title="Projected fantasy points per game">
                    <span className="block text-muted-foreground">Proj</span>
                    {fmtNum(p.projection)}
                  </span>
                  <span title="Expected win-bonus points per game">
                    <span className="block text-muted-foreground">+Win</span>
                    {fmtNum(p.winBonusPerGame)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function TradeBuilder({
  leagueId,
  myTeam,
  partner,
  otherTeams,
  myRoster,
  theirRoster,
  max,
  initialGive,
  initialGet,
  initialMessage,
  counterOf,
}: {
  leagueId: string;
  myTeam: TeamOpt;
  partner: TeamOpt | null;
  otherTeams: TeamOpt[];
  myRoster: TradePlayer[];
  theirRoster: TradePlayer[];
  max: number;
  initialGive: number[];
  initialGet: number[];
  initialMessage: string;
  /** Set when this is a counteroffer: the trade being answered. */
  counterOf: string | null;
}) {
  const router = useRouter();
  const [give, setGive] = useState(() => new Set(initialGive));
  const [get, setGet] = useState(() => new Set(initialGet));
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (set: Set<number>, setter: (s: Set<number>) => void) => (id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };
  const sum = (players: TradePlayer[], ids: Set<number>) =>
    players.filter((p) => ids.has(p.playerId)).reduce((s, p) => s + (p.projection ?? 0), 0);
  const giveProj = sum(myRoster, give);
  const getProj = sum(theirRoster, get);
  const myAfter = myRoster.length - give.size + get.size;
  const theirAfter = theirRoster.length - get.size + give.size;
  const myOver = Math.max(0, myAfter - max);
  const theirOver = Math.max(0, theirAfter - max);
  const empty = give.size + get.size === 0;

  function submit() {
    if (!partner) return;
    setError(null);
    start(async () => {
      const payload = { give: [...give], get: [...get], message: message.trim() || null };
      const res = counterOf
        ? await counterTradeAction(leagueId, counterOf, payload)
        : await proposeTradeAction(leagueId, { proposerTeamId: myTeam.id, receiverTeamId: partner.id, ...payload });
      if (res.ok && res.tradeId) {
        toast.success(counterOf ? "Counteroffer sent" : "Trade offer sent");
        router.push(`/leagues/${leagueId}/trades/${res.tradeId}`);
      } else if (!res.ok) {
        setError(res.error);
      }
    });
  }

  return (
    <div className="grid gap-4" data-testid="trade-builder">
      {!counterOf && (
        <div className="grid gap-1 sm:max-w-sm">
          <label htmlFor="partner" className="text-sm font-medium">
            Trade with
          </label>
          <NativeSelect
            id="partner"
            value={partner?.id ?? ""}
            onChange={(e) => router.push(`/leagues/${leagueId}/trades/new${e.target.value ? `?with=${e.target.value}` : ""}`)}
            data-testid="partner-select"
          >
            <option value="">Choose a team</option>
            {otherTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {partner && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Picker title={`You give (${myTeam.name})`} players={myRoster} selected={give} onToggle={toggle(give, setGive)} testId="give-picker" />
            <Picker title={`You get (${partner.name})`} players={theirRoster} selected={get} onToggle={toggle(get, setGet)} testId="get-picker" />
          </div>

          <Card size="sm" data-testid="trade-summary">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>
                Projected FP/G is the sum of each player&apos;s blended projection including the expected +4 win bonus.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">You give</p>
                  <p className="text-sm">
                    {give.size} player{give.size === 1 ? "" : "s"} &middot; <span data-testid="give-proj">{fmtNum(giveProj)}</span> proj FP/G
                  </p>
                  <p className={myOver > 0 ? "text-sm text-destructive" : "text-sm text-muted-foreground"} data-testid="my-roster-after">
                    {myTeam.name} roster after: {myAfter} / {max}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">You get</p>
                  <p className="text-sm">
                    {get.size} player{get.size === 1 ? "" : "s"} &middot; <span data-testid="get-proj">{fmtNum(getProj)}</span> proj FP/G
                  </p>
                  <p className={theirOver > 0 ? "text-sm text-destructive" : "text-sm text-muted-foreground"} data-testid="their-roster-after">
                    {partner.name} roster after: {theirAfter} / {max}
                  </p>
                </div>
              </div>
              {(myOver > 0 || theirOver > 0) && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="roster-warning">
                  {[
                    myOver > 0 ? `${myTeam.name} would be ${myOver} over the roster maximum` : null,
                    theirOver > 0 ? `${partner.name} would be ${theirOver} over the roster maximum` : null,
                  ]
                    .filter(Boolean)
                    .join(" and ")}
                  . The trade can&apos;t execute until that team drops players. You can still send the offer, but nobody is auto-dropped.
                </p>
              )}
              <div className="grid gap-1">
                <label htmlFor="trade-message" className="text-sm font-medium">
                  Message (optional)
                </label>
                <Input id="trade-message" value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="Say something nice" />
              </div>
              {error && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="trade-error">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={submit} disabled={pending || empty} data-testid="submit-trade">
                  {pending ? "Sending..." : counterOf ? "Send counteroffer" : "Send offer"}
                </Button>
                <Link href={`/leagues/${leagueId}/trades`} className="inline-flex h-8 items-center px-2 text-sm underline-offset-4 hover:underline">
                  Cancel
                </Link>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
