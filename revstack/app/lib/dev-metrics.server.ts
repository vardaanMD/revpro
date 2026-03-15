/**
 * In-memory rolling latency metrics for development only.
 * Production: recordTiming/recordTotal no-op (near-zero overhead).
 */

const MAX_SAMPLES = 200;
const FLUSH_EVERY_N_TOTAL = 20;

const isDev = typeof process !== "undefined" && process.env.NODE_ENV !== "production";

type StepSamples = Record<string, number[]>;
type GroupData = { steps: StepSamples; totalSamples: number[]; totalCount: number };

const store: Record<string, GroupData> = {};

function ensureGroup(group: string): GroupData {
  if (!store[group]) {
    store[group] = { steps: {}, totalSamples: [], totalCount: 0 };
  }
  return store[group];
}

function pushTrim(arr: number[], val: number, max: number): void {
  arr.push(val);
  if (arr.length > max) arr.shift();
}

/** p in [0, 1]; returns value at that percentile from sorted copy. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const n = sorted.length;
  const idx = Math.min(Math.floor(n * p), n - 1);
  return sorted[idx];
}

function flushGroup(group: string, data: GroupData): void {
  const steps = data.steps;
  const totalArr = data.totalSamples;
  const lines: string[] = [];

  const stepKeys = Object.keys(steps).filter((k) => k !== "total");
  stepKeys.sort();
  if (totalArr.length > 0) {
    stepKeys.push("total");
  }

  for (const step of stepKeys) {
    const arr = step === "total" ? totalArr : steps[step];
    if (!arr || arr.length === 0) continue;
    const sorted = arr.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const avg = n > 0 ? sorted.reduce((s, x) => s + x, 0) / n : 0;
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const max = n > 0 ? sorted[n - 1] : 0;
    const avgR = Math.round(avg);
    lines.push(`${step}: p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms max=${Math.round(max)}ms avg=${avgR}ms n=${n}`);
  }

  if (lines.length > 0) {
    // Dev-only metrics; use structured logger if you need to emit in production
  }
}

export function recordTiming(group: string, step: string, durationMs: number): void {
  if (!isDev) return;
  const data = ensureGroup(group);
  if (!data.steps[step]) data.steps[step] = [];
  pushTrim(data.steps[step], durationMs, MAX_SAMPLES);
}

export function recordTotal(group: string, durationMs: number): void {
  if (!isDev) return;
  const data = ensureGroup(group);
  pushTrim(data.totalSamples, durationMs, MAX_SAMPLES);
  data.totalCount += 1;
  if (data.totalCount % FLUSH_EVERY_N_TOTAL === 0) {
    flushGroup(group, data);
  }
}
