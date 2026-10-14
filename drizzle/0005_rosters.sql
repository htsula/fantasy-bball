CREATE TABLE "game_roster_snapshots" (
	"game_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"nba_team_id" integer NOT NULL,
	"injury_status" text,
	"late" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_roster_snapshots_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"type" text NOT NULL,
	"player_id" integer NOT NULL,
	"group_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"et_date" date NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "game_roster_snapshots" ADD CONSTRAINT "game_roster_snapshots_game_id_nba_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_roster_snapshots" ADD CONSTRAINT "game_roster_snapshots_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_roster_snapshots_player_idx" ON "game_roster_snapshots" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "transactions_team_day_type_idx" ON "transactions" USING btree ("team_id","et_date","type");--> statement-breakpoint
CREATE INDEX "transactions_league_created_idx" ON "transactions" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "roster_entries_league_player_idx" ON "roster_entries" USING btree ("league_id","player_id");