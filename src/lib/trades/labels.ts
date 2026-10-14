import type { TradeStatus } from "@/db/schema";

export const TRADE_STATUS_LABEL: Record<TradeStatus, string> = {
  proposed: "Proposed",
  countered: "Countered",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  pending_review: "Under review",
  vetoed: "Vetoed",
  executed: "Completed",
  invalidated: "Invalidated",
  reversed: "Reversed",
};

export const OPEN_STATUSES: TradeStatus[] = ["proposed", "pending_review"];
