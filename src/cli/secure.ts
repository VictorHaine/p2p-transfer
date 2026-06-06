import { CONNECT_TIMEOUT_MS } from "../shared/constants.js";
import {
  finishPake,
  ownPakeShareB64,
  parsePakeShareMessage,
  sessionConfirmTag,
  startPake,
  verifySessionConfirmTag,
  wipePakeState,
  wipeSessionKeys,
  type PakeRole,
  type SessionKeys
} from "../shared/security.js";
import { waitForMessage, type SignalingClient } from "./signaling.js";

export async function establishKeys(signaling: SignalingClient, sid: string, role: PakeRole, code: string): Promise<SessionKeys> {
  const state = startPake(role, code, sid);
  const waitAbort = new AbortController();
  let keys: SessionKeys | undefined;
  let peerWait: Promise<Extract<import("../shared/messages.js").ServerMessage, { type: "pake" }>> | undefined;
  let confirmWait: Promise<Extract<import("../shared/messages.js").ServerMessage, { type: "confirm" }>> | undefined;
  try {
    peerWait = waitForMessage(signaling, "pake", CONNECT_TIMEOUT_MS, sid, waitAbort.signal);
    confirmWait = waitForMessage(signaling, "confirm", CONNECT_TIMEOUT_MS, sid, waitAbort.signal);
    peerWait.catch(() => {});
    confirmWait.catch(() => {});
    signaling.send({ type: "pake", sid, data: JSON.stringify({ t: "cpace-share", share: ownPakeShareB64(state) }) });
    const peer = await peerWait;
    keys = await finishPake(state, parsePakeShareMessage(peer.data));
    signaling.send({ type: "confirm", sid, tag: sessionConfirmTag(keys.signalAuthKey, sid, role) });
    const confirm = await confirmWait;
    const peerRole = role === "sender" ? "receiver" : "sender";
    if (!verifySessionConfirmTag(keys.signalAuthKey, sid, peerRole, confirm.tag)) {
      throw new Error("PAKE confirmation failed. Wrong code or signaling MITM.");
    }
    return keys;
  } catch (error) {
    waitAbort.abort();
    wipePakeState(state);
    wipeSessionKeys(keys);
    throw error;
  }
}
