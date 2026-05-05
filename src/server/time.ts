const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function safeTimestamp(timestamp: number): number {
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
}

export function toShanghaiDateKey(timestamp: number): string {
  return new Date(safeTimestamp(timestamp) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function toShanghaiHourKey(timestamp: number): string {
  return new Date(safeTimestamp(timestamp) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 13);
}
