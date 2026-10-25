"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  Terminal as TerminalIcon,
  Play,
  Pause,
  Trash2,
  ArrowDownCircle,
  Search,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface LiveConsoleTerminalProps {
  nodeId: string;
  nodeName: string;
  nodeUrl: string;
}

export function LiveConsoleTerminal({ nodeId, nodeName, nodeUrl }: LiveConsoleTerminalProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [search, setSearch] = useState("");
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let isMounted = true;
    const sseUrl = `/api/ninerouter/nodes/${encodeURIComponent(nodeId)}/logs/stream`;
    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (isMounted) setConnected(true);
    };

    es.onerror = () => {
      if (isMounted) setConnected(false);
    };

    es.onmessage = (event) => {
      if (!isMounted || !event.data) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "clear") {
          setLogs([]);
          return;
        }

        // When backend reconnects and emits "init", replace buffer with fresh snapshot to prevent duplicates
        if (payload.type === "init" && Array.isArray(payload.logs)) {
          setLogs(payload.logs.slice(-1000));
          return;
        }

        let incoming: string[] = [];
        if (payload.type === "line" && payload.line) {
          incoming = [payload.line];
        } else if (payload.type === "lines" && Array.isArray(payload.lines)) {
          incoming = payload.lines;
        }

        if (incoming.length > 0) {
          setLogs((prev) => {
            const next = [...prev, ...incoming];
            return next.length > 1000 ? next.slice(-1000) : next;
          });
        }
      } catch {
        // Fallback for raw text
        setLogs((prev) => {
          const next = [...prev, event.data];
          return next.length > 1000 ? next.slice(-1000) : next;
        });
      }
    };

    return () => {
      isMounted = false;
      es.close();
      eventSourceRef.current = null;
    };
  }, [nodeId]);

  useEffect(() => {
    if (autoScroll && !isPaused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll, isPaused]);

  const filteredLogs = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.toLowerCase();
    return logs.filter((line) => line.toLowerCase().includes(q));
  }, [logs, search]);

  const renderLogLine = (line: string, index: number) => {
    let colorClass = "text-zinc-300";
    if (line.includes("DONE") || line.includes("200 OK") || line.includes("success")) {
      colorClass = "text-emerald-400 font-medium";
    } else if (line.includes("POST ") || line.includes("GET ")) {
      colorClass = "text-[#FF8555] font-medium";
    } else if (line.includes("WARN") || line.includes("TTFT")) {
      colorClass = "text-amber-400";
    } else if (line.includes("ERR") || line.includes("fail") || line.includes("500")) {
      colorClass = "text-rose-400 font-semibold";
    } else if (line.includes("[PROXY]")) {
      colorClass = "text-[#FF5B22] font-medium";
    }

    return (
      <div key={index} className={`font-mono text-[11px] leading-relaxed break-all ${colorClass}`}>
        {line}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[420px] rounded-xl border border-[#23232C] bg-[#0A0A0E] shadow-xl overflow-hidden font-mono">
      {/* Header toolbar */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[#23232C] bg-[#131318]">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="size-4 text-[#FF5B22] shrink-0" />
          <span className="font-semibold text-xs text-zinc-100 truncate">{nodeName}</span>
          <span className="text-[10px] text-zinc-500 font-mono hidden sm:inline">{nodeUrl}</span>
          <Badge
            variant="outline"
            className={`text-[10px] px-2 py-0.5 border font-mono ${
              connected
                ? "border-[#FF5B22]/40 text-[#FF5B22] bg-[#FF5B22]/10"
                : "border-rose-500/40 text-rose-400 bg-rose-500/10"
            }`}
          >
            {connected ? (
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-[#FF5B22] shadow-[0_0_8px_#FF5B22] animate-pulse" />
                Live SSE
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <WifiOff className="size-2.5" /> Offline
              </span>
            )}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="relative w-28 sm:w-36">
            <Search className="size-3 text-zinc-500 absolute left-2 top-2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="h-7 pl-6 pr-2 text-[10px] font-mono bg-[#0A0A0E] border-[#23232C] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-1 focus-visible:ring-[#FF5B22]/40 focus-visible:border-[#FF5B22]/60 rounded-lg"
            />
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? "Disable Auto-scroll" : "Enable Auto-scroll"}
            className={`h-7 px-2 text-xs border rounded-lg transition-colors ${
              autoScroll
                ? "text-[#FF5B22] bg-[#FF5B22]/10 border-[#FF5B22]/40 shadow-sm"
                : "text-zinc-400 border-[#23232C] bg-[#181820] hover:text-[#FF5B22] hover:border-[#FF5B22]/40"
            }`}
          >
            <ArrowDownCircle className="size-3.5" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsPaused((v) => !v)}
            title={isPaused ? "Resume" : "Pause"}
            className={`h-7 px-2 text-xs border rounded-lg transition-colors ${
              isPaused
                ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/40"
                : "text-zinc-300 border-[#23232C] bg-[#181820] hover:text-[#FF5B22] hover:border-[#FF5B22]/40"
            }`}
          >
            {isPaused ? (
              <Play className="size-3.5 text-emerald-400" />
            ) : (
              <Pause className="size-3.5" />
            )}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLogs([])}
            title="Clear"
            className="h-7 px-2 text-xs border border-[#23232C] bg-[#181820] text-zinc-400 hover:text-rose-400 hover:border-rose-500/40 rounded-lg transition-colors"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Terminal logs body */}
      <div
        ref={containerRef}
        className="flex-1 p-3.5 overflow-y-auto space-y-0.5 bg-[#0A0A0E] selection:bg-[#FF5B22]/30 selection:text-white"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-xs font-mono">
            {connected ? "Listening for live server logs..." : "Connecting to 9router SSE..."}
          </div>
        ) : (
          filteredLogs.map(renderLogLine)
        )}
      </div>
    </div>
  );
}
