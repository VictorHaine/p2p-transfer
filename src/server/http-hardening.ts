import http from "node:http";
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_MAX_HEADERS_COUNT, HTTP_REQUEST_TIMEOUT_MS } from "../shared/constants.js";

export function applyHttpServerHardening(server: http.Server): void {
  setServerHardeningNumber(server, "headersTimeout", HTTP_HEADERS_TIMEOUT_MS);
  setServerHardeningNumber(server, "requestTimeout", HTTP_REQUEST_TIMEOUT_MS);
  setServerHardeningNumber(server, "keepAliveTimeout", HTTP_KEEP_ALIVE_TIMEOUT_MS);
  setServerHardeningNumber(server, "maxHeadersCount", HTTP_MAX_HEADERS_COUNT);
}

function setServerHardeningNumber(server: unknown, key: keyof Pick<http.Server, "headersTimeout" | "requestTimeout" | "keepAliveTimeout" | "maxHeadersCount">, value: number): void {
  if (!server || typeof server !== "object") throw new Error("HTTP server is invalid.");
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("HTTP server hardening value is invalid.");
  const descriptor = Object.getOwnPropertyDescriptor(server, key);
  if (!descriptor || !("value" in descriptor) || descriptor.writable !== true) throw new Error("HTTP server is invalid.");
  Object.defineProperty(server, key, { ...descriptor, value });
}
