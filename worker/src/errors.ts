/**
 * Error summary that is safe to log. JSON parse errors quote their input, and that input is model
 * output built from the user's dictation, so they are logged by name only. Other messages are capped.
 */
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error instanceof SyntaxError) return error.name;
  return `${error.name}: ${error.message.slice(0, 200)}`;
}
