import { authHeaders } from "./api.js";
import type { AuditorJob, AuditorJobOptions } from "./types.js";

export type CreateAuditorJobPayload =
  | {
      mode: "single";
      proxy: string;
      options: AuditorJobOptions;
    }
  | {
      mode: "bulk";
      name: string;
      content: string;
      options: AuditorJobOptions;
    };

async function parseResponseJson<T>(response: Response, defaultError: string): Promise<T> {
  if (response.status === 401) {
    throw new Error("Wrong control password");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON or empty response
  }
  if (!response.ok) {
    throw new Error((body.error as string) || defaultError);
  }
  return body as T;
}

export async function createAuditorJob(password: string, payload: CreateAuditorJobPayload): Promise<AuditorJob> {
  const response = await fetch("/api/auditor/jobs", {
    method: "POST",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Failed to start audit job");
  return data.job;
}

export async function fetchAuditorJob(password: string, id: string, signal?: AbortSignal): Promise<AuditorJob> {
  const response = await fetch(`/api/auditor/jobs/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Audit job unavailable");
  return data.job;
}

export async function fetchAuditorHistory(
  password: string,
  limit = 50,
  signal?: AbortSignal
): Promise<AuditorJob[]> {
  const response = await fetch(`/api/auditor/history?limit=${Math.max(1, Math.min(50, limit))}`, {
    cache: "no-store",
    signal,
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ jobs: AuditorJob[] }>(response, "Audit history unavailable");
  return data.jobs ?? [];
}

export async function cancelAuditorJob(password: string, id: string): Promise<AuditorJob> {
  const response = await fetch(`/api/auditor/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Failed to cancel audit job");
  return data.job;
}

export async function deleteAuditorHistory(password: string, id: string): Promise<void> {
  const response = await fetch(`/api/auditor/history/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(password),
  });
  if (response.status === 401) {
    throw new Error("Wrong control password");
  }
  if (!response.ok) {
    let message = "Failed to delete audit history";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
}

export function getAuditorExportUrl(id: string, format: "json" | "csv"): string {
  return `/api/auditor/jobs/${encodeURIComponent(id)}/export?format=${format}`;
}

export async function downloadAuditorExport(
  password: string,
  id: string,
  format: "json" | "csv"
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(getAuditorExportUrl(id, format), {
    headers: authHeaders(password),
  });
  if (response.status === 401) {
    throw new Error("Wrong control password");
  }
  if (!response.ok) {
    let message = "Failed to export audit results";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const disposition = response.headers.get("content-disposition");
  let filename = `audit-${id.slice(0, 8)}.${format}`;
  if (disposition) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match?.[1]) filename = match[1];
  }

  const blob = await response.blob();
  return { blob, filename };
}
