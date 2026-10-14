"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Bell } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { buttonVariants } from "@/components/ui/button";

async function fetchCount(url: string): Promise<{ count: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("unread count failed");
  return res.json();
}

/** Header bell: unread count polled every 30s (and on focus / navigation remounts). */
export function NotificationBell({ initialCount }: { initialCount: number }) {
  const pathname = usePathname();
  const { data, mutate } = useSWR("/api/notifications/unread", fetchCount, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    fallbackData: { count: initialCount },
  });
  // Also refresh on every navigation (e.g. after marking notifications read).
  useEffect(() => {
    void mutate();
  }, [pathname, mutate]);
  const count = data?.count ?? 0;
  return (
    <Link
      href="/notifications"
      className={buttonVariants({ variant: "ghost", size: "icon" }) + " relative"}
      aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
      data-testid="notification-bell"
    >
      <Bell />
      {count > 0 && (
        <span
          data-testid="bell-count"
          className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

/** Rendered on the notifications page so the bell reflects reads made there immediately. */
export function BellSync({ unread }: { unread: number }) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    void mutate("/api/notifications/unread", { count: unread }, { revalidate: false });
  }, [unread, mutate]);
  return null;
}
