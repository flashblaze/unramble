import { z } from "zod";
import { alignWeekday, parseLocalDue } from "./dates";

export const MAX_TASKS = 20;
const MAX_TITLE = 200;
const MAX_NOTES = 2000;
const PRIORITIES = [0, 1, 3, 5] as const;

/** A task as exchanged with the watch. `due` is local wall-clock time: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". */
export const Task = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  due: z
    .string()
    .trim()
    .refine((value) => parseLocalDue(value) !== null, "due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM")
    .optional(),
  priority: z.union(PRIORITIES.map((p) => z.literal(p))),
  notes: z.string().trim().min(1).max(MAX_NOTES).optional(),
});
export type Task = z.infer<typeof Task>;

/** `POST /tasks` body. Strict: one bad task rejects the request. `dictationId` links it to history. */
export const CreateTasksBody = z.object({
  tz: z.string(),
  tasks: z.array(Task).min(1).max(MAX_TASKS),
  dictationId: z.uuid().optional(),
});

/** What the extraction model returns per task; see the prompt in extract.ts. */
const ModelTask = z.object({
  title: z.string(),
  when_said: z.string().optional(),
  due: z.string().optional(),
  priority_said: z.string().optional(),
  priority: z.number().optional(),
  notes: z.string().optional(),
});
const ModelOutput = z.object({ tasks: z.array(z.unknown()) });

/**
 * Tasks from the extraction model, lenient per task. Grounding guard: a due date only survives if the
 * model quoted the speaker's timing words (`when_said`), and a priority only if it quoted importance
 * words (`priority_said`). An unparseable date or unknown priority is dropped, not the task; an
 * over-long title or notes is truncated, not dropped. With `clock`, a due date that contradicts a
 * weekday the speaker named is corrected (see alignWeekday).
 */
export function tasksFromModel(output: unknown, clock?: { now: number; tz: string }): Task[] {
  const parsed = ModelOutput.safeParse(output);
  if (!parsed.success) return [];
  const tasks: Task[] = [];
  for (const raw of parsed.data.tasks) {
    const item = ModelTask.safeParse(raw);
    if (!item.success) continue;
    const { title, when_said, due, priority_said, priority, notes } = item.data;
    const whenSaid = when_said?.trim();
    let dueValue = whenSaid && due?.trim() && parseLocalDue(due.trim()) ? due.trim() : undefined;
    if (dueValue && whenSaid && clock) dueValue = alignWeekday(dueValue, whenSaid, clock.now, clock.tz);
    const task = Task.safeParse({
      title: title.trim().slice(0, MAX_TITLE),
      due: dueValue,
      priority: priority_said?.trim() && PRIORITIES.some((p) => p === priority) ? priority : 0,
      notes: notes?.trim().slice(0, MAX_NOTES) || undefined,
    });
    if (task.success) tasks.push(task.data);
  }
  return tasks.slice(0, MAX_TASKS);
}
