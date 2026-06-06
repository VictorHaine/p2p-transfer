export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const unref = timerMethod(timer, "unref");
  unref?.call(timer);
}

function timerMethod(timer: unknown, key: string): (() => void) | undefined {
  if (!timer || typeof timer !== "object") return undefined;
  let current: object | null = timer;
  let depth = 0;
  while (current && depth < 8) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value as () => void : undefined;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return undefined;
}
