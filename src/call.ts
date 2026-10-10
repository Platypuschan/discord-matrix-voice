import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  type RTCIceCandidate,
} from "werift";
import { FRAME_SAMPLES } from "./audio.js";
import { log } from "./log.js";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CallOptions {
  callId: string;
  /** Our party id; random when omitted. */
  partyId?: string;
  /** Protocol version the caller used ("1" or 0). */
  version: string | number;
  iceServers: IceServer[];
  icePortRange?: [number, number];
  publicAddresses?: string[];
  /** Sends a call event (m.call.*) to the room. */
  send: (type: string, content: Record<string, unknown>) => Promise<unknown>;
}

export interface MatrixCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

const GATHER_TIMEOUT_MS = 5000;
const DISCONNECT_GRACE_MS = 15000;

/**
 * The callee side of one Matrix 1:1 VoIP call (m.call.* events), backed by a
 * werift peer connection with a single bidirectional Opus audio track.
 *
 * Emits `audio` (Opus payload) for every packet from the caller, `connected`
 * once media flows, and `ended` (reason) exactly once.
 */
export class CallSession extends EventEmitter {
  readonly callId: string;
  readonly partyId: string;
  remotePartyId: string | undefined;
  private readonly pc: RTCPeerConnection;
  private readonly track = new MediaStreamTrack({ kind: "audio" });
  private readonly pendingCandidates: MatrixCandidate[] = [];
  private remoteSet = false;
  private answered = false;
  private ended = false;
  private disconnectTimer: NodeJS.Timeout | undefined;
  private seq = randomBytes(2).readUInt16BE();
  private timestamp = randomBytes(4).readUInt32BE();
  private talking = false;
  private lastRemoteSeq: number | undefined;

  constructor(private readonly opts: CallOptions) {
    super();
    this.callId = opts.callId;
    this.partyId = opts.partyId ?? randomBytes(8).toString("hex");
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      icePortRange: opts.icePortRange,
      iceAdditionalHostAddresses: opts.publicAddresses,
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
            parameters: "minptime=10;useinbandfec=1",
          }),
        ],
        // Only so a video m-line in the offer can be answered; it is set inactive.
        video: [new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000 })],
      },
    });
    this.pc.addTransceiver(this.track, { direction: "sendrecv" });
    this.pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => this.onRemoteRtp(rtp));
    });
    this.pc.connectionStateChange.subscribe((state) => this.onConnectionState(state));
    this.pc.onIceCandidate.subscribe((candidate) => this.onLocalCandidate(candidate));
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private base(): Record<string, unknown> {
    return { call_id: this.callId, party_id: this.partyId, version: this.opts.version };
  }

  /** Answers the caller's offer and sends m.call.answer. */
  async answer(offerSdp: string): Promise<void> {
    await this.setRemoteOffer(offerSdp);
    this.remoteSet = true;
    await this.flushCandidates();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    // Send the answer with all candidates we can gather quickly; later ones trickle.
    await this.waitForGathering();
    if (this.ended) return;
    await this.opts.send("m.call.answer", {
      ...this.base(),
      answer: { type: "answer", sdp: this.pc.localDescription!.sdp },
    });
    this.answered = true;
    log.info(`call ${this.callId}: answered`);
  }

  /** Handles m.call.negotiate (e.g. hold/resume) from the caller. */
  async negotiate(description: { type: string; sdp: string }): Promise<void> {
    if (description.type !== "offer") return;
    await this.setRemoteOffer(description.sdp);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.opts.send("m.call.negotiate", {
      ...this.base(),
      description: { type: "answer", sdp: this.pc.localDescription!.sdp },
      lifetime: 30000,
    });
  }

  /** Applies an offer; video m-lines (video calls, screen sharing) are declined. */
  private async setRemoteOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    for (const transceiver of this.pc.getTransceivers()) {
      if (transceiver.kind !== "audio") transceiver.setDirection("inactive");
    }
  }

  async addRemoteCandidates(candidates: MatrixCandidate[]): Promise<void> {
    this.pendingCandidates.push(...candidates);
    if (this.remoteSet) await this.flushCandidates();
  }

  private async flushCandidates(): Promise<void> {
    for (const c of this.pendingCandidates.splice(0)) {
      if (!c.candidate) continue; // end-of-candidates marker
      try {
        await this.pc.addIceCandidate({
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? undefined,
          sdpMLineIndex: c.sdpMLineIndex ?? undefined,
        });
      } catch (err) {
        log.debug(`call ${this.callId}: ignoring candidate: ${(err as Error).message}`);
      }
    }
  }

  private waitForGathering(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      const sub = this.pc.iceGatheringStateChange.subscribe((state) => {
        if (state === "complete") done();
      });
      function done() {
        clearTimeout(timer);
        sub.unSubscribe();
        resolve();
      }
    });
  }

  private onLocalCandidate(candidate: RTCIceCandidate | undefined): void {
    // Candidates found before the answer are already in its SDP.
    if (!this.answered || this.ended) return;
    const c = candidate
      ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex }
      : { candidate: "", sdpMid: "0", sdpMLineIndex: 0 };
    this.opts.send("m.call.candidates", { ...this.base(), candidates: [c] }).catch((err) => {
      log.warn(`call ${this.callId}: sending candidate failed: ${(err as Error).message}`);
    });
  }

  private onConnectionState(state: string): void {
    log.debug(`call ${this.callId}: peer connection ${state}`);
    clearTimeout(this.disconnectTimer);
    if (state === "connected") {
      this.emit("connected");
    } else if (state === "failed") {
      this.hangup("ice_failed");
    } else if (state === "disconnected") {
      this.disconnectTimer = setTimeout(() => this.hangup("ice_timeout"), DISCONNECT_GRACE_MS);
    } else if (state === "closed") {
      this.finish("closed");
    }
  }

  private onRemoteRtp(rtp: RtpPacket): void {
    if (this.ended || rtp.payload.length === 0) return;
    const seq = rtp.header.sequenceNumber;
    if (this.lastRemoteSeq !== undefined) {
      const delta = (seq - this.lastRemoteSeq + 0x10000) & 0xffff;
      if (delta === 0 || delta > 0x8000) return; // duplicate or late packet
    }
    this.lastRemoteSeq = seq;
    this.emit("audio", rtp.payload);
  }

  /**
   * Sends the next 20 ms to the caller. `null` means silence: nothing is
   * sent, but the RTP clock still advances (like Opus DTX).
   */
  sendFrame(opus: Buffer | null): void {
    if (this.ended) return;
    if (opus) {
      const header = new RtpHeader({
        sequenceNumber: this.seq,
        timestamp: this.timestamp,
        marker: !this.talking,
        payloadType: 111,
      });
      this.track.writeRtp(new RtpPacket(header, opus));
      this.seq = (this.seq + 1) & 0xffff;
      this.talking = true;
    } else {
      this.talking = false;
    }
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
  }

  /** Ends the call from our side and tells the caller. */
  hangup(reason = "user_hangup"): void {
    if (this.ended) return;
    this.opts.send("m.call.hangup", { ...this.base(), reason }).catch((err) => {
      log.warn(`call ${this.callId}: sending hangup failed: ${(err as Error).message}`);
    });
    this.finish(reason);
  }

  /** The caller hung up, or another device answered. */
  remoteEnded(reason: string): void {
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.disconnectTimer);
    this.pc.close().catch(() => {});
    log.info(`call ${this.callId}: ended (${reason})`);
    this.emit("ended", reason);
  }
}
