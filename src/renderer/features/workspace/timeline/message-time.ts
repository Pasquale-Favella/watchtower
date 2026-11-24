/** Locale time for a durable timestamp; an unparseable value is shown as recorded. */
export function formatMessageTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
