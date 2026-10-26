const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
export const localDateStr = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Local minute stamp of a timestamp, `YYYY-MM-DD-HHMM` (used in entity ids). */
export const localMinuteStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${localDateStr(ms)}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

export const toIso = (ms: number): string => new Date(ms).toISOString();

/** Milliseconds to whole minutes (rounded). Non-finite / negative input → 0. */
export const msToMinutes = (ms: number | null | undefined): number => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.round(ms / 60000);
};
