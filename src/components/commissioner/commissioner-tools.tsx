"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  adjustScoreAction,
  editTeamAction,
  forceCancelTradeAction,
  removeTeamAction,
  restartDraftAction,
  transferCommissionerAction,
  transferOwnershipAction,
  type CommissionerResult,
} from "@/app/(app)/leagues/[leagueId]/commissioner/actions";
import { postAnnouncementAction } from "@/app/(app)/leagues/[leagueId]/chat/actions";
import { CommissionerAddPlayer, DropButton, RestoreButton } from "@/components/rosters/roster-controls";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

/** Runs a commissioner action: pending flag, error text, success toast and warnings. */
function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const run = (fn: () => Promise<CommissionerResult>, onOk?: (res: Extract<CommissionerResult, { ok: true }>) => void) => {
    setError(null);
    setWarnings([]);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done");
        if (res.warnings?.length) setWarnings(res.warnings);
        onOk?.(res);
      } else {
        setError(res.error);
      }
    });
  };
  return { pending, error, warnings, run, setError };
}

function Feedback({ error, warnings }: { error: string | null; warnings?: string[] }) {
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-destructive" data-testid="commissioner-error">
          {error}
        </p>
      )}
      {warnings?.map((w) => (
        <p key={w} role="status" className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300" data-testid="commissioner-warning">
          {w}
        </p>
      ))}
    </>
  );
}

// ------------------------------------------------------------------------------ members and teams

export type TeamRow = { id: string; name: string; abbrev: string; ownerUsername: string; isCommissionerTeam: boolean };

export function TeamAdmin({ leagueId, teams, canRemove }: { leagueId: string; teams: TeamRow[]; canRemove: boolean }) {
  return (
    <div className="grid gap-3">
      {teams.map((t) => (
        <TeamAdminRow key={t.id} leagueId={leagueId} team={t} canRemove={canRemove && !t.isCommissionerTeam} />
      ))}
    </div>
  );
}

function TeamAdminRow({ leagueId, team, canRemove }: { leagueId: string; team: TeamRow; canRemove: boolean }) {
  const [name, setName] = useState(team.name);
  const [abbrev, setAbbrev] = useState(team.abbrev);
  const [username, setUsername] = useState("");
  const edit = useAction();
  const transfer = useAction();
  const remove = useAction();
  const [removing, setRemoving] = useState(false);
  return (
    <div className="grid gap-2 rounded-lg border p-3" data-testid="commissioner-team" data-team={team.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leagues/${leagueId}/teams/${team.id}`} className="font-medium underline-offset-4 hover:underline">
          {team.name}
        </Link>
        <span className="text-sm text-muted-foreground">owner {team.ownerUsername}</span>
        {team.isCommissionerTeam && <Badge variant="outline">Commissioner</Badge>}
      </div>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_6rem_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          edit.run(() => editTeamAction(leagueId, team.id, name, abbrev));
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={`Name of ${team.name}`} />
        <Input value={abbrev} onChange={(e) => setAbbrev(e.target.value)} aria-label={`Abbreviation of ${team.name}`} maxLength={5} />
        <Button type="submit" size="sm" variant="outline" disabled={edit.pending} aria-label={`Save ${team.name}`}>
          Save
        </Button>
      </form>
      <Feedback error={edit.error} />
      {!team.isCommissionerTeam && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!username.trim()) return;
            transfer.run(
              () => transferOwnershipAction(leagueId, team.id, username),
              () => setUsername(""),
            );
          }}
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Give this team to (username)"
            aria-label={`New owner of ${team.name}`}
          />
          <Button type="submit" size="sm" variant="outline" disabled={transfer.pending || !username.trim()} aria-label={`Transfer ${team.name}`}>
            Transfer ownership
          </Button>
        </form>
      )}
      <Feedback error={transfer.error} />
      {canRemove && (
        <div>
          <Button type="button" size="xs" variant="destructive" onClick={() => setRemoving(true)}>
            Remove team
          </Button>
          <Dialog open={removing} onOpenChange={setRemoving}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove {team.name}?</DialogTitle>
                <DialogDescription>
                  Only possible during setup. The schedule is cleared and must be regenerated. This is logged in the activity feed.
                </DialogDescription>
              </DialogHeader>
              <Feedback error={remove.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <Button
                  variant="destructive"
                  disabled={remove.pending}
                  onClick={() => remove.run(() => removeTeamAction(leagueId, team.id), () => setRemoving(false))}
                >
                  Remove team
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- commissioner role

export function TransferCommissioner({
  leagueId,
  candidates,
}: {
  leagueId: string;
  candidates: { teamId: string; label: string }[];
}) {
  const router = useRouter();
  const [teamId, setTeamId] = useState("");
  const [open, setOpen] = useState(false);
  const act = useAction();
  const chosen = candidates.find((c) => c.teamId === teamId);
  if (candidates.length === 0) return <p className="text-sm text-muted-foreground">There is no other team owner to hand the role to.</p>;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <NativeSelect value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="New commissioner" className="w-auto min-w-56">
          <option value="">Choose the new commissioner</option>
          {candidates.map((c) => (
            <option key={c.teamId} value={c.teamId}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
        <Button type="button" variant="outline" size="sm" disabled={!teamId} onClick={() => setOpen(true)} data-testid="transfer-commissioner">
          Transfer commissioner role
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand over the commissioner role?</DialogTitle>
            <DialogDescription>
              {chosen?.label} becomes the commissioner. You immediately lose the commissioner tools, including this page, and
              only the new commissioner can give the role back.
            </DialogDescription>
          </DialogHeader>
          <Feedback error={act.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={act.pending}
              data-testid="confirm-transfer-commissioner"
              onClick={() =>
                act.run(
                  () => transferCommissionerAction(leagueId, teamId),
                  () => {
                    setOpen(false);
                    router.push(`/leagues/${leagueId}`);
                    router.refresh();
                  },
                )
              }
            >
              Yes, transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ rosters

export type RosterTeam = {
  id: string;
  name: string;
  players: { id: number; name: string; detail: string }[];
};
export type RestorableDrop = { transactionId: string; teamName: string; playerName: string };

export function RosterTools({
  leagueId,
  teams,
  open,
  restorable,
}: {
  leagueId: string;
  teams: RosterTeam[];
  open: boolean;
  restorable: RestorableDrop[];
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const team = teams.find((t) => t.id === teamId);
  if (!open) {
    return <p className="text-sm text-muted-foreground">Roster moves open once the draft is complete (the season is under way).</p>;
  }
  return (
    <div className="grid gap-4">
      <NativeSelect value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team" className="w-auto min-w-56" data-testid="roster-team-select">
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </NativeSelect>
      {team && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <h4 className="text-sm font-semibold">{team.name} roster ({team.players.length})</h4>
            {team.players.length === 0 && <p className="text-sm text-muted-foreground">No players.</p>}
            <ul className="grid gap-1">
              {team.players.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                  <span>
                    {p.name} <span className="text-muted-foreground">{p.detail}</span>
                  </span>
                  <DropButton leagueId={leagueId} teamId={team.id} playerId={p.id} playerName={p.name} />
                </li>
              ))}
            </ul>
          </div>
          <div className="grid content-start gap-2">
            <h4 className="text-sm font-semibold">Add a free agent to {team.name}</h4>
            <p className="text-xs text-muted-foreground">Commissioner adds skip the daily add limit but not the roster maximum.</p>
            <CommissionerAddPlayer leagueId={leagueId} teamId={team.id} />
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <h4 className="text-sm font-semibold">Restore a player the NBA cut</h4>
        {restorable.length === 0 ? (
          <p className="text-sm text-muted-foreground">No auto-drops can be restored right now.</p>
        ) : (
          <ul className="grid gap-1">
            {restorable.map((r) => (
              <li key={r.transactionId} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                <span>
                  {r.playerName} <span className="text-muted-foreground">from {r.teamName}</span>
                </span>
                <RestoreButton leagueId={leagueId} transactionId={r.transactionId} playerName={r.playerName} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------------- score adjusting

export type PeriodOption = {
  id: string;
  label: string;
  matchups: { id: string; label: string; status: string; teams: { id: string; name: string }[] }[];
};

export function ScoreAdjust({ leagueId, periods, defaultPeriodId }: { leagueId: string; periods: PeriodOption[]; defaultPeriodId: string | null }) {
  const [periodId, setPeriodId] = useState(defaultPeriodId ?? periods[0]?.id ?? "");
  const period = periods.find((p) => p.id === periodId);
  const [matchupId, setMatchupId] = useState("");
  const matchup = period?.matchups.find((m) => m.id === matchupId) ?? null;
  const [teamId, setTeamId] = useState("");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const act = useAction();
  if (periods.length === 0) return <p className="text-sm text-muted-foreground">There is no schedule yet.</p>;
  const valid = matchup && teamId && reason.trim().length >= 3 && Number.isFinite(Number(points)) && Number(points) !== 0 && points.trim() !== "";
  return (
    <form
      className="grid gap-2"
      data-testid="score-adjust"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        act.run(
          () => adjustScoreAction(leagueId, matchupId, teamId, Number(points), reason),
          () => {
            setPoints("");
            setReason("");
          },
        );
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <NativeSelect
          value={periodId}
          onChange={(e) => {
            setPeriodId(e.target.value);
            setMatchupId("");
            setTeamId("");
          }}
          aria-label="Period"
        >
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={matchupId}
          onChange={(e) => {
            setMatchupId(e.target.value);
            setTeamId("");
          }}
          aria-label="Matchup"
        >
          <option value="">Choose a matchup</option>
          {period?.matchups.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.status})
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team to adjust" disabled={!matchup}>
          <option value="">Team to adjust</option>
          {matchup?.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
        <Input
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          inputMode="decimal"
          placeholder="Points, e.g. 12.5 or -8"
          aria-label="Points (+ or -)"
        />
      </div>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, visible to the league)" aria-label="Reason" maxLength={300} />
      <div>
        <Button type="submit" size="sm" disabled={act.pending || !valid} data-testid="apply-adjustment">
          {act.pending ? "Applying..." : "Apply adjustment"}
        </Button>
      </div>
      <Feedback error={act.error} warnings={act.warnings} />
      <p className="text-xs text-muted-foreground">
        The adjustment counts in the matchup total, standings and playoff advancement. If the matchup is already final it is
        recalculated now. It is logged with your name.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------------------- the draft

export function RestartDraft({ leagueId, leagueName }: { leagueId: string; leagueName: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const act = useAction();
  return (
    <div className="grid gap-2">
      <div>
        <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)} data-testid="restart-draft">
          Restart draft
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart the draft?</DialogTitle>
            <DialogDescription>
              This deletes every pick and every drafted or kept player from all rosters and puts the league back in setup. You can
              start the draft again afterwards with a new random order. Type the league name to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={leagueName} aria-label="Type the league name" data-testid="restart-confirm" />
          <Feedback error={act.error} />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={act.pending || typed.trim().toLowerCase() !== leagueName.trim().toLowerCase()}
              data-testid="confirm-restart-draft"
              onClick={() => act.run(() => restartDraftAction(leagueId, typed), () => setOpen(false))}
            >
              Restart draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ----------------------------------------------------------------------------------------- trades

export type OpenTrade = { id: string; summary: string; status: string };

export function OpenTrades({ leagueId, trades }: { leagueId: string; trades: OpenTrade[] }) {
  if (trades.length === 0) return <p className="text-sm text-muted-foreground">No open trades.</p>;
  return (
    <ul className="grid gap-2">
      {trades.map((t) => (
        <OpenTradeRow key={t.id} leagueId={leagueId} trade={t} />
      ))}
    </ul>
  );
}

function OpenTradeRow({ leagueId, trade }: { leagueId: string; trade: OpenTrade }) {
  const [reason, setReason] = useState("");
  const act = useAction();
  return (
    <li className="grid gap-2 rounded-md border p-2 text-sm" data-testid="open-trade">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {trade.summary} <Badge variant="outline">{trade.status}</Badge>
        </span>
        <Link href={`/leagues/${leagueId}/trades/${trade.id}`} className={buttonVariants({ variant: "ghost", size: "xs" })}>
          Open
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" className="w-auto min-w-48 flex-1" />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={act.pending}
          onClick={() => {
            if (window.confirm("Cancel this trade?")) act.run(() => forceCancelTradeAction(leagueId, trade.id, reason));
          }}
        >
          Force-cancel
        </Button>
      </div>
      <Feedback error={act.error} />
    </li>
  );
}

// ------------------------------------------------------------------------------------ announcements

export function AnnouncementForm({ leagueId }: { leagueId: string }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2"
      data-testid="announcement-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setError(null);
        start(async () => {
          const res = await postAnnouncementAction(leagueId, body);
          if (res.ok) {
            toast.success("Announcement sent to every member");
            setBody("");
          } else setError(res.error);
        });
      }}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Write an announcement. Every member gets a notification."
        aria-label="Announcement"
        className="w-full rounded-lg border border-input bg-transparent px-2 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
      />
      <div>
        <Button type="submit" size="sm" disabled={pending || !body.trim()} data-testid="send-announcement">
          {pending ? "Sending..." : "Post announcement"}
        </Button>
      </div>
      <Feedback error={error} />
    </form>
  );
}
