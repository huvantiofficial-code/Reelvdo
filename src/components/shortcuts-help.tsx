"use client";

import { useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { describeCombo, type ShortcutBinding } from "@/hooks/use-keyboard-shortcuts";

interface ShortcutsHelpProps {
  bindings: ShortcutBinding[];
  labels: string[];
}

export function ShortcutsHelp({ bindings, labels }: ShortcutsHelpProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          className="h-9 w-9 text-muted-foreground hover:text-foreground"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-64 p-0"
      >
        <div className="border-b border-border px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Keyboard className="h-3.5 w-3.5 text-primary" />
            Keyboard shortcuts
          </p>
        </div>
        <ul className="divide-y divide-border">
          {bindings.map((b, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="text-xs text-muted-foreground">{labels[i]}</span>
              <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground shadow-[inset_0_-1px_0_oklch(0.5_0.02_162/0.1)]">
                {describeCombo(b)}
              </kbd>
            </li>
          ))}
        </ul>
        <div className="border-t border-border bg-muted/30 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground/70">
            Shortcuts work anywhere on this page.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
