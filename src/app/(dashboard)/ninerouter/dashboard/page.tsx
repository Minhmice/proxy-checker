"use client";

import React, { useState } from "react";
import { BarChart3, RefreshCw, Layers } from "lucide-react";
import { motion, type Variants } from "motion/react";
import { MiniUsageCard } from "@/components/ninerouter/mini-usage-card";
import { LiveConsoleTerminal } from "@/components/ninerouter/live-console-terminal";
import { Button } from "@/components/ui/button";
const PERIODS = [
  { id: "today", label: "Today" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "all", label: "All" },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
};

export default function NineRouterDashboardPage() {
  const [period, setPeriod] = useState("today");
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6 pb-12"
    >
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#23232C] pb-5">
        <div>
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-zinc-100 flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30 shadow-[0_0_16px_rgba(255,91,34,0.25)]">
              <BarChart3 className="size-5" />
            </span>
            9Router Dual-Node Dashboard
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5">
            Real-time usage telemetry, token consumption and live SSE server consoles for Master &
            VPN nodes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Period selector - High contrast tab pill style */}
          <div className="flex items-center bg-[#121217] border border-[#23232C] rounded-xl p-1 gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="ghost"
                onClick={() => setPeriod(p.id)}
                className={`h-7 px-3 text-xs font-semibold rounded-lg transition-all ${
                  period === p.id
                    ? "bg-[#FF5B22] text-white shadow-md shadow-[#FF5B22]/25 font-bold"
                    : "text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
                }`}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-300 hover:text-white hover:border-[#FF5B22]/40 hover:bg-[#181820] gap-1.5 text-xs font-semibold rounded-xl transition-colors"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Top Row: 2 Mini Usage Dashboards Side-by-Side */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Layers className="size-4 text-[#FF5B22]" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
            Node Telemetry & Consumption
          </h2>
        </div>

        <motion.div
          className="grid grid-cols-1 lg:grid-cols-2 gap-5"
          key={refreshKey}
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVariants}>
            <MiniUsageCard
              nodeId="server-lan"
              nodeName="Master Node (LAN)"
              nodeUrl="http://192.168.1.54:20128"
              period={period}
            />
          </motion.div>
          <motion.div variants={itemVariants}>
            <MiniUsageCard
              nodeId="server-vpn"
              nodeName="Tailscale Node (VPN)"
              nodeUrl="http://100.73.175.42:20128"
              period={period}
            />
          </motion.div>
        </motion.div>
      </div>

      {/* Bottom Row: 2 Live Console Log Terminals Side-by-Side */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-3">
          <span className="size-2 rounded-full bg-[#FF5B22] shadow-[0_0_8px_#FF5B22] animate-pulse" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
            Live Server Console Logs (Real-time SSE)
          </h2>
        </div>

        <motion.div
          className="grid grid-cols-1 lg:grid-cols-2 gap-5"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVariants}>
            <LiveConsoleTerminal
              nodeId="server-lan"
              nodeName="Master Node (192.168.1.54)"
              nodeUrl="192.168.1.54:20128"
            />
          </motion.div>
          <motion.div variants={itemVariants}>
            <LiveConsoleTerminal
              nodeId="server-vpn"
              nodeName="Tailscale Node (100.73.175.42)"
              nodeUrl="100.73.175.42:20128"
            />
          </motion.div>
        </motion.div>
      </div>
    </motion.div>
  );
}
