"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Filter,
  Globe,
  HelpCircle,
  Play,
  RotateCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  StopCircle,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import {
  cancelAuditorJob,
  createAuditorJob,
  deleteAuditorHistory,
  downloadAuditorExport,
  fetchAuditorHistory,
  fetchAuditorJob,
} from "@/lib/auditor-api";
import type {
  AuditorJob,
  AuditorJobMode,
  AuditorJobOptions,
  AuditorJobResult,
  AuditVerdict,
  ProxyAuditResult,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import "@/components/auditor.css";

const VERDICT_LABELS: Record<AuditVerdict, { label: string; class: string; icon: typeof ShieldCheck }> = {
  PASS: { label: "Safe for measured conditions", class: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30", icon: CheckCircle2 },
  WARN: { label: "Review warnings", class: "bg-amber-500/10 text-amber-400 border-amber-500/30", icon: AlertTriangle },
  FAIL: { label: "Rejected by safety policy", class: "bg-rose-500/10 text-rose-400 border-rose-500/30", icon: XCircle },
  UNKNOWN: { label: "Insufficient evidence", class: "bg-slate-500/10 text-slate-400 border-slate-500/30", icon: HelpCircle },
};

function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return "Unknown";
  return `${Math.round(score)}/100`;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export default function AuditorPage() {
  const { password } = useAuth();

  // Top-level Navigation
  const [pageView, setPageView] = useState<"current" | "history">("current");

  // Setup Form State
  const [mode, setMode] = useState<AuditorJobMode>("single");
  const [singleProxy, setSingleProxy] = useState("");
  const [bulkFile, setBulkFile] = useState<{ name: string; content: string; count: number } | null>(null);
  const [attempts, setAttempts] = useState(5);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [concurrency, setConcurrency] = useState(5);
  const [reputation, setReputation] = useState(true);
  const [browserAudit, setBrowserAudit] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active Job State
  const [currentJob, setCurrentJob] = useState<AuditorJob | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [historyList, setHistoryList] = useState<AuditorJob[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Filter & Search State
  const [searchQuery, setSearchQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"all" | AuditVerdict>("all");
  const [sortBy, setSortBy] = useState<"completion" | "safety" | "latency" | "reputation" | "reliability">("completion");

  // Evidence Drawer State
  const [inspectResult, setInspectResult] = useState<ProxyAuditResult | null>(null);
  const [inspectIndex, setInspectIndex] = useState<number | null>(null);

  // Delete History Confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const isJobActive = currentJob && (currentJob.status === "queued" || currentJob.status === "running" || currentJob.status === "cancelling");

  // Load Job
  const loadJob = useCallback(
    async (id: string, signal?: AbortSignal) => {
      if (!password || !id) return;
      try {
        const job = await fetchAuditorJob(password, id, signal);
        setCurrentJob(job);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Failed to load job:", err);
        }
      }
    },
    [password]
  );

  // Polling for active job
  useEffect(() => {
    if (!password || !selectedJobId) return;
    const controller = new AbortController();
    const delay = isJobActive ? 1200 : 15000;
    void loadJob(selectedJobId, controller.signal);
    const timer = window.setInterval(() => void loadJob(selectedJobId, controller.signal), delay);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [password, selectedJobId, isJobActive, loadJob]);

  // Load History
  const loadHistory = useCallback(async () => {
    if (!password) return;
    setLoadingHistory(true);
    try {
      const list = await fetchAuditorHistory(password, 50);
      setHistoryList(list);
      // If no current job selected, pick the latest one
      if (!selectedJobId && list.length > 0) {
        setSelectedJobId(list[0]!.id);
      }
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoadingHistory(false);
    }
  }, [password, selectedJobId]);

  useEffect(() => {
    if (pageView === "history") {
      void loadHistory();
    }
  }, [pageView, loadHistory]);

  // Start Audit
  async function handleStartAudit() {
    if (!password) {
      toast.error("Control password required");
      return;
    }

    const options: AuditorJobOptions = {
      attempts: Math.max(1, Math.min(10, attempts)),
      timeoutMs: Math.max(2000, Math.min(60000, timeoutMs)),
      concurrency: Math.max(1, Math.min(20, concurrency)),
      reputation,
      browser: browserAudit,
    };

    try {
      let job: AuditorJob;
      if (mode === "single") {
        if (!singleProxy.trim()) {
          toast.error("Please provide a proxy URL");
          return;
        }
        job = await createAuditorJob(password, {
          mode: "single",
          proxy: singleProxy.trim(),
          options,
        });
      } else {
        if (!bulkFile) {
          toast.error("Please upload a .txt proxy list");
          return;
        }
        job = await createAuditorJob(password, {
          mode: "bulk",
          name: bulkFile.name,
          content: bulkFile.content,
          options,
        });
      }

      setCurrentJob(job);
      setSelectedJobId(job.id);
      setPageView("current");
      toast.success(`Audit job started: ${job.sourceName}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Cancel Audit
  async function handleCancelAudit() {
    if (!password || !currentJob) return;
    try {
      const job = await cancelAuditorJob(password, currentJob.id);
      setCurrentJob(job);
      toast.message("Audit cancellation requested");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // File Upload Handlers
  async function handleFileUpload(file: File) {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      toast.error("Only .txt proxy files are supported");
      return;
    }
    if (file.size > 5_000_000) {
      toast.error("File exceeds 5 MB limit");
      return;
    }
    const text = await file.text();
    const count = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
    setBulkFile({ name: file.name, content: text, count });
    toast.info(`Loaded ${file.name} (${count} proxies)`);
  }

  // Export Handlers
  async function handleExport(format: "json" | "csv", jobId?: string) {
    const id = jobId || currentJob?.id;
    if (!password || !id) return;
    try {
      const { blob, filename } = await downloadAuditorExport(password, id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Delete History
  async function handleDeleteHistory(id: string) {
    if (!password) return;
    try {
      await deleteAuditorHistory(password, id);
      toast.success("Audit history deleted");
      if (selectedJobId === id) {
        setSelectedJobId(null);
        setCurrentJob(null);
      }
      setDeleteConfirmId(null);
      void loadHistory();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Filtered & Sorted Results
  const filteredResults = useMemo(() => {
    if (!currentJob) return [];
    let list = [...currentJob.results];

    // Verdict filter
    if (verdictFilter !== "all") {
      list = list.filter((r) => r.result?.verdict === verdictFilter);
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((r) => {
        if (!r.result) return r.error?.toLowerCase().includes(q);
        const p = r.result;
        return (
          p.proxy.host.toLowerCase().includes(q) ||
          p.exitIp?.ip?.toLowerCase().includes(q) ||
          p.network?.asn?.toLowerCase().includes(q) ||
          p.network?.organization?.toLowerCase().includes(q) ||
          p.exitIp?.country?.toLowerCase().includes(q) ||
          p.riskFactors.some((rf) => rf.code?.toLowerCase().includes(q) || rf.title.toLowerCase().includes(q))
        );
      });
    }

    // Sort
    list.sort((a, b) => {
      if (sortBy === "safety") {
        const sA = a.result?.scores.overallSafety ?? -1;
        const sB = b.result?.scores.overallSafety ?? -1;
        return sB - sA;
      }
      if (sortBy === "latency") {
        const lA = a.result?.connectivity?.latencyMs ?? 999999;
        const lB = b.result?.connectivity?.latencyMs ?? 999999;
        return lA - lB;
      }
      if (sortBy === "reputation") {
        const rA = a.result?.scores.reputation ?? -1;
        const rB = b.result?.scores.reputation ?? -1;
        return rB - rA;
      }
      if (sortBy === "reliability") {
        const relA = a.result?.scores.reliability ?? -1;
        const relB = b.result?.scores.reliability ?? -1;
        return relB - relA;
      }
      return a.index - b.index;
    });

    return list;
  }, [currentJob, verdictFilter, searchQuery, sortBy]);

  const progressPercent = currentJob && currentJob.total > 0
    ? Math.round((currentJob.checked / currentJob.total) * 100)
    : 0;

  return (
    <>
      <div className="auditor-page-header">
        <div>
          <h1>Proxy Safety Auditor</h1>
          <p>Measure transport security, privacy, reputation, and reliability before a proxy is trusted.</p>
        </div>
        <div className="flex items-center gap-2">
          {pageView === "history" ? (
            <Button
              variant="outline"
              onClick={() => setPageView("current")}
              className="min-h-[44px]"
            >
              <RotateCw size={14} className="mr-1.5" /> Back to audit
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setPageView("history")}
              className="min-h-[44px]"
            >
              <Clock size={14} className="mr-1.5" /> Audit history
            </Button>
          )}
        </div>
      </div>

      {pageView === "history" ? (
        <section className="auditor-setup-card" aria-label="Audit history records">
          <div className="flex items-center justify-between pb-4 border-b border-border/60 mb-4">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              Audit History ({historyList.length})
            </h2>
            <Button variant="ghost" size="sm" onClick={() => void loadHistory()} disabled={loadingHistory}>
              <RotateCw size={14} className={loadingHistory ? "animate-spin mr-1.5" : "mr-1.5"} /> Refresh
            </Button>
          </div>

          {historyList.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              <FileText size={32} className="mx-auto mb-3 opacity-40" />
              <p>No audit history recorded yet.</p>
              <Button variant="outline" className="mt-4" onClick={() => setPageView("current")}>
                Start your first audit
              </Button>
            </div>
          ) : (
            <div className="auditor-table-wrap">
              <table className="auditor-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Duration</th>
                    <th>Scope</th>
                    <th>Results</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyList.map((job) => (
                    <tr key={job.id} onClick={() => { setSelectedJobId(job.id); setPageView("current"); }}>
                      <td data-label="Source" className="font-semibold text-ink">
                        {job.sourceName || "Single proxy"}
                      </td>
                      <td data-label="Status">
                        <Badge variant="outline" className="text-xs uppercase font-mono">
                          {job.status}
                        </Badge>
                      </td>
                      <td data-label="Created" className="text-muted text-xs">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                      <td data-label="Duration" className="text-xs font-mono">
                        {formatDuration(job.finishedAt ? job.finishedAt - (job.startedAt || job.createdAt) : null)}
                      </td>
                      <td data-label="Scope" className="text-xs font-mono">
                        {job.checked} / {job.total}
                      </td>
                      <td data-label="Results">
                        <div className="flex items-center gap-1.5 text-xs font-mono">
                          <span className="text-emerald-400">{job.passCount}P</span>
                          <span className="text-amber-400">{job.warnCount}W</span>
                          <span className="text-rose-400">{job.failCount}F</span>
                          <span className="text-slate-400">{job.unknownCount}U</span>
                        </div>
                      </td>
                      <td data-label="Actions" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Export JSON"
                            onClick={() => handleExport("json", job.id)}
                            className="size-8"
                          >
                            <Download size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete record"
                            disabled={job.status === "running" || job.status === "cancelling"}
                            onClick={() => setDeleteConfirmId(job.id)}
                            className="size-8 hover:text-rose-400"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Setup / Configuration Form */}
          {!isJobActive ? (
            <section className="auditor-setup-card" aria-label="Audit configuration">
              <div className="auditor-mode-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "single"}
                  className={`auditor-mode-btn ${mode === "single" ? "is-active" : ""}`}
                  onClick={() => setMode("single")}
                >
                  <Globe size={16} /> Single proxy audit
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "bulk"}
                  className={`auditor-mode-btn ${mode === "bulk" ? "is-active" : ""}`}
                  onClick={() => setMode("bulk")}
                >
                  <FileText size={16} /> Bulk .txt file audit
                </button>
              </div>

              <div className="auditor-form-grid">
                <div>
                  {mode === "single" ? (
                    <div className="auditor-input-wrap">
                      <label htmlFor="auditor-proxy-input" className="auditor-label">
                        Proxy URL or Connection String
                      </label>
                      <Input
                        id="auditor-proxy-input"
                        placeholder="socks5://username:password@1.2.3.4:1080"
                        value={singleProxy}
                        onChange={(e) => setSingleProxy(e.target.value)}
                        className="font-mono text-xs min-h-[44px]"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        Supports HTTP, HTTPS, SOCKS4, and SOCKS5. Credentials are never leaked or stored in plain text.
                      </span>
                    </div>
                  ) : (
                    <div className="auditor-input-wrap">
                      <span className="auditor-label">Proxy List (.txt)</span>
                      <div
                        className={`auditor-dropzone ${dragActive ? "is-active" : ""}`}
                        tabIndex={0}
                        role="button"
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
                        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                        onDragOver={(e) => e.preventDefault()}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragActive(false);
                          const file = e.dataTransfer.files[0];
                          if (file) void handleFileUpload(file);
                        }}
                      >
                        <Upload size={24} className="text-muted-foreground" />
                        <strong className="text-xs font-semibold text-ink">
                          {bulkFile ? bulkFile.name : "Click to select or drop .txt file"}
                        </strong>
                        <span className="text-[11px] text-muted-foreground">
                          {bulkFile ? `${bulkFile.count} proxies detected` : "Max 5 MB, up to 10,000 proxies"}
                        </span>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".txt,text/plain"
                          className="sr-only"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void handleFileUpload(file);
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-4">
                  <div className="auditor-options-grid">
                    <div className="auditor-input-wrap">
                      <label htmlFor="auditor-attempts" className="auditor-label">
                        Attempts (1–10)
                      </label>
                      <Input
                        id="auditor-attempts"
                        type="number"
                        min={1}
                        max={10}
                        value={attempts}
                        onChange={(e) => setAttempts(Number(e.target.value))}
                        className="font-mono text-xs min-h-[44px]"
                      />
                    </div>
                    <div className="auditor-input-wrap">
                      <label htmlFor="auditor-timeout" className="auditor-label">
                        Timeout (ms)
                      </label>
                      <Input
                        id="auditor-timeout"
                        type="number"
                        min={2000}
                        max={60000}
                        step={1000}
                        value={timeoutMs}
                        onChange={(e) => setTimeoutMs(Number(e.target.value))}
                        className="font-mono text-xs min-h-[44px]"
                      />
                    </div>
                  </div>

                  {mode === "bulk" && (
                    <div className="auditor-input-wrap">
                      <label htmlFor="auditor-concurrency" className="auditor-label">
                        Network concurrency (1–20)
                      </label>
                      <Input
                        id="auditor-concurrency"
                        type="number"
                        min={1}
                        max={20}
                        value={concurrency}
                        onChange={(e) => setConcurrency(Number(e.target.value))}
                        className="font-mono text-xs min-h-[44px]"
                      />
                    </div>
                  )}

                  <div className="pt-2 border-t border-border/40 flex flex-col gap-2">
                    <label className="auditor-toggle-row cursor-pointer">
                      <span className="text-xs font-medium text-ink">External reputation lookups</span>
                      <input
                        type="checkbox"
                        checked={reputation}
                        onChange={(e) => setReputation(e.target.checked)}
                        className="size-4 rounded-sm border-border accent-primary cursor-pointer"
                      />
                    </label>

                    <label className="auditor-toggle-row cursor-pointer">
                      <div className="flex flex-col">
                        <span className="text-xs font-medium text-ink">Include browser leak audit</span>
                        <span className="text-[11px] text-muted-foreground">Tests WebRTC candidate exposure via Playwright</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={browserAudit}
                        onChange={(e) => setBrowserAudit(e.target.checked)}
                        className="size-4 rounded-sm border-border accent-primary cursor-pointer"
                      />
                    </label>
                  </div>

                  <Button
                    className="w-full min-h-[44px] font-semibold mt-2"
                    onClick={handleStartAudit}
                    disabled={mode === "single" ? !singleProxy.trim() : !bulkFile}
                  >
                    <Play size={15} className="mr-1.5" /> Run proxy audit
                  </Button>
                </div>
              </div>
            </section>
          ) : (
            /* Active Job Progress Strip */
            <section className="auditor-progress-card" aria-label="Audit progress">
              <div className="auditor-progress-header">
                <div className="flex items-center gap-3">
                  <div className="size-2 rounded-full bg-primary animate-ping" />
                  <div>
                    <h2 className="text-sm font-semibold text-ink leading-none">
                      Auditing {currentJob?.sourceName} ({progressPercent}%)
                    </h2>
                    <span className="text-xs text-muted-foreground mt-1 inline-block">
                      {currentJob?.checked} of {currentJob?.total} completed
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="min-h-[44px]"
                    onClick={handleCancelAudit}
                    disabled={currentJob?.status === "cancelling"}
                  >
                    <StopCircle size={15} className="mr-1.5" />
                    {currentJob?.status === "cancelling" ? "Cancelling..." : "Cancel audit"}
                  </Button>
                </div>
              </div>

              <Progress value={progressPercent} className="h-2" />
            </section>
          )}

          {/* Current Job Summary Metrics */}
          {currentJob && (
            <section className="auditor-summary-strip" aria-label="Audit summary counts">
              <div className="auditor-summary-box is-pass">
                <span>Pass</span>
                <strong>{currentJob.passCount}</strong>
              </div>
              <div className="auditor-summary-box is-warn">
                <span>Warn</span>
                <strong>{currentJob.warnCount}</strong>
              </div>
              <div className="auditor-summary-box is-fail">
                <span>Fail</span>
                <strong>{currentJob.failCount}</strong>
              </div>
              <div className="auditor-summary-box is-unknown">
                <span>Unknown</span>
                <strong>{currentJob.unknownCount}</strong>
              </div>
              <div className="auditor-summary-box">
                <span>Total Checked</span>
                <strong>{currentJob.checked} / {currentJob.total}</strong>
              </div>
            </section>
          )}

          {/* Results Toolbar */}
          {currentJob && currentJob.results.length > 0 && (
            <div className="auditor-toolbar">
              <div className="auditor-filter-pills" role="group" aria-label="Filter results by verdict">
                {(["all", "PASS", "WARN", "FAIL", "UNKNOWN"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`auditor-pill ${verdictFilter === v ? "is-active" : ""}`}
                    onClick={() => setVerdictFilter(v)}
                  >
                    {v === "all" ? "All" : v}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative min-w-[200px]">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search host, exit IP, ASN..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 text-xs min-h-[44px]"
                  />
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExport("json")}
                  className="min-h-[44px]"
                >
                  <Download size={14} className="mr-1" /> Export JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExport("csv")}
                  className="min-h-[44px]"
                >
                  <Download size={14} className="mr-1" /> Export CSV
                </Button>
              </div>
            </div>
          )}

          {/* Results Table */}
          {currentJob && currentJob.results.length > 0 ? (
            <div className="auditor-table-wrap">
              <table className="auditor-table">
                <thead>
                  <tr>
                    <th>Proxy</th>
                    <th>Verdict</th>
                    <th>Safety Score</th>
                    <th>Transport</th>
                    <th>Privacy</th>
                    <th>Reputation</th>
                    <th>Reliability</th>
                    <th>Exit IP</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((item) => {
                    const res = item.result;
                    const verdict = res?.verdict || "FAIL";
                    const verdictInfo = VERDICT_LABELS[verdict];
                    const VerdictIcon = verdictInfo.icon;

                    return (
                      <tr
                        key={item.index}
                        onClick={() => {
                          if (res) {
                            setInspectResult(res);
                            setInspectIndex(item.index);
                          }
                        }}
                      >
                        <td data-label="Proxy" className="font-mono text-xs font-semibold text-ink">
                          {res ? `${res.proxy.protocol}://${res.proxy.host}:${res.proxy.port}` : `Item #${item.index}`}
                        </td>
                        <td data-label="Verdict">
                          <Badge variant="outline" className={`gap-1 font-mono text-xs ${verdictInfo.class}`}>
                            <VerdictIcon size={12} /> {verdict}
                          </Badge>
                        </td>
                        <td data-label="Safety Score" className="font-mono text-xs">
                          {formatScore(res?.scores?.overallSafety)}
                        </td>
                        <td data-label="Transport" className="font-mono text-xs">
                          {formatScore(res?.scores?.transportSecurity)}
                        </td>
                        <td data-label="Privacy" className="font-mono text-xs">
                          {formatScore(res?.scores?.privacy)}
                        </td>
                        <td data-label="Reputation" className="font-mono text-xs">
                          {formatScore(res?.scores?.reputation)}
                        </td>
                        <td data-label="Reliability" className="font-mono text-xs">
                          {formatScore(res?.scores?.reliability)}
                        </td>
                        <td data-label="Exit IP" className="font-mono text-xs text-muted">
                          {res?.exitIp?.ip || "—"}
                        </td>
                        <td data-label="Details">
                          <Button variant="ghost" size="icon" className="size-8">
                            <ChevronRight size={14} />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            currentJob && !isJobActive && (
              <div className="auditor-setup-card text-center py-10 text-muted-foreground text-xs">
                No results recorded for this job.
              </div>
            )
          )}
        </>
      )}

      {/* Evidence Inspection Sheet */}
      <Sheet open={Boolean(inspectResult)} onOpenChange={(open) => { if (!open) setInspectResult(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl lg:max-w-2xl p-0 flex flex-col">
          <SheetHeader className="p-6 border-b border-border/60">
            <SheetTitle className="text-base font-mono font-bold flex items-center gap-2">
              <Shield size={16} className="text-primary" />
              {inspectResult ? `${inspectResult.proxy.protocol}://${inspectResult.proxy.host}:${inspectResult.proxy.port}` : "Audit evidence"}
            </SheetTitle>
            <SheetDescription className="text-xs text-muted-foreground">
              Detailed probe evidence, score deductions, and operator recommendations.
            </SheetDescription>
          </SheetHeader>

          {inspectResult && (
            <ScrollArea className="flex-1 p-6">
              <div className="flex flex-col gap-6">
                {/* 1. Verdict & Scores */}
                <div className="evidence-section">
                  <h4>Verdict & Component Scores</h4>
                  <dl className="evidence-dl">
                    <dt>Verdict</dt>
                    <dd className="font-bold text-ink">{inspectResult.verdict}</dd>
                    <dt>Overall Safety</dt>
                    <dd>{formatScore(inspectResult.scores.overallSafety)}</dd>
                    <dt>Transport Security</dt>
                    <dd>{formatScore(inspectResult.scores.transportSecurity)} (35%)</dd>
                    <dt>Privacy</dt>
                    <dd>{formatScore(inspectResult.scores.privacy)} (30%)</dd>
                    <dt>Reputation</dt>
                    <dd>{formatScore(inspectResult.scores.reputation)} (20%)</dd>
                    <dt>Reliability</dt>
                    <dd>{formatScore(inspectResult.scores.reliability)} (15%)</dd>
                  </dl>
                </div>

                {/* 2. Connectivity Timings */}
                <div className="evidence-section">
                  <h4>Connectivity & Latency</h4>
                  <dl className="evidence-dl">
                    <dt>Reachable</dt>
                    <dd>{inspectResult.connectivity?.reachable ? "Yes" : "No"}</dd>
                    <dt>Latency (TTFB)</dt>
                    <dd>{inspectResult.connectivity?.latencyMs != null ? `${inspectResult.connectivity.latencyMs} ms` : "Unknown"}</dd>
                    {inspectResult.connectivity?.error && (
                      <>
                        <dt>Error</dt>
                        <dd className="text-rose-400">{inspectResult.connectivity.error}</dd>
                      </>
                    )}
                  </dl>
                </div>

                {/* 3. Exit IP & Network */}
                <div className="evidence-section">
                  <h4>Exit Identity & Network</h4>
                  <dl className="evidence-dl">
                    <dt>Observed Exit IP</dt>
                    <dd>{inspectResult.exitIp?.ip || "Unknown"}</dd>
                    <dt>Country / City</dt>
                    <dd>{inspectResult.exitIp?.country || "Unknown"}{inspectResult.exitIp?.city ? `, ${inspectResult.exitIp.city}` : ""}</dd>
                    <dt>ASN / ISP</dt>
                    <dd>{inspectResult.network?.asn || "Unknown"}{inspectResult.network?.organization ? ` (${inspectResult.network.organization})` : ""}</dd>
                    <dt>Datacenter</dt>
                    <dd>{inspectResult.network?.isDatacenter === undefined ? "Unknown" : inspectResult.network.isDatacenter ? "Yes" : "No"}</dd>
                    <dt>VPN / Proxy</dt>
                    <dd>{inspectResult.network?.isVpn ? "VPN" : inspectResult.network?.isProxy ? "Proxy" : "No"}</dd>
                  </dl>
                </div>

                {/* 4. Security & TLS Integrity */}
                <div className="evidence-section">
                  <h4>Transport Security & TLS</h4>
                  <dl className="evidence-dl">
                    <dt>TLS Secure</dt>
                    <dd>{inspectResult.tls?.secure === undefined ? "Unknown" : inspectResult.tls.secure ? "Yes" : "No"}</dd>
                    <dt>Cert Valid</dt>
                    <dd>{inspectResult.tls?.certificateValid === undefined ? "Unknown" : inspectResult.tls.certificateValid ? "Yes" : "No"}</dd>
                    <dt>TLS Protocol</dt>
                    <dd>{inspectResult.tls?.protocol || "Unknown"}</dd>
                    <dt>Negotiated Cipher</dt>
                    <dd>{inspectResult.tls?.cipher || "Unknown"}</dd>
                    <dt>Possible MITM</dt>
                    <dd className={inspectResult.tls?.possibleMitm ? "text-rose-400 font-bold" : ""}>
                      {inspectResult.tls?.possibleMitm ? "Yes (Suspected)" : "No"}
                    </dd>
                  </dl>
                </div>

                {/* 5. Leaks & DNS */}
                <div className="evidence-section">
                  <h4>Privacy & Leak Analysis</h4>
                  <dl className="evidence-dl">
                    <dt>Origin IP Leak</dt>
                    <dd className={inspectResult.headerLeak?.detected ? "text-rose-400 font-bold" : "text-emerald-400"}>
                      {inspectResult.headerLeak?.detected ? "Detected in headers" : "Clean"}
                    </dd>
                    <dt>DNS Leak</dt>
                    <dd>
                      {inspectResult.dns?.dnsLeakDetected === undefined || inspectResult.dns?.dnsLeakDetected === null
                        ? "Unknown"
                        : inspectResult.dns.dnsLeakDetected
                          ? "Detected"
                          : "Clean"}
                    </dd>
                    <dt>Content Intact</dt>
                    <dd>{inspectResult.contentIntegrity?.intact === undefined ? "Unknown" : inspectResult.contentIntegrity.intact ? "Yes" : "Tampered"}</dd>
                  </dl>
                </div>

                {/* 6. Stability & Jitter */}
                <div className="evidence-section">
                  <h4>Stability & Performance</h4>
                  <dl className="evidence-dl">
                    <dt>Success Rate</dt>
                    <dd>{inspectResult.stability?.successRate != null ? `${inspectResult.stability.successRate}%` : "Unknown"}</dd>
                    <dt>Packet Loss</dt>
                    <dd>{inspectResult.stability?.packetLossPercent != null ? `${inspectResult.stability.packetLossPercent}%` : "Unknown"}</dd>
                    <dt>Jitter</dt>
                    <dd>{inspectResult.stability?.jitterMs != null ? `${inspectResult.stability.jitterMs} ms` : "Unknown"}</dd>
                    <dt>IP Rotation</dt>
                    <dd>{inspectResult.rotation?.exitIpChanged ? "Observed" : "Stable"}</dd>
                  </dl>
                </div>

                {/* 7. Risk Factors & Recommendations */}
                <div className="evidence-section">
                  <h4>Identified Risk Factors ({inspectResult.riskFactors.length})</h4>
                  {inspectResult.riskFactors.length === 0 ? (
                    <p className="text-xs text-emerald-400">No security or reliability risks detected.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {inspectResult.riskFactors.map((rf, idx) => (
                        <div key={idx} className="p-3 rounded-lg bg-surface-raised border border-border/60 text-xs">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-[10px] uppercase font-mono">
                              {rf.severity}
                            </Badge>
                            <span className="font-semibold text-ink">{rf.title}</span>
                          </div>
                          <p className="text-muted-foreground">{rf.description || rf.message}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="evidence-section">
                  <h4>Operator Recommendations</h4>
                  {inspectResult.recommendations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No specific operator actions required.</p>
                  ) : (
                    <ul className="list-disc pl-4 text-xs text-ink space-y-1">
                      {inspectResult.recommendations.map((rec, idx) => (
                        <li key={idx}>{rec}</li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 8. Metadata */}
                <div className="evidence-section">
                  <h4>Audit Metadata</h4>
                  <dl className="evidence-dl text-[11px]">
                    <dt>Started</dt>
                    <dd>{new Date(inspectResult.metadata.startedAt).toLocaleString()}</dd>
                    <dt>Duration</dt>
                    <dd>{inspectResult.metadata.durationMs} ms</dd>
                    <dt>Schema Version</dt>
                    <dd>{inspectResult.metadata.schemaVersion}</dd>
                  </dl>
                </div>
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete History Confirm Dialog */}
      <Dialog open={Boolean(deleteConfirmId)} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete audit history record?</DialogTitle>
            <DialogDescription>
              This will remove the job and all associated JSON/CSV export files from server storage.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setDeleteConfirmId(null)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteConfirmId) void handleDeleteHistory(deleteConfirmId); }}
              className="min-h-[44px]"
            >
              Delete record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
