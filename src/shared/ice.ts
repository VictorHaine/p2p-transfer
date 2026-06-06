import { isValidAuthority } from "./authority.js";

type IceCredentialType = "password";
const MAX_CLONED_ICE_SERVERS = 16;
const MAX_CLONED_ICE_URLS_PER_SERVER = 8;
const MAX_CLONED_ICE_URL_CHARS = 512;
const MAX_CLONED_ICE_USERNAME_CHARS = 1024;
const MAX_CLONED_ICE_CREDENTIAL_CHARS = 1024;

export type IceServerSnapshot = Readonly<{
  urls: string | readonly string[];
  username?: string;
  credential?: string;
  credentialType?: IceCredentialType;
}>;

export function cloneIceServers(servers: readonly IceServerSnapshot[]): RTCIceServer[] {
  if (!Array.isArray(servers) || servers.length > MAX_CLONED_ICE_SERVERS) throw new Error("ICE server list is invalid.");
  const cloned: RTCIceServer[] = [];
  for (let index = 0; index < servers.length; index += 1) cloned.push(cloneIceServer(ownDataValue<IceServerSnapshot>(servers, String(index))));
  return cloned;
}

type IceServerWithCredentialType = RTCIceServer & {
  credentialType?: IceCredentialType;
};

function cloneIceServer(server: IceServerSnapshot): RTCIceServer {
  if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("ICE server is invalid.");
  const rawUrls = ownDataValue<IceServerSnapshot["urls"]>(server, "urls");
  const urls = typeof rawUrls === "string" ? cloneIceUrl(rawUrls) : cloneIceUrlList(rawUrls);
  const cloned: IceServerWithCredentialType = {
    urls
  };
  const username = optionalOwnDataValue<string>(server, "username");
  const credential = optionalOwnDataValue<string>(server, "credential");
  const credentialType = optionalOwnDataValue<IceCredentialType>(server, "credentialType");
  const urlList = typeof urls === "string" ? [urls] : urls;
  const hasTurnUrl = urlList.some((url) => /^(?:turn|turns):/i.test(url));
  const hasNoCredential = username === undefined && credential === undefined;
  const hasCompleteCredential = isSafeBoundedNonEmptyString(username, MAX_CLONED_ICE_USERNAME_CHARS) && isSafeBoundedNonEmptyString(credential, MAX_CLONED_ICE_CREDENTIAL_CHARS);
  if (!(hasNoCredential || hasCompleteCredential)) throw new Error("ICE server credentials are invalid.");
  if (hasTurnUrl && !hasCompleteCredential) throw new Error("TURN ICE servers require credentials.");
  if (credentialType !== undefined && (credentialType !== "password" || !hasCompleteCredential)) throw new Error("ICE server credential type is invalid.");
  if (username !== undefined) cloned.username = username;
  if (credential !== undefined) cloned.credential = credential;
  if (credentialType !== undefined) cloned.credentialType = credentialType;
  return cloned;
}

function cloneIceUrlList(urls: readonly string[]): string[] {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_CLONED_ICE_URLS_PER_SERVER) throw new Error("ICE server URL list is invalid.");
  const cloned: string[] = [];
  for (let index = 0; index < urls.length; index += 1) cloned.push(cloneIceUrl(ownDataValue<string>(urls, String(index))));
  return cloned;
}

function cloneIceUrl(url: unknown): string {
  if (!isIceUrl(url)) throw new Error("ICE server URL is invalid.");
  return url;
}

function isIceUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_CLONED_ICE_URL_CHARS || /[\p{Cc}\p{Cf}\s]/u.test(url)) return false;
  const parsed = /^(?:stun|stuns|turn|turns):([^?]+)(?:\?transport=(?:udp|tcp))?$/i.exec(url);
  return Boolean(parsed?.[1] && isValidAuthority(parsed[1]));
}

function isSafeBoundedNonEmptyString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function optionalOwnDataValue<T>(source: object, key: string): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("ICE server fields must be data properties.");
  return descriptor.value as T;
}

function ownDataValue<T>(source: object, key: string): T {
  const value = optionalOwnDataValue<T>(source, key);
  if (value === undefined) throw new Error("ICE server is invalid.");
  return value;
}
