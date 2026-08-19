import type { RouterOutputs } from "../../orpc.ts";

export type Overview = RouterOutputs["dashboard"]["overview"];

export function money(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(value);
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function trendOf(current: number, previous: number): "Up" | "Down" | "None" {
  if (previous === 0) return "None";
  if (current > previous) return "Up";
  if (current < previous) return "Down";
  return "None";
}

/** AnalyticalCardHeader wants the number and its scaling prefix separately. */
export function scaled(value: number): { value: string; scale: string } {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return { value: (value / 1_000_000).toFixed(2), scale: "M" };
  if (abs >= 1_000) return { value: (value / 1_000).toFixed(1), scale: "k" };
  return { value: String(Math.round(value)), scale: "" };
}

export function greeting(now: Date, name: string): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `Good ${part}, ${name}`;
}

export function nextActions(o: Overview): Array<{ text: string; to: string }> {
  const out: Array<{ text: string; to: string }> = [];
  const n = o.attention.length;
  if (n) out.push({ text: `${n} configuration${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`, to: "/configs" });
  const f = o.exceptions.failed.length;
  if (f) out.push({ text: `${f} sync${f === 1 ? "" : "s"} failed`, to: "/settings" });
  if (o.exceptions.agentStale) out.push({ text: "The on-prem agent is offline", to: "/settings" });
  return out;
}
