export type BufferedSignalingSocket = {
  bufferedAmount: number;
};

export function signalingBackpressureExceeded(socket: BufferedSignalingSocket, maxBufferedBytes: unknown): boolean {
  if (typeof maxBufferedBytes !== "number" || !Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) return true;
  let bufferedAmount: unknown;
  try {
    bufferedAmount = socket.bufferedAmount;
  } catch {
    return true;
  }
  return typeof bufferedAmount !== "number" || !Number.isFinite(bufferedAmount) || bufferedAmount > maxBufferedBytes;
}
