/** null means no application quota; provider limits and execution deadlines still apply. */
export type HarnessModelLimit = number | null;

export function withinModelLimit(value: number, limit: HarnessModelLimit): boolean {
  return limit === null || value <= limit;
}
