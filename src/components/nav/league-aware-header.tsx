"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Inside a league (/leagues/<id>/...) the league header replaces the site header, so render nothing there. */
export function LeagueAwareHeader({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const inLeague = /^\/leagues\/(?!new(?:\/|$))[^/]+/.test(pathname);
  return inLeague ? null : <>{children}</>;
}
