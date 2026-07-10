export type ApplicationsOpenKind = "text" | "date" | "range" | "month";

export interface ApplicationsOpenValue {
  kind: ApplicationsOpenKind;
  text: string;
  date: string;
  rangeStart: string;
  rangeEnd: string;
  month: string;
}

const EMPTY: ApplicationsOpenValue = {
  kind: "text",
  text: "",
  date: "",
  rangeStart: "",
  rangeEnd: "",
  month: "",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(value: string): string {
  const d = parseIsoDate(value);
  if (!d) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMonth(value: string): string {
  if (!ISO_MONTH.test(value)) return value;
  const [year, month] = value.split("-").map(Number);
  const d = new Date(year, month - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function emptyApplicationsOpenValue(kind: ApplicationsOpenKind = "text"): ApplicationsOpenValue {
  return { ...EMPTY, kind };
}

export function parseApplicationsOpenValue(raw: string): ApplicationsOpenValue {
  const trimmed = raw.trim();
  if (!trimmed) return emptyApplicationsOpenValue();

  if (trimmed.startsWith("text:")) {
    return { ...EMPTY, kind: "text", text: trimmed.slice(5) };
  }
  if (trimmed.startsWith("date:")) {
    const date = trimmed.slice(5);
    return { ...EMPTY, kind: "date", date: ISO_DATE.test(date) ? date : "" };
  }
  if (trimmed.startsWith("range:")) {
    const body = trimmed.slice(6);
    const [start, end] = body.split("/");
    return {
      ...EMPTY,
      kind: "range",
      rangeStart: start && ISO_DATE.test(start) ? start : "",
      rangeEnd: end && ISO_DATE.test(end) ? end : "",
    };
  }
  if (trimmed.startsWith("month:")) {
    const month = trimmed.slice(6);
    return { ...EMPTY, kind: "month", month: ISO_MONTH.test(month) ? month : "" };
  }

  if (ISO_DATE.test(trimmed)) {
    return { ...EMPTY, kind: "date", date: trimmed };
  }
  if (ISO_MONTH.test(trimmed)) {
    return { ...EMPTY, kind: "month", month: trimmed };
  }

  return { ...EMPTY, kind: "text", text: trimmed };
}

export function serializeApplicationsOpenValue(value: ApplicationsOpenValue): string {
  switch (value.kind) {
    case "text":
      return value.text.trim() ? `text:${value.text.trim()}` : "";
    case "date":
      return value.date ? `date:${value.date}` : "";
    case "range":
      return value.rangeStart && value.rangeEnd ? `range:${value.rangeStart}/${value.rangeEnd}` : "";
    case "month":
      return value.month ? `month:${value.month}` : "";
    default:
      return "";
  }
}

export function formatApplicationsOpenDisplay(raw: string): string {
  const value = parseApplicationsOpenValue(raw);
  switch (value.kind) {
    case "text":
      return value.text;
    case "date":
      return value.date ? formatShortDate(value.date) : "";
    case "range":
      if (value.rangeStart && value.rangeEnd) {
        return `${formatShortDate(value.rangeStart)} – ${formatShortDate(value.rangeEnd)}`;
      }
      return value.rangeStart ? formatShortDate(value.rangeStart) : "";
    case "month":
      return value.month ? formatMonth(value.month) : "";
    default:
      return "";
  }
}

export function applicationsOpenValueIsEmpty(value: ApplicationsOpenValue): boolean {
  return serializeApplicationsOpenValue(value) === "";
}

export function normalizeRange(value: ApplicationsOpenValue): ApplicationsOpenValue {
  if (value.kind !== "range" || !value.rangeStart || !value.rangeEnd) return value;
  if (value.rangeStart <= value.rangeEnd) return value;
  return { ...value, rangeStart: value.rangeEnd, rangeEnd: value.rangeStart };
}
