"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { CheckIcon, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DEFAULT_THEME, THEMES } from "@/lib/themes";

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? DEFAULT_THEME) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon-sm" aria-label="Theme" data-testid="theme-picker" />}>
        <Palette />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.id} onClick={() => setTheme(t.id)} data-testid={`theme-${t.id}`} aria-current={current === t.id ? "true" : undefined}>
            <span
              aria-hidden
              className="flex size-5 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/20"
              style={{ backgroundColor: t.swatch.background }}
            >
              <span className="ml-auto h-full w-1/2" style={{ backgroundColor: t.swatch.primary }} />
            </span>
            <span>{t.label}</span>
            {current === t.id && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
