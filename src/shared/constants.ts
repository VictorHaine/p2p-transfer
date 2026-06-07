import type { IceServerSnapshot } from "./ice.js";

export const PROTOCOL_VERSION = 5;

export const DEFAULT_SERVER_URL = "ws://127.0.0.1:8787/v1/ws";

export const DEFAULT_ICE_SERVERS: readonly IceServerSnapshot[] = Object.freeze([
  Object.freeze({ urls: "stun:stun.l.google.com:19302" }),
  Object.freeze({ urls: "stun:stun.cloudflare.com:3478" })
]);

export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES_PER_SESSION = 100;
export const MAX_FILE_NAME_CHARS = 1024;
export const MAX_MIME_CHARS = 255;
export const BROWSER_BLOB_FALLBACK_MAX_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_NAME_ATTEMPTS = 256;
export const CHUNK_SIZE = 16 * 1024;
export const DATA_CHANNEL_BUFFER_HIGH = 8 * 1024 * 1024;
export const DATA_CHANNEL_BUFFER_LOW = 2 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 45 * 1000;
export const PAKE_TIMEOUT_MS = CONNECT_TIMEOUT_MS * 2 + 15 * 1000;
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
export const TRANSFER_CONTROL_TIMEOUT_MS = 60 * 1000;
export const SIGNALING_MAX_PAYLOAD_BYTES = 256 * 1024;
export const SIGNALING_MAX_BUFFERED_BYTES = 1024 * 1024;
export const ENCRYPTED_JSON_MAX_CHARS = 192 * 1024;
export const SIGNALING_MAX_MESSAGES_PER_MINUTE = 240;
export const SIGNALING_MAX_BAD_MESSAGES = 3;
export const SIGNALING_MAX_CONNECTIONS_PER_IP = 32;
export const SIGNALING_MAX_WAITING_CODES = 10_000;
export const SIGNALING_MAX_SESSIONS = 10_000;
export const SIGNALING_IDLE_TIMEOUT_MS = 60 * 1000;
export const SIGNALING_HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const SIGNALING_CLOSE_GRACE_MS = 5 * 1000;
export const RECEIVER_MAX_PREPAIR_ATTEMPTS = 3;
export const MAX_QUEUED_ICE_CANDIDATES = 256;
export const SIGNALING_MAX_ICE_CANDIDATES_PER_PEER = 512;
export const MAX_BUFFERED_SIGNAL_MESSAGES = 300;
export const STATIC_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TURN_REST_SECRET_MIN_BYTES = 32;
export const HTTP_HEADERS_TIMEOUT_MS = 15 * 1000;
export const HTTP_REQUEST_TIMEOUT_MS = 30 * 1000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
export const HTTP_MAX_HEADERS_COUNT = 64;
export const ICE_CONFIG_MAX_REQUESTS_PER_MINUTE = 60;
