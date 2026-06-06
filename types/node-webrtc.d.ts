type RTCIceTransportPolicy = "all" | "relay";
type RTCDataChannelState = "connecting" | "open" | "closing" | "closed";
type RTCPeerConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
}

interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
}

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface RTCSessionDescriptionInit {
  type: RTCSdpType;
  sdp?: string;
}

interface RTCIceCandidate {
  toJSON(): RTCIceCandidateInit;
}

interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate | null;
}

interface RTCDataChannelEvent {
  channel: RTCDataChannel;
}

interface RTCDataChannelMessageEvent {
  data: unknown;
}

interface RTCDataChannel {
  binaryType: "arraybuffer" | "blob";
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  label: string;
  maxPacketLifeTime: number | null;
  maxRetransmits: number | null;
  ordered: boolean;
  readyState: RTCDataChannelState;
  onbufferedamountlow: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: RTCDataChannelMessageEvent) => void) | null;
  onopen: ((event: unknown) => void) | null;
  close(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
}

interface RTCPeerConnection {
  connectionState: RTCPeerConnectionState;
  localDescription: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  addEventListener(type: "connectionstatechange", listener: () => void): void;
  close(): void;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  createDataChannel(label: string, options?: { ordered?: boolean }): RTCDataChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  removeEventListener(type: "connectionstatechange", listener: () => void): void;
}

declare const RTCDataChannel: {
  prototype: RTCDataChannel;
  new (): RTCDataChannel;
};

declare const RTCIceCandidate: {
  prototype: RTCIceCandidate;
  new (candidateInitDict?: RTCIceCandidateInit): RTCIceCandidate;
};

declare const RTCPeerConnection: {
  prototype: RTCPeerConnection;
  new (configuration?: RTCConfiguration): RTCPeerConnection;
};

declare const RTCSessionDescription: {
  prototype: RTCSessionDescriptionInit;
  new (descriptionInitDict: RTCSessionDescriptionInit): RTCSessionDescriptionInit;
};
