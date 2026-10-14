CREATE TABLE "keepers" (
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"selected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keepers_team_id_player_id_pk" PRIMARY KEY("team_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "playoff_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"slot" integer NOT NULL,
	"team_a_id" uuid,
	"team_b_id" uuid,
	"seed_a" integer,
	"seed_b" integer,
	"source_a_slot_id" uuid,
	"source_b_slot_id" uuid,
	"winner_team_id" uuid,
	"decided_at" timestamp with time zone,
	"overridden" boolean DEFAULT false NOT NULL,
	"overridden_by" uuid,
	"overridden_at" timestamp with time zone,
	"override_note" text
);
--> statement-breakpoint
CREATE TABLE "season_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid,
	"owner_user_id" uuid,
	"team_name" text NOT NULL,
	"final_rank" integer NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"ties" integer DEFAULT 0 NOT NULL,
	"points_for" numeric DEFAULT 0 NOT NULL,
	"points_against" numeric DEFAULT 0 NOT NULL,
	"playoff_result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "previous_league_id" uuid;--> statement-breakpoint
ALTER TABLE "matchups" ADD COLUMN "playoff_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "previous_team_id" uuid;--> statement-breakpoint
ALTER TABLE "keepers" ADD CONSTRAINT "keepers_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keepers" ADD CONSTRAINT "keepers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keepers" ADD CONSTRAINT "keepers_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keepers" ADD CONSTRAINT "keepers_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_source_a_slot_id_playoff_slots_id_fk" FOREIGN KEY ("source_a_slot_id") REFERENCES "public"."playoff_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_source_b_slot_id_playoff_slots_id_fk" FOREIGN KEY ("source_b_slot_id") REFERENCES "public"."playoff_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_winner_team_id_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_slots" ADD CONSTRAINT "playoff_slots_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "keepers_league_player_idx" ON "keepers" USING btree ("league_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playoff_slots_league_round_slot_idx" ON "playoff_slots" USING btree ("league_id","round","slot");--> statement-breakpoint
CREATE INDEX "season_results_league_rank_idx" ON "season_results" USING btree ("league_id","final_rank");--> statement-breakpoint
CREATE INDEX "season_results_owner_idx" ON "season_results" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_previous_league_id_leagues_id_fk" FOREIGN KEY ("previous_league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_playoff_slot_id_playoff_slots_id_fk" FOREIGN KEY ("playoff_slot_id") REFERENCES "public"."playoff_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_previous_team_id_teams_id_fk" FOREIGN KEY ("previous_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_previous_league_idx" ON "leagues" USING btree ("previous_league_id");