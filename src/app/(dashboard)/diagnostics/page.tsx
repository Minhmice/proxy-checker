"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Play,
  Search,
  ShieldCheck,
  Square,
  Upload,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import {
  fetchDiagnosticFiles,
  fetchDiagnosticJob,
  promoteDiagnostics,
  runDiagnostics,
  stopDiagnostics,
  uploadDiagnosticFile,
} from "@/lib/api";
import type { DetailedDiagnosticResult, DiagnosticJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import "@/components/diagnostics.css";

const emptyJob: DiagnosticJob = {
  status: "idle",
  sourceFile: null,
  samplePercent: 30,
  sampleCount: null,
  eligible: 0,
  total: 0,
  checked: 0,
  passedCount: 0,
  failedCount: 0,
  startedAt: null,
  finishedAt: null,
  results: [],
  error: "",
};

type ResultFilter = "all" | "passed" | "failed";

export default function DiagnosticsPage() {
  const { password } = useAuth();
  const [files, setFiles] = useState<Array<{ name: string; count: number }>>([]);
  const [file, setFile] = useState("");
  const [job, setJob] = useState<DiagnosticJob>(emptyJob);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scope configuration state
  const [scopeMode, setScopeMode] = useState<"percent" | "count">("percent");
  const [selectedPercent, setSelectedPercent] = useState<number>(30);
  const [customCountInput, setCustomCountInput] = useState<string>("");

  // Result search & filtering
  const [searchQuery, setSearchQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!password) return;
      try {
        const [fileData, jobData] = await Promise.all([
          fetchDiagnosticFiles(password),
          fetchDiagnosticJob(password, signal),
        ]);
        setFiles(fileData.files);
        setFile((current) => current || fileData.files[0]?.name || "");
        setJob(jobData);
        setError("");
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [password]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = password
      ? window.setInterval(() => void load(controller.signal), job.status === "running" ? 1200 : 15000)
      : undefined;
    return () => {
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [load, password, job.status]);

  async function handleRun() {
    if (!password || !file) return;
    setNotice("");
    setError("");
    setSelected([]);
    try {
      if (scopeMode === "percent") {
        await runDiagnostics(password, { file, samplePercent: selectedPercent });
        setNotice(`Diagnostic sample started (${selectedPercent}% of unique endpoints).`);
      } else {
        const parsedCount = parseInt(customCountInput.trim(), 10);
        if (!parsedCount || parsedCount <= 0) {
          setError("Custom count must be a positive integer.");
          return;
        }
        await runDiagnostics(password, { file, sampleCount: parsedCount });
        setNotice(`Diagnostic sample started (${parsedCount} endpoints).`);
      }
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  async function handleStop() {
    if (!password) return;
    try {
      await stopDiagnostics(password);
      setNotice("Diagnostics stopped.");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function uploadFile(selectedFile: File) {
    if (!password || !selectedFile) return;
    setNotice("");
    setError("");
    try {
      const uploaded = await uploadDiagnosticFile(password, selectedFile.name, await selectedFile.text());
      setNotice(`${uploaded.name} uploaded with ${uploaded.count.toLocaleString()} unique endpoints.`);
      await load();
      setFile(uploaded.name);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    for (const selectedFile of Array.from(event.target.files ?? [])) {
      await uploadFile(selectedFile);
    }
    event.target.value = "";
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const selectedFile = event.dataTransfer.files[0];
    if (selectedFile) await uploadFile(selectedFile);
  }

  async function handlePromote() {
    if (!password || !selected.length) return;
    setNotice("");
    setError("");
    try {
      const result = await promoteDiagnostics(password, selected);
      setNotice(`${result.promoted} result(s) added to Proxies and activated in 9Router${result.skipped ? `; ${result.skipped} skipped` : ""}.`);
      setSelected([]);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  const running = job.status === "running";
  const progress = job.total ? Math.round((job.checked / job.total) * 100) : 0;

  // Real-time rates, elapsed, and ETA calculations
  const elapsedSeconds = useMemo(() => {
    if (!job.startedAt) return 0;
    const end = job.finishedAt ?? Date.now();
    return Math.max(0, Math.round((end - job.startedAt) / 1000));
  }, [job.startedAt, job.finishedAt]);

  const avgRate = useMemo(() => {
    if (elapsedSeconds <= 0 || job.checked <= 0) return null;
    return Number((job.checked / elapsedSeconds).toFixed(1));
  }, [job.checked, elapsedSeconds]);

  const etaSeconds = useMemo(() => {
    if (!running || job.checked < 5 || !avgRate || avgRate <= 0) return null;
    const remaining = Math.max(0, job.total - job.checked);
    return Math.round(remaining / avgRate);
  }, [running, job.checked, job.total, avgRate]);

  // Aggregate counters from backend job state rather than capped result storage
  const totalPassed = job.passedCount ?? job.results.filter((r) => r.status === "SUCCESS").length;
  const totalFailed = job.failedCount ?? job.results.filter((r) => r.status === "FAILED").length;

  // Search & Filter over currently loaded latest results
  const filteredResults = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return job.results.filter((res) => {
      if (resultFilter === "passed" && res.status !== "SUCCESS") return false;
      if (resultFilter === "failed" && res.status !== "FAILED") return false;
      if (!q) return true;
      const matchEndpoint = res.endpoint.toLowerCase().includes(q);
      const matchExitIp = res.exitIp ? res.exitIp.toLowerCase().includes(q) : false;
      const matchCountry = res.country ? res.country.toLowerCase().includes(q) : false;
      const matchIsp = res.isp ? res.isp.toLowerCase().includes(q) : false;
      return matchEndpoint || matchExitIp || matchCountry || matchIsp;
    });
  }, [job.results, resultFilter, searchQuery]);

  const visibleSuccessful = useMemo(
    () => filteredResults.filter((r) => r.status === "SUCCESS"),
    [filteredResults]
  );

  const allVisibleSelected =
    visibleSuccessful.length > 0 &&
    visibleSuccessful.every((r) => selected.includes(r.id));

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      const visibleIds = new Set(visibleSuccessful.map((r) => r.id));
      setSelected((prev) => prev.filter((id) => !visibleIds.has(id)));
    } else {
      const visibleIds = visibleSuccessful.map((r) => r.id);
      setSelected((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  }

  function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  return (
    <>
      <div className="page-header diagnostics-page-header">
        <div>
          <h1>Proxy diagnostics</h1>
          <p>Verify identity, latency, header exposure, and hosting risk before routing traffic.</p>
        </div>
      </div>

      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {notice && <div className="banner banner--notice" role="status" aria-live="polite">{notice}</div>}

      {/* Setup Toolbar */}
      <section className="diagnostics-setup-toolbar" aria-label="Diagnostic setup toolbar">
        <div className="setup-toolbar-grid">
          <div className="setup-toolbar-source">
            <label htmlFor="diag-source-select" className="setup-label">
              Source file
            </label>
            <div className="setup-source-control">
              <select
                id="diag-source-select"
                value={file}
                onChange={(e) => setFile(e.target.value)}
                disabled={running}
                className="input setup-select"
              >
                {files.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} ({item.count.toLocaleString()} endpoints)
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary setup-upload-trigger"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || !password}
                title="Upload list"
              >
                <Upload size={14} aria-hidden />
                <span>Upload</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                multiple
                onChange={handleUpload}
                disabled={running || !password}
                className="sr-only"
              />
            </div>
          </div>

          <div className="setup-toolbar-scope">
            <span className="setup-label">Sample scope</span>
            <div className="setup-scope-controls" role="group" aria-label="Sample percentage or count">
              <div className="setup-percent-pills">
                {[10, 30, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    className={`btn-pill ${scopeMode === "percent" && selectedPercent === pct ? "btn-pill--active" : ""}`}
                    onClick={() => {
                      setScopeMode("percent");
                      setSelectedPercent(pct);
                    }}
                    disabled={running}
                  >
                    {pct}%
                  </button>
                ))}
              </div>

              <div className="setup-custom-count">
                <Input
                  type="number"
                  placeholder="Count"
                  min="1"
                  value={customCountInput}
                  onChange={(e) => {
                    setCustomCountInput(e.target.value);
                    setScopeMode("count");
                  }}
                  disabled={running}
                  className={`setup-count-input ${scopeMode === "count" ? "setup-count-input--active" : ""}`}
                  aria-label="Custom sample count"
                />
              </div>
            </div>
          </div>

          <div className="setup-toolbar-action">
            {running ? (
              <Button
                variant="destructive"
                className="setup-run-btn setup-stop-btn"
                onClick={handleStop}
              >
                <Square size={14} aria-hidden />
                <span>Stop diagnostics</span>
              </Button>
            ) : (
              <Button
                className="setup-run-btn"
                disabled={!password || !file}
                onClick={handleRun}
              >
                <Play size={15} aria-hidden />
                <span>Run diagnostics</span>
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Summary Row */}
      <section className="diagnostics-summary" aria-label="Diagnostic summary metrics">
        <div>
          <span>Scope</span>
          <strong>{job.total.toLocaleString()}</strong>
          <small>{job.eligible.toLocaleString()} eligible</small>
        </div>
        <div>
          <span>Completed</span>
          <strong>{job.checked.toLocaleString()}</strong>
          <small>{running ? "in progress" : "finished"}</small>
        </div>
        <div>
          <span>Passed</span>
          <strong className="text-success">{totalPassed.toLocaleString()}</strong>
          <small>verified</small>
        </div>
        <div>
          <span>Failed</span>
          <strong className={totalFailed > 0 ? "text-error" : ""}>
            {totalFailed.toLocaleString()}
          </strong>
          <small>with error</small>
        </div>
        <div>
          <span>Elapsed</span>
          <strong>{formatDuration(elapsedSeconds)}</strong>
          <small>
            {avgRate ? `${avgRate} / sec` : "—"}
            {etaSeconds != null ? ` · ETA ${formatDuration(etaSeconds)}` : ""}
          </small>
        </div>
      </section>

      {running && (
        <section className="diagnostics-progress" role="status" aria-live="polite">
          <div>
            <span>Diagnostics in progress</span>
            <strong>{progress}%</strong>
          </div>
          <Progress value={progress} />
          <p>
            Tested {job.checked.toLocaleString()} of {job.total.toLocaleString()} endpoints
            {avgRate ? ` (${avgRate} checks/sec)` : ""}
            {etaSeconds != null ? ` · ~${formatDuration(etaSeconds)} remaining` : ""}
          </p>
        </section>
      )}

      {/* Results Workspace with Search and Filter Toolbar */}
      <section className="diagnostics-results" aria-labelledby="diagnostics-results-title">
        <div className="results-header-toolbar">
          <div className="results-header-info">
            <h2 id="diagnostics-results-title">Diagnostic evidence</h2>
            <p>
              Inspect identity, network latency, leaks, and error traces
              {job.checked > 500 ? " (showing latest 500 checked results)" : ""}.
            </p>
          </div>

          <div className="results-toolbar-controls">
            <div className="results-search-wrap">
              <Search size={14} className="search-icon" aria-hidden />
              <input
                type="text"
                placeholder="Search endpoint, IP, country, ISP…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input results-search-input"
                aria-label="Search results"
              />
            </div>

            <div className="filter-pills" role="tablist" aria-label="Result status filter">
              <button
                type="button"
                className={`filter-pill ${resultFilter === "all" ? "filter-pill--active" : ""}`}
                onClick={() => setResultFilter("all")}
                role="tab"
                aria-selected={resultFilter === "all"}
              >
                All ({job.total > 500 ? `${filteredResults.length} / ${job.results.length} view` : job.results.length})
              </button>
              <button
                type="button"
                className={`filter-pill ${resultFilter === "passed" ? "filter-pill--active" : ""}`}
                onClick={() => setResultFilter("passed")}
                role="tab"
                aria-selected={resultFilter === "passed"}
              >
                Passed ({totalPassed})
              </button>
              <button
                type="button"
                className={`filter-pill ${resultFilter === "failed" ? "filter-pill--active" : ""}`}
                onClick={() => setResultFilter("failed")}
                role="tab"
                aria-selected={resultFilter === "failed"}
              >
                Failed ({totalFailed})
              </button>
            </div>

            <Button
              variant="outline"
              disabled={!selected.length || running}
              onClick={handlePromote}
              className="promote-action-btn"
            >
              <ShieldCheck aria-hidden />
              <span>Promote {selected.length ? `(${selected.length})` : ""}</span>
            </Button>
          </div>
        </div>

        {job.results.length === 0 ? (
          <Card className="diagnostics-empty">
            <CardContent>
              <FileText aria-hidden />
              <div>
                <strong>{files.length ? "No sample results yet" : "No input lists yet"}</strong>
                <p>
                  {files.length
                    ? "Choose a source file above and run diagnostic checks."
                    : "Upload an authorized .txt proxy list to begin testing."}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th className="diag-check-th">
                    <input
                      type="checkbox"
                      aria-label="Select all visible successful proxies"
                      checked={allVisibleSelected}
                      disabled={running || visibleSuccessful.length === 0}
                      onChange={toggleSelectAllVisible}
                    />
                  </th>
                  <th>Endpoint</th>
                  <th>Result</th>
                  <th>Latency</th>
                  <th>Exit IP</th>
                  <th>Country / ISP</th>
                  <th>Risk</th>
                  <th>Headers</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((result) => {
                  const isChecked = selected.includes(result.id);
                  const isSuccess = result.status === "SUCCESS";
                  return (
                    <tr
                      key={`${result.id}-${result.checkedAt}`}
                      className={isChecked ? "is-selected" : undefined}
                    >
                      <td data-label="Select" className="diag-check-td">
                        <input
                          type="checkbox"
                          aria-label={`Select ${result.endpoint}`}
                          checked={isChecked}
                          disabled={!isSuccess || running}
                          onChange={() => {
                            setSelected((prev) =>
                              isChecked ? prev.filter((id) => id !== result.id) : [...prev, result.id]
                            );
                          }}
                        />
                      </td>
                      <td data-label="Endpoint" className="mono proxy-endpoint-diag">
                        <span>{result.endpoint}</span>
                      </td>
                      <td data-label="Result">
                        <div className="diagnostic-result-cell">
                          <span
                            className={`diagnostic-status diagnostic-status--${result.status.toLowerCase()}`}
                          >
                            {isSuccess ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}
                            {result.status}
                          </span>
                          {!isSuccess && result.error && (
                            <details className="diagnostic-error-details">
                              <summary className="diagnostic-error-summary">
                                <span>{result.error.slice(0, 48)}{result.error.length > 48 ? "…" : ""}</span>
                              </summary>
                              <pre className="diagnostic-error-full">{result.error}</pre>
                            </details>
                          )}
                        </div>
                      </td>
                      <td data-label="Latency" className="mono">
                        {result.latencyMs != null ? `${result.latencyMs} ms` : "—"}
                      </td>
                      <td data-label="Exit IP" className="mono">
                        {result.exitIp ?? "—"}
                      </td>
                      <td data-label="Country / ISP">
                        {result.country ?? "—"}
                        {result.isp ? <small>{result.isp}</small> : null}
                      </td>
                      <td data-label="Risk">
                        {result.isProxyOrHosting == null
                          ? "—"
                          : result.isProxyOrHosting
                          ? "Proxy / hosting"
                          : "Residential signal"}
                      </td>
                      <td data-label="Headers">
                        {result.headerLeakage == null
                          ? "—"
                          : result.headerLeakage
                          ? `Leak: ${result.leakedHeaders.join(", ")}`
                          : "No common leaks"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
