"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type ThemePreference = "dark" | "light" | "system";

const storageKey = "reviewrouter-theme";
const preferences: readonly ThemePreference[] = ["dark", "light", "system"];

const preferenceLabels: Record<ThemePreference, string> = {
  dark: "Dark theme",
  light: "Light theme",
  system: "Use system theme",
};

export function ThemeToggle(): React.ReactElement {
  const [preference, setPreference] = useState<ThemePreference>("dark");

  useEffect(() => {
    const stored = readStoredPreference();
    setPreference(stored);
    applyThemePreference(stored);

    const media = window.matchMedia("(prefers-color-scheme: light)");
    function syncSystemTheme(): void {
      if (readStoredPreference() === "system") applyThemePreference("system");
    }

    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  const Icon = useMemo(() => {
    if (preference === "light") return Sun;
    if (preference === "system") return Monitor;
    return Moon;
  }, [preference]);

  function cyclePreference(): void {
    const next =
      preferences[(preferences.indexOf(preference) + 1) % preferences.length] ??
      "dark";
    setPreference(next);
    localStorage.setItem(storageKey, next);
    applyThemePreference(next);
  }

  return (
    <button
      type="button"
      aria-label={preferenceLabels[preference]}
      title={preferenceLabels[preference]}
      onClick={cyclePreference}
      className="inline-grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-200/15 bg-white/[0.035] text-cyan-100 transition hover:border-cyan-200/40 hover:bg-cyan-300/[0.08] hover:text-cyan-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

function readStoredPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "dark";
  const stored = localStorage.getItem(storageKey);
  return isThemePreference(stored) ? stored : "dark";
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

function applyThemePreference(preference: ThemePreference): void {
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
}
