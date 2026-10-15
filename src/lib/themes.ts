export type ThemeId = "hardwood" | "courtside" | "varsity" | "arena-night" | "neon-court";

export type ThemeDef = {
  id: ThemeId;
  label: string;
  dark: boolean;
  /** Swatch colors for the picker: the theme's background and primary. */
  swatch: { background: string; primary: string };
};

export const DEFAULT_THEME: ThemeId = "varsity";

export const THEMES: readonly ThemeDef[] = [
  { id: "hardwood", label: "Hardwood", dark: false, swatch: { background: "oklch(0.982 0.01 80)", primary: "oklch(0.64 0.19 45)" } },
  { id: "courtside", label: "Courtside", dark: false, swatch: { background: "oklch(0.98 0.006 250)", primary: "oklch(0.5 0.2 262)" } },
  { id: "varsity", label: "Varsity", dark: false, swatch: { background: "oklch(0.978 0.012 95)", primary: "oklch(0.44 0.11 158)" } },
  { id: "arena-night", label: "Arena Night", dark: true, swatch: { background: "oklch(0.17 0.03 262)", primary: "oklch(0.73 0.17 52)" } },
  { id: "neon-court", label: "Neon Court", dark: true, swatch: { background: "oklch(0.155 0.006 150)", primary: "oklch(0.88 0.2 130)" } },
];

export const THEME_IDS = THEMES.map((t) => t.id);

/** next-themes `value` map: theme id -> html class (one token; the `dark:` variant in globals.css matches the dark theme classes). */
export const THEME_CLASS_VALUES: Record<string, string> = Object.fromEntries(
  THEMES.map((t) => [t.id, `theme-${t.id}`]),
);
