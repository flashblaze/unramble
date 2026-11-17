import { parseLocalDue, toTickTickDate } from "./dates";
import type { Task } from "./tasks";

const API = "https://api.ticktick.com/open/v1";

/** TickTick rejected the token (expired after 180 days, or revoked). Fix: `bun run auth`. */
export class TickTickAuthError extends Error {
  constructor() {
    super("TickTick token rejected");
  }
}

/** Any other TickTick failure. Carries only the status: response bodies may echo task text. */
export class TickTickError extends Error {
  constructor(readonly status: number) {
    super(`TickTick ${status}`);
    this.name = "TickTickError";
  }
}

/** Creates one task in the Inbox (no projectId). `fetcher` is injectable for tests. */
export async function createTask(token: string, task: Task, tz: string, fetcher: typeof fetch = fetch): Promise<string> {
  const body: Record<string, unknown> = { title: task.title, priority: task.priority, timeZone: tz };
  if (task.notes) body.content = task.notes;
  const due = task.due ? parseLocalDue(task.due) : null;
  if (due) {
    const { date, isAllDay } = toTickTickDate(due, tz);
    body.startDate = date;
    body.dueDate = date;
    body.isAllDay = isAllDay;
  }
  const res = await fetcher(`${API}/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new TickTickAuthError();
  if (!res.ok) throw new TickTickError(res.status);
  const created = (await res.json()) as { id?: string };
  return created.id ?? "";
}
