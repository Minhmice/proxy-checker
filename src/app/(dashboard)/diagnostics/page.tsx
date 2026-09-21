"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Play, ShieldCheck, Upload } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { fetchDiagnosticFiles, fetchDiagnosticJob, promoteDiagnostics, runDiagnostics, uploadDiagnosticFile } from "@/lib/api";
import type { DiagnosticJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import "@/components/diagnostics.css";

const emptyJob: DiagnosticJob = { status: "idle", sourceFile: null, samplePercent: 30, eligible: 0, total: 0, checked: 0, startedAt: null, finishedAt: null, results: [], error: "" };

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

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!password) return;
    try {
      const [fileData, jobData] = await Promise.all([fetchDiagnosticFiles(password), fetchDiagnosticJob(password, signal)]);
      setFiles(fileData.files);
      setFile((current) => current || fileData.files[0]?.name || "");
      setJob(jobData);
      setError("");
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [password]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = password ? window.setInterval(() => void load(controller.signal), job.status === "running" ? 1200 : 15000) : undefined;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [load, password, job.status]);

  async function handleRun() {
    if (!password || !file) return;
    setNotice(""); setError(""); setSelected([]);
    try {
      await runDiagnostics(password, file);
      setNotice("Diagnostic sample started. Testing 30% of unique endpoints.");
      await load();
    } catch (reason) { setError((reason as Error).message); }
  }

  async function uploadFile(selectedFile: File) {
    if (!password || !selectedFile) return;
    setNotice(""); setError("");
    try {
      const uploaded = await uploadDiagnosticFile(password, selectedFile.name, await selectedFile.text());
      setNotice(`${uploaded.name} uploaded with ${uploaded.count.toLocaleString()} unique endpoints.`);
      await load();
      setFile(uploaded.name);
    } catch (reason) { setError((reason as Error).message); }
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    for (const selectedFile of Array.from(event.target.files ?? [])) await uploadFile(selectedFile);
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
    setNotice(""); setError("");
    try {
      const result = await promoteDiagnostics(password, selected);
      setNotice(`${result.promoted} result(s) activated in 9Router. ${result.skipped} unmatched result(s) skipped.`);
      setSelected([]);
    } catch (reason) { setError((reason as Error).message); }
  }

  const successful = useMemo(() => job.results.filter((result) => result.status === "SUCCESS"), [job.results]);
  const progress = job.total ? Math.round((job.checked / job.total) * 100) : 0;
  const running = job.status === "running";

  return (
    <>
      <div className="page-header diagnostics-page-header">
        <div><h1>Proxy diagnostics</h1><p>Verify identity, latency, header exposure, and hosting risk before routing traffic.</p></div>
        <Button disabled={!password || !file || running} onClick={handleRun}><Play aria-hidden /> {running ? "Testing sample…" : "Run sample"}</Button>
      </div>

      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {notice && <div className="banner banner--notice" role="status" aria-live="polite">{notice}</div>}

      <section className="diagnostics-workspace" aria-label="Diagnostic setup">
        <Card className="diagnostics-brief">
          <CardHeader>
            <div className="diagnostics-title-row"><span className="diagnostics-icon"><ShieldCheck aria-hidden /></span><div><CardTitle>Controlled sample</CardTitle><CardDescription>Test enough endpoints to make promotion safe without excess outbound traffic.</CardDescription></div></div>
          </CardHeader>
          <CardContent>
            <dl className="diagnostics-rules"><div><dt>Coverage</dt><dd>30% of unique endpoints</dd></div><div><dt>Signals</dt><dd>IP identity, HTTP headers, latency</dd></div></dl>
          </CardContent>
        </Card>

        <Card className="diagnostics-source">
          <CardHeader><CardTitle>Source list</CardTitle><CardDescription>Drop one or more .txt lists, or browse from your computer.</CardDescription></CardHeader>
          <CardContent>
            <div
              className={`diagnostics-dropzone ${dragActive ? "diagnostics-dropzone--active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click(); }}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              aria-label="Upload diagnostic text files"
            >
              <span className="diagnostics-dropzone-icon"><Upload aria-hidden /></span>
              <strong>{dragActive ? "Drop files to upload" : "Drop .txt files here"}</strong>
              <span>or click to browse · up to 5 MB per file</span>
              <input ref={fileInputRef} type="file" accept=".txt,text/plain" multiple onChange={handleUpload} disabled={running || !password} />
            </div>
            {files.length > 0 && <div className="diagnostics-file-list" aria-label="Uploaded diagnostic files">{files.map((item) => <button key={item.name} type="button" className={`diagnostics-file ${item.name === file ? "diagnostics-file--selected" : ""}`} onClick={() => setFile(item.name)} disabled={running}><FileText aria-hidden /><span><strong>{item.name}</strong><small>{item.count.toLocaleString()} endpoints</small></span></button>)}</div>}
          </CardContent>
        </Card>
      </section>

      <section className="diagnostics-summary" aria-label="Diagnostic summary">
        <div><span>Eligible</span><strong>{job.eligible.toLocaleString()}</strong><small>unique endpoints</small></div>
        <div><span>Sample scope</span><strong>{job.total.toLocaleString()}</strong><small>30% selected</small></div>
        <div><span>Completed</span><strong>{job.checked.toLocaleString()}</strong><small>{running ? "in progress" : "last run"}</small></div>
        <div><span>Verified</span><strong className="text-success">{successful.length.toLocaleString()}</strong><small>safe to review</small></div>
      </section>

      {running && <section className="diagnostics-progress" role="status" aria-live="polite"><div><span>Sample in progress</span><strong>{progress}%</strong></div><Progress value={progress} /><p>Testing {job.checked.toLocaleString()} of {job.total.toLocaleString()} selected endpoints.</p></section>}

      <section className="diagnostics-results" aria-labelledby="diagnostics-results-title">
        <div className="section-heading"><div><h2 id="diagnostics-results-title">Diagnostic evidence</h2><p>Only successful results can be selected for promotion.</p></div><Button variant="outline" disabled={!selected.length || running} onClick={handlePromote}><ShieldCheck aria-hidden /> Promote {selected.length ? `${selected.length} selected` : "selected"}</Button></div>
        {job.results.length === 0 ? <Card className="diagnostics-empty"><CardContent><FileText aria-hidden /><div><strong>{files.length ? "No sample results yet" : "No input lists yet"}</strong><p>{files.length ? "Choose a source list and run a controlled sample." : "Upload an authorized .txt proxy list to begin."}</p></div></CardContent></Card> : <div className="diagnostics-table-wrap"><table className="diagnostics-table"><thead><tr><th><span className="sr-only">Select</span></th><th>Endpoint</th><th>Result</th><th>HTTP</th><th>Latency</th><th>Exit IP</th><th>Country / ISP</th><th>Risk</th><th>Headers</th></tr></thead><tbody>{job.results.map((result) => { const checked = selected.includes(result.id); return <tr key={`${result.id}-${result.checkedAt}`}><td data-label="Select"><input type="checkbox" aria-label={`Select ${result.endpoint}`} checked={checked} disabled={result.status !== "SUCCESS" || running} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== result.id) : [...current, result.id])} /></td><td data-label="Endpoint" className="mono">{result.endpoint}</td><td data-label="Result"><span className={`diagnostic-status diagnostic-status--${result.status.toLowerCase()}`}>{result.status === "SUCCESS" ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}{result.status}</span></td><td data-label="HTTP">{result.statusCode ?? "—"}</td><td data-label="Latency" className="mono">{result.latencyMs} ms</td><td data-label="Exit IP" className="mono">{result.exitIp ?? "—"}</td><td data-label="Country / ISP">{result.country ?? "—"}{result.isp ? <small>{result.isp}</small> : null}</td><td data-label="Risk">{result.isProxyOrHosting == null ? "—" : result.isProxyOrHosting ? "Proxy / hosting" : "Residential signal"}</td><td data-label="Headers">{result.headerLeakage == null ? "—" : result.headerLeakage ? `Leak: ${result.leakedHeaders.join(", ")}` : "No common leaks"}</td></tr>})}</tbody></table></div>}
      </section>
    </>
  );
}
