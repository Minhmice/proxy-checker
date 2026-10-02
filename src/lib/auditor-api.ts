import { authHeaders } from "./api";
import type { AuditorJob, AuditorJobOptions } from "./types";

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

export async function createAuditorJob(
  arg1: string | CreateAuditorJobPayload,
  arg2?: CreateAuditorJobPayload
): Promise<AuditorJob> {
  const payload = typeof arg1 === "object" ? arg1 : arg2!;
  const password = typeof arg1 === "string" ? arg1 : undefined;

  const response = await fetch("/api/auditor/jobs", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
    body: JSON.stringify(payload),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Failed to start audit job");
  return data.job;
}

export async function fetchAuditorJob(
  arg1: string,
  arg2?: string | AbortSignal,
  arg3?: AbortSignal
): Promise<AuditorJob> {
  let id: string;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg2 === "string") {
    password = arg1;
    id = arg2;
    signal = arg3;
  } else {
    id = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  }

  const response = await fetch(`/api/auditor/jobs/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Audit job unavailable");
  return data.job;
}

export async function fetchAuditorHistory(
  arg1?: string | number | AbortSignal,
  arg2?: number | AbortSignal,
  arg3?: AbortSignal
): Promise<AuditorJob[]> {
  let limit = 50;
  let signal: AbortSignal | undefined;
  let password: string | undefined;

  if (typeof arg1 === "string") {
    password = arg1;
    if (typeof arg2 === "number") limit = arg2;
    signal = arg3;
  } else if (typeof arg1 === "number") {
    limit = arg1;
    if (arg2 instanceof AbortSignal) signal = arg2;
  } else if (arg1 instanceof AbortSignal) {
    signal = arg1;
  }

  const response = await fetch(`/api/auditor/history?limit=${Math.max(1, Math.min(50, limit))}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ jobs: AuditorJob[] }>(response, "Audit history unavailable");
  return data.jobs ?? [];
}

export async function cancelAuditorJob(
  arg1: string,
  arg2?: string
): Promise<AuditorJob> {
  const id = arg2 !== undefined ? arg2 : arg1;
  const password = arg2 !== undefined ? arg1 : undefined;

  const response = await fetch(`/api/auditor/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  const data = await parseResponseJson<{ job: AuditorJob }>(response, "Failed to cancel audit job");
  return data.job;
}

export async function deleteAuditorJob(
  arg1: string,
  arg2?: string
): Promise<void> {
  const id = arg2 !== undefined ? arg2 : arg1;
  const password = arg2 !== undefined ? arg1 : undefined;

  const response = await fetch(`/api/auditor/history/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) {
    throw new Error("Wrong control password");
  }
  if (!response.ok && response.status !== 404) {
    throw new Error("Failed to delete audit job history");
  }
}
export const deleteAuditorHistory = deleteAuditorJob;


export function getAuditorExportUrl(id: string, format: "txt" | "json" | "csv"): string {
  const encodedId = encodeURIComponent(id);
  const encodedFormat = encodeURIComponent(format);
  return `/api/auditor/jobs/${encodedId}/export?format=${encodedFormat}`;
}

export async function downloadAuditorExport(
  arg1: string,
  arg2?: string | ("txt" | "json" | "csv"),
  arg3?: "txt" | "json" | "csv"
): Promise<{ blob: Blob; filename: string }> {
  let id: string;
  let format: "txt" | "json" | "csv" = "json";
  let password: string | undefined;

  if (arg3 !== undefined) {
    password = arg1;
    id = arg2!;
    format = arg3;
  } else if (arg2 === "txt" || arg2 === "json" || arg2 === "csv") {
    id = arg1;
    format = arg2;
  } else {
    id = arg1;
  }

  const response = await fetch(getAuditorExportUrl(id, format), {
    credentials: "same-origin",
    headers: authHeaders(password),
  });
  if (response.status === 401) {
    throw new Error("Wrong control password");
  }
  if (!response.ok) {
    let msg = "Failed to export audit report";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // Non-JSON response
    }
    throw new Error(msg);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  let filename = `auditor-${id}.${format}`;
  if (disposition) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match?.[1]) filename = match[1];
  }
  return { blob, filename };
}
