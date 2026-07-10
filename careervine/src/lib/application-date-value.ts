const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidApplicationDate(value: string): boolean {
  const match = value.trim().match(ISO_DATE_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function parseApplicationDate(value: string): Date | null {
  if (!isValidApplicationDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function toApplicationDateIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatApplicationDateDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const date = parseApplicationDate(trimmed);
  if (!date) return trimmed;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function calendarAnchorFromApplicationDate(value: string): { year: number; month: number } {
  const date = parseApplicationDate(value);
  if (date) {
    return { year: date.getFullYear(), month: date.getMonth() };
  }
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() };
}

export function todayApplicationDateIso(): string {
  const today = new Date();
  return toApplicationDateIso(today.getFullYear(), today.getMonth(), today.getDate());
}
