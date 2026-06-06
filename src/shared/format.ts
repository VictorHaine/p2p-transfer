const MAX_BASENAME_INPUT_CHARS = 4096;

export function formatBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) throw new Error("Byte count is invalid.");
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function basename(path: unknown): string {
  if (typeof path !== "string") throw new Error("Path must be a string.");
  let end = path.length;
  while (end > 0 && isPathSeparator(path.charCodeAt(end - 1))) end -= 1;
  if (end === 0) return path;
  const min = Math.max(0, end - MAX_BASENAME_INPUT_CHARS);
  for (let index = end - 1; index >= min; index -= 1) {
    if (isPathSeparator(path.charCodeAt(index))) return path.slice(index + 1, end);
  }
  return path.slice(min, end);
}

function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92;
}
