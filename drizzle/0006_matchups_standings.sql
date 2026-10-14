CREATE TABLE "matchup_team_totals" (
	"matchup_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"points" numeric DEFAULT 0 NOT NULL,
	"win_bonus" numeric DEFAULT 0 NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"games_remaining" integer DEFAULT 0 NOT NULL,
	"projected" numeric DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matchup_team_totals_matchup_id_team_id_pk" PRIMARY KEY("matchup_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "standings" (
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"points_for" numeric DEFAULT 0 NOT NULL,
	"points_against" numeric DEFAULT 0 NOT NULL,
	"streak" text DEFAULT '' NOT NULL,
	"rank" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standings_league_id_team_id_pk" PRIMARY KEY("league_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "matchups" ADD COLUMN "status" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "matchups" ADD COLUMN "winner_team_id" uuid;--> statement-breakpoint
ALTER TABLE "matchups" ADD COLUMN "home_points" numeric;--> statement-breakpoint
ALTER TABLE "matchups" ADD COLUMN "away_points" numeric;--> statement-breakpoint
ALTER TABLE "matchup_team_totals" ADD CONSTRAINT "matchup_team_totals_matchup_id_matchups_id_fk" FOREIGN KEY ("matchup_id") REFERENCES "public"."matchups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchup_team_totals" ADD CONSTRAINT "matchup_team_totals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings" ADD CONSTRAINT "standings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings" ADD CONSTRAINT "standings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standings_league_rank_idx" ON "standings" USING btree ("league_id","rank");--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_winner_team_id_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;