"use client";

import { useActionState } from "react";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormState } from "@/lib/auth/validation";
import {
  PLAYOFF_TEAM_OPTIONS,
  SCORING_KEYS,
  SCORING_LABELS,
  TRADE_REVIEW_MODES,
  type LeagueSettings,
} from "@/lib/fantasy/settings";
import { updateSettingsAction } from "../../actions";

const TRADE_LABELS = {
  none: "No review (instant)",
  commissioner: "Commissioner review",
  league_vote: "League vote (veto)",
} as const;

export function SettingsForm({
  leagueId,
  settings: s,
  draftLocked,
  teamCount,
}: {
  leagueId: string;
  settings: LeagueSettings;
  draftLocked: boolean;
  teamCount: number;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateSettingsAction.bind(null, leagueId), {});
  const errs = state.fieldErrors;
  const v = state.values;
  // Echo submitted values after a failed save (React resets uncontrolled inputs after an action).
  const val = (name: string, saved: string | number | null) => v?.[name] ?? (saved === null ? "" : String(saved));

  const intField = (name: keyof LeagueSettings, label: string, lockable = false) => (
    <FormField
      key={name}
      name={name}
      label={label}
      type="number"
      inputMode="numeric"
      defaultValue={val(name, s[name] as number)}
      errors={errs?.[name]}
      disabled={lockable && draftLocked}
      required={!(lockable && draftLocked)}
    />
  );

  return (
    <form action={action} className="grid gap-4">
      <FormError message={state.error} />
      {state.success && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {state.success}
        </p>
      )}
      {errs && Object.keys(errs).length > 0 && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Some settings are invalid. Fix the highlighted fields and save again.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Scoring</CardTitle>
          <CardDescription>Points per stat. Defaults are ESPN&apos;s plus the +4 team win bonus.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {SCORING_KEYS.map((k) => (
            <FormField
              key={k}
              name={`scoring.${k}`}
              label={SCORING_LABELS[k]}
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={val(`scoring.${k}`, s.scoring[k])}
              errors={errs?.[`scoring.${k}`]}
              required
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rosters, draft and free agency</CardTitle>
          <CardDescription>
            {draftLocked
              ? "Roster and draft sizing is locked because the draft has started."
              : "Roster and draft sizing locks when the draft starts."}{" "}
            Max roster = min(cap, ⌊pool ÷ teams⌋); with {teamCount} {teamCount === 1 ? "team" : "teams"} it is computed live on the league page.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {intField("rosterPool", "Roster pool (total players)", true)}
          {intField("rosterCap", "Roster cap per team", true)}
          {intField("snakeTarget", "Snake picks target", true)}
          {intField("waveSize", "Picks per team per wave", true)}
          {intField("addsPerDay", "Free-agent adds per day")}
          {intField("keepers", "Keepers per team", true)}
          <FormField
            name="keeperDeadline"
            label="Keeper deadline (optional)"
            type="date"
            defaultValue={val("keeperDeadline", s.keeperDeadline)}
            errors={errs?.keeperDeadline}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trades</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="tradeReview">Trade review</Label>
            <NativeSelect id="tradeReview" name="tradeReview" defaultValue={val("tradeReview", s.tradeReview)}>
              {TRADE_REVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {TRADE_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
            {errs?.tradeReview?.map((e) => (
              <p key={e} className="text-sm text-destructive">
                {e}
              </p>
            ))}
          </div>
          {intField("tradeReviewHours", "Review period (hours)")}
          {intField("vetoVotesNeeded", "Veto votes needed")}
          <FormField
            name="tradeDeadline"
            label="Trade deadline (optional)"
            type="date"
            defaultValue={val("tradeDeadline", s.tradeDeadline)}
            errors={errs?.tradeDeadline}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule and playoffs</CardTitle>
          <CardDescription>
            Weekly matchups (Mon-Sun ET). Leave the dates as they are to use the NBA schedule; if the NBA schedule isn&apos;t
            loaded for this season, enter them here before generating the schedule.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <FormField
            name="regularSeasonStart"
            label="Regular season start"
            type="date"
            defaultValue={val("regularSeasonStart", s.regularSeasonStart)}
            errors={errs?.regularSeasonStart}
          />
          <FormField
            name="regularSeasonEnd"
            label="Regular season end"
            type="date"
            defaultValue={val("regularSeasonEnd", s.regularSeasonEnd)}
            errors={errs?.regularSeasonEnd}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="playoffTeams">Playoff teams</Label>
            <NativeSelect id="playoffTeams" name="playoffTeams" defaultValue={val("playoffTeams", s.playoffTeams)}>
              {PLAYOFF_TEAM_OPTIONS.map((n) => (
                <option key={n} value={n} disabled={n > teamCount && n !== s.playoffTeams}>
                  {n}
                </option>
              ))}
            </NativeSelect>
            {errs?.playoffTeams?.map((e) => (
              <p key={e} className="text-sm text-destructive">
                {e}
              </p>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="playoffRoundLength">Playoff round length</Label>
            <NativeSelect
              id="playoffRoundLength"
              name="playoffRoundLength"
              defaultValue={val("playoffRoundLength", s.playoffRoundLength)}
            >
              <option value="1">1 week</option>
              <option value="2">2 weeks</option>
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={pending} className="w-full sm:w-fit">
        {pending ? "Saving..." : "Save settings"}
      </Button>
    </form>
  );
}
