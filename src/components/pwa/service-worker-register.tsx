"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Registers /sw.js (push + offline page). When a new version of the worker takes over while the app is open
 * (installed PWAs can stay open for days), offers a reload so nobody keeps running stale code.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let shown = false;
    const onControllerChange = () => {
      if (!hadController || shown) return; // first install, not an update
      shown = true;
      toast("A new version is available.", { duration: Infinity, action: { label: "Reload", onClick: () => window.location.reload() } });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let registration: ServiceWorkerRegistration | undefined;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((r) => {
        registration = r;
      })
      .catch((err) => {
        console.warn("Service worker registration failed", err);
      });
    // Check for a new worker whenever the app comes back to the foreground.
    const onVisible = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
