export function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; data?: unknown; message?: string };

    const data = e.data;
    if (data && typeof data === "object") {
      const d = data as { error?: unknown; message?: unknown };
      if (typeof d.error === "string" && d.error.trim()) return d.error;
      if (typeof d.message === "string" && d.message.trim()) return d.message;
    }

    if (e.status === 403) {
      return "You don't have permission to do this. An admin needs to grant you access.";
    }
    if (e.status === 401) {
      return "Your session has expired. Please sign in again.";
    }

    if (typeof e.message === "string" && e.message.trim()) return e.message;
  }

  return "Something went wrong. Please try again.";
}
