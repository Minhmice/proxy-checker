export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (typeof error === "object") {
    const err = error as { name?: string; message?: string; code?: number };
    if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === 20) {
      return true;
    }
    if (typeof err.message === "string" && (err.message.includes("aborted") || err.message.includes("AbortError"))) {
      return true;
    }
  }
  return false;
}
