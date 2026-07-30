"use client";

import { Settings, RotateCcw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
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

function Row({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {title}
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function SettingsDrawer({ settings, update, reset }: SettingsDrawerProps) {
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
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4 text-primary" />
            Settings
          </SheetTitle>
          <SheetDescription>
            Preferences are stored locally in your browser.
          </SheetDescription>
        </SheetHeader>

        <div className="divide-y divide-border px-5">
          {/* Download mode */}
          <div className="py-3">
            <Label className="text-sm font-medium text-foreground">
              Download mode
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose what happens when you click the Download button.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  {
                    key: "progress",
                    label: "With progress",
                    desc: "Show a dialog with speed & ETA",
                  },
                  {
                    key: "direct",
                    label: "Direct",
                    desc: "Start the browser download",
                  },
                ] as const
              ).map((opt) => {
                const active = settings.downloadMode === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => update({ downloadMode: opt.key })}
                    className={cn(
                      "rounded-md border p-2.5 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                        : "border-border bg-card hover:border-primary/40"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        {opt.label}
                      </span>
                      {active && (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {opt.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Auto-watch */}
          <Row
            id="auto-watch"
            title="Auto-open preview"
            description="Open the watch dialog automatically after a successful fetch."
          >
            <Switch
              id="auto-watch"
              checked={settings.autoWatch}
              onCheckedChange={(v) => update({ autoWatch: v })}
              aria-label="Auto-open preview"
            />
          </Row>

          {/* Best badge */}
          <Row
            id="show-best-badge"
            title="Best badge"
            description="Highlight the highest-quality source with a 'Best' pill."
          >
            <Switch
              id="show-best-badge"
              checked={settings.showBestBadge}
              onCheckedChange={(v) => update({ showBestBadge: v })}
              aria-label="Show best badge"
            />
          </Row>

          {/* History limit */}
          <div className="py-3">
            <Label htmlFor="history-limit" className="text-sm font-medium text-foreground">
              History limit
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Number of recent fetches shown in the panel (5-100).
            </p>
            <div className="mt-2 flex items-center gap-2">
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
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <span className="w-10 text-right text-xs font-semibold tabular-nums text-foreground">
                {settings.historyLimit}
              </span>
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
            Reset to defaults
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
