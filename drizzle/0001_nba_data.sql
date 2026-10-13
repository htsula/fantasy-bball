CREATE TABLE "nba_games" (
	"id" integer PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"season_type" integer NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"status_detail" text,
	"period" integer,
	"clock" text,
	"finished_at" timestamp with time zone,
	"stats_final" boolean DEFAULT false NOT NULL,
	"stats_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_injuries" (
	"player_id" integer PRIMARY KEY NOT NULL,
	"team_id" integer,
	"status" text NOT NULL,
	"detail" text,
	"short_comment" text,
	"long_comment" text,
	"date" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_news" (
	"id" text PRIMARY KEY NOT NULL,
	"headline" text NOT NULL,
	"description" text,
	"published" timestamp with time zone NOT NULL,
	"link" text,
	"image" text,
	"related_player_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"related_team_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_players" (
	"id" integer PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"team_id" integer,
	"positions" text[] DEFAULT '{}'::text[] NOT NULL,
	"espn_position" text,
	"jersey" text,
	"headshot_url" text,
	"height_inches" integer,
	"weight_lbs" integer,
	"age" integer,
	"birth_date" date,
	"experience_years" integer,
	"active" boolean DEFAULT true NOT NULL,
	"injury_status" text,
	"injury_detail" text,
	"injury_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"abbrev" text NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"logo" text,
	"color" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_game_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"minutes" integer,
	"fgm" integer DEFAULT 0 NOT NULL,
	"fga" integer DEFAULT 0 NOT NULL,
	"ftm" integer DEFAULT 0 NOT NULL,
	"fta" integer DEFAULT 0 NOT NULL,
	"tpm" integer DEFAULT 0 NOT NULL,
	"tpa" integer DEFAULT 0 NOT NULL,
	"reb" integer DEFAULT 0 NOT NULL,
	"oreb" integer DEFAULT 0 NOT NULL,
	"dreb" integer DEFAULT 0 NOT NULL,
	"ast" integer DEFAULT 0 NOT NULL,
	"stl" integer DEFAULT 0 NOT NULL,
	"blk" integer DEFAULT 0 NOT NULL,
	"turnovers" integer DEFAULT 0 NOT NULL,
	"pf" integer DEFAULT 0 NOT NULL,
	"pts" integer DEFAULT 0 NOT NULL,
	"dnp" boolean DEFAULT false NOT NULL,
	"dnp_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_snapshots" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "raw_snapshots_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"error" text,
	"counts" jsonb
);
--> statement-breakpoint
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_game_id_nba_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nba_games_start_time_idx" ON "nba_games" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "nba_games_status_idx" ON "nba_games" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nba_games_home_team_idx" ON "nba_games" USING btree ("home_team_id","start_time");--> statement-breakpoint
CREATE INDEX "nba_games_away_team_idx" ON "nba_games" USING btree ("away_team_id","start_time");--> statement-breakpoint
CREATE INDEX "nba_news_published_idx" ON "nba_news" USING btree ("published");--> statement-breakpoint
CREATE INDEX "nba_players_team_id_idx" ON "nba_players" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "nba_players_full_name_lower_idx" ON "nba_players" USING btree (lower("full_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "player_game_stats_game_player_idx" ON "player_game_stats" USING btree ("game_id","player_id");--> statement-breakpoint
CREATE INDEX "player_game_stats_player_idx" ON "player_game_stats" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "sync_runs_job_started_idx" ON "sync_runs" USING btree ("job","started_at");