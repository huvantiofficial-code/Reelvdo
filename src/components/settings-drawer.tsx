"use client";

import { Settings, RotateCcw, Check, Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import { useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

interface SettingsDrawerProps {
  settings: ReturnType<typeof useSettings>["settings"];
  update: ReturnType<typeof useSettings>["update"];
  reset: ReturnType<typeof useSettings>["reset"];
}

const DOWNLOAD_MODES = [
  { key: "progress", label: "Progress" },
  { key: "direct", label: "Direct" },
] as const;

const THEMES = [
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "system", label: "Auto", icon: Monitor },
] as const;

export function SettingsDrawer({ settings, update, reset }: SettingsDrawerProps) {
  const { theme, setTheme } = useTheme();

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          title="Settings"
          className="h-9 w-9 text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border pr-10 px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4 text-primary" />
            Settings
          </SheetTitle>
        </SheetHeader>

        <div className="scroll-thin flex-1 divide-y divide-border overflow-y-auto px-5">
          {/* Download mode */}
          <div className="py-4">
            <Label className="text-xs font-medium text-muted-foreground">
              Download mode
            </Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {DOWNLOAD_MODES.map((opt) => {
                const active = settings.downloadMode === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => update({ downloadMode: opt.key })}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/20"
                        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    {opt.label}
                    {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* History limit */}
          <div className="py-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="history-limit" className="text-xs font-medium text-muted-foreground">
                History limit
              </Label>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {settings.historyLimit}
              </span>
            </div>
            <input
              id="history-limit"
              type="range"
              min={5}
              max={100}
              step={5}
              value={settings.historyLimit}
              onChange={(e) =>
                update({ historyLimit: parseInt(e.target.value, 10) })
              }
              className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
          </div>

          {/* Theme */}
          <div className="py-4">
            <Label className="text-xs font-medium text-muted-foreground">
              Theme
            </Label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {THEMES.map((opt) => {
                const active = theme === opt.key;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setTheme(opt.key)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-[11px] font-medium transition-colors",
                      active
                        ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/20"
                        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <SheetFooter className="border-t border-border px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={reset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
