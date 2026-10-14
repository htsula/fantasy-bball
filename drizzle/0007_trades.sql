CREATE TABLE "trade_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_items" (
	"trade_id" uuid NOT NULL,
	"player_id" integer NOT NULL,
	"from_team_id" uuid NOT NULL,
	"to_team_id" uuid NOT NULL,
	CONSTRAINT "trade_items_trade_id_player_id_pk" PRIMARY KEY("trade_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "trade_votes" (
	"trade_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"voter_user_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"kind" text DEFAULT 'trade' NOT NULL,
	"proposer_team_id" uuid NOT NULL,
	"receiver_team_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"message" text,
	"countered_from" uuid,
	"proposed_by" uuid,
	"responded_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"review_ends_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_reason" text,
	"reversed_by_trade_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_block" ADD CONSTRAINT "trade_block_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_block" ADD CONSTRAINT "trade_block_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_block" ADD CONSTRAINT "trade_block_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_player_id_nba_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."nba_players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_to_team_id_teams_id_fk" FOREIGN KEY ("to_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_voter_user_id_users_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposer_team_id_teams_id_fk" FOREIGN KEY ("proposer_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_receiver_team_id_teams_id_fk" FOREIGN KEY ("receiver_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_countered_from_trades_id_fk" FOREIGN KEY ("countered_from") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_reversed_by_trade_id_trades_id_fk" FOREIGN KEY ("reversed_by_trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_block_team_player_idx" ON "trade_block" USING btree ("team_id","player_id");--> statement-breakpoint
CREATE INDEX "trade_block_league_idx" ON "trade_block" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "trade_items_trade_idx" ON "trade_items" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trade_items_player_idx" ON "trade_items" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_votes_trade_team_idx" ON "trade_votes" USING btree ("trade_id","team_id");--> statement-breakpoint
CREATE INDEX "trades_league_status_idx" ON "trades" USING btree ("league_id","status");--> statement-breakpoint
CREATE INDEX "trades_status_idx" ON "trades" USING btree ("status");