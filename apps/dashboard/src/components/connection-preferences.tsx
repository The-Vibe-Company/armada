"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** The same device preference as the shell's theme menu. */
export function ConnectionPreferences() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <section aria-labelledby="connection-preferences" className="space-y-3">
      <h2 id="connection-preferences" className="text-base font-semibold">
        Preferences
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-[10px] border bg-card px-4 py-3.5">
        <div className="space-y-0.5">
          <p className="text-[13.5px] font-medium">Theme</p>
          <p className="text-xs text-muted-foreground">Applies on this device.</p>
        </div>
        <fieldset className="inline-flex gap-0.5 rounded-lg bg-muted p-[3px]" aria-label="Theme">
          {(["light", "dark", "system"] as const).map((value) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={mounted && theme === value}
              className="h-7 rounded-md px-3 text-[13px] aria-pressed:bg-card aria-pressed:shadow-xs"
              onClick={() => setTheme(value)}
            >
              {value.charAt(0).toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
