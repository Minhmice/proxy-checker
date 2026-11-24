"use client";

import { useEffect, useState } from "react";
import { BarChart3, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();

  return (
    <CommandDialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      title="Navigation"
      description="Quickly navigate application views"
    >
      <CommandInput placeholder="Type a command or search navigation..." />
      <CommandList className="max-h-[360px] overflow-y-auto">
        <CommandEmpty>No matching commands found.</CommandEmpty>
        <CommandGroup heading="Quick Navigation">
          <CommandItem
            value="dashboard metrics token cost telemetry analytics"
            onSelect={() => {
              onClose();
              router.push("/");
            }}
            className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
          >
            <BarChart3 className="size-4 shrink-0 text-primary" />
            <span className="font-medium text-sm text-foreground">Dashboard</span>
          </CommandItem>
          <CommandItem
            value="settings configuration credentials runtime rotator"
            onSelect={() => {
              onClose();
              router.push("/settings");
            }}
            className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
          >
            <Settings className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium text-sm text-foreground">Settings</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    open,
    setOpen,
    close: () => setOpen(false),
  };
}
