"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";

export type NavItem = {
  href: string;
  label: string;
  testId?: string;
  /** Extra content after the label (e.g. a count badge). */
  badge?: ReactNode;
  /** Only highlight on an exact path match (e.g. a league's Overview). */
  exact?: boolean;
};

/**
 * A single-row navigation that scrolls sideways when it does not fit (phones), highlights the current page
 * and keeps the active link in view. Scrollbar hidden; the edges fade to hint at more.
 */
export function ScrollNav({ label, items, className }: { label: string; items: NavItem[]; className?: string }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const el = activeRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    // Scroll only the nav itself (scrollIntoView would also scroll the page).
    parent.scrollTo({ left: el.offsetLeft - parent.clientWidth / 2 + el.clientWidth / 2, behavior: "auto" });
  }, [pathname]);

  const isActive = (it: NavItem) => (it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(`${it.href}/`));
  // The longest matching href wins so "Players" does not light up under a deeper sibling.
  const best = items.filter(isActive).sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav aria-label={label} className={cn("scroll-nav -mx-4 flex flex-nowrap gap-1 overflow-x-auto px-4", className)}>
      {items.map((it) => {
        const active = it === best;
        return (
          <Link
            key={it.href}
            href={it.href}
            ref={active ? activeRef : undefined}
            aria-current={active ? "page" : undefined}
            data-testid={it.testId}
            className={cn(buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }), "shrink-0", active && "font-semibold")}
          >
            {it.label}
            {it.badge}
          </Link>
        );
      })}
    </nav>
  );
}
