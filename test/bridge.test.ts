import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift";
import { FRAME_SAMPLES } from "../src/audio.js";
import { Bridge } from "../src/bridge.js";
import { CallSession } from "../src/call.js";
import type { Config } from "../src/config.js";
import type { VoiceSession } from "../src/discord.js";
import type { MatrixClient, MatrixEvent } from "../src/matrix.js";

const ME = "@arne:example.org";
const BOT = "@voicebot:example.org";
const ROOM = "!dm:example.org";

const config: Config = {
  matrix: { homeserver: "https://example.org", accessToken: "x", allowedUser: ME, roomName: "Discord voice" },
  discord: { token: "x", guildId: "1", channelId: "2" },
  webrtc: { publicAddresses: [], stunServers: [], useHomeserverTurn: false },
};

class FakeMatrix extends EventEmitter {
  userId = BOT;
  rooms = new Map();
  sent: { roomId: string; type: string; content: any }[] = [];
  async sendEvent(roomId: string, type: string, content: any) {
    this.sent.push({ roomId, type, content });
    this.emit("sent", type, content);
    return `$${this.sent.length}`;
  }
  async sendNotice(roomId: string, body: string) {
    return this.sendEvent(roomId, "m.room.message", { msgtype: "m.notice", body });
  }
  async turnServer() {
    await new Promise((r) => setTimeout(r, 50)); // a real HTTP round trip
    return undefined;
  }
}

class FakeVoice extends EventEmitter {
  channelName = "general";
  memberCount = 2;
  played: Buffer[] = [];
  left = false;
  play(opus: Buffer) {
    this.played.push(opus);
  }
  leave() {
    if (this.left) return;
    this.left = true;
    this.emit("ended", "left");
  }
}

function waitFor<T>(check: () => T | undefined, ms = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const v = check();
      if (v) {
        clearInterval(timer);
        resolve(v);
      } else if (Date.now() - start > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 20);
  });
}

function ev(type: string, content: any, sender = ME): MatrixEvent {
  return { type, sender, event_id: `$${Math.random()}`, content, unsigned: { age: 10 } };
}

test("a Matrix call from the allowed user is answered and bridged both ways", { timeout: 30000 }, async () => {
  const matrix = new FakeMatrix();
  const voice = new FakeVoice();
  let joins = 0;
  const bridge = new Bridge(matrix as unknown as MatrixClient, {
    join: async () => {
      joins++;
      return voice as unknown as VoiceSession;
    },
  }, config);

  // The caller behaves like Element Web: audio sendrecv plus an unused video m-line.
  const caller = new RTCPeerConnection({});
  const callerTrack = new MediaStreamTrack({ kind: "audio" });
  caller.addTransceiver(callerTrack, { direction: "sendrecv" });
  caller.addTransceiver("video", { direction: "recvonly" });
  const received: Buffer[] = [];
  caller.onTrack.subscribe((track) => {
    if (track.kind === "audio") track.onReceiveRtp.subscribe((rtp) => received.push(rtp.payload));
  });
  await caller.setLocalDescription(await caller.createOffer());
  await waitFor(() => caller.iceGatheringState === "complete" || undefined);

  matrix.on("sent", (type: string, content: any) => {
    if (type === "m.call.answer") void caller.setRemoteDescription(content.answer);
    if (type === "m.call.candidates") {
      for (const c of content.candidates) if (c.candidate) void caller.addIceCandidate(c);
    }
  });

  // Like matrix-js-sdk: the offer goes out first, candidates follow in their own
  // event, delivered right behind the invite in the same sync batch.
  const callId = "call-1";
  const offerSdp = caller.localDescription!.sdp;
  const candidates = offerSdp
    .split("\r\n")
    .filter((l) => l.startsWith("a=candidate:"))
    .map((l) => ({ candidate: l.slice(2), sdpMid: "0", sdpMLineIndex: 0 }));
  assert.ok(candidates.length > 0);
  const delivered: unknown[] = [];
  const original = CallSession.prototype.addRemoteCandidates;
  CallSession.prototype.addRemoteCandidates = function (this: CallSession, list) {
    delivered.push(...list);
    return original.call(this, list);
  };
  try {
    matrix.emit("event", ROOM, ev("m.call.invite", {
      call_id: callId,
      party_id: "caller",
      version: "1",
      lifetime: 60000,
      offer: { type: "offer", sdp: offerSdp.replace(/a=candidate:.*\r\n|a=end-of-candidates\r\n/g, "") },
    }));
    matrix.emit("event", ROOM, ev("m.call.candidates", { call_id: callId, party_id: "caller", version: "1", candidates }));
    await bridge.onEvent(ROOM, ev("m.room.message", { body: "flush" }));
  } finally {
    CallSession.prototype.addRemoteCandidates = original;
  }
  assert.equal(delivered.length, candidates.length, "candidates sent right after the invite reach the call");
  await bridge.callSetup;

  const answer = matrix.sent.find((s) => s.type === "m.call.answer");
  assert.ok(answer, "bridge sent m.call.answer");
  assert.equal(answer.content.call_id, callId);
  assert.equal(answer.content.version, "1");
  assert.match(answer.content.answer.sdp, /opus\/48000\/2/i);
  assert.match(answer.content.answer.sdp, /m=video 0 [^]*a=inactive/);
  assert.equal(joins, 1);
  assert.ok(matrix.sent.some((s) => s.type === "m.room.message" && /Connected to Discord #general/.test(s.content.body)));

  await waitFor(() => caller.connectionState === "connected" || undefined);

  // Matrix -> Discord: caller's Opus packets reach the voice channel unchanged.
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const frame = Buffer.alloc(FRAME_SAMPLES * 4, 1);
  const sentPayloads: Buffer[] = [];
  const sendTimer = setInterval(() => {
    const opus = enc.encode(frame, FRAME_SAMPLES);
    sentPayloads.push(opus);
    callerTrack.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: sentPayloads.length, timestamp: sentPayloads.length * 960, payloadType: 111 }), opus));
  }, 20);
  await waitFor(() => voice.played.length >= 5 || undefined);
  assert.ok(sentPayloads.some((p) => p.equals(voice.played[0]!)), "played packet matches a sent payload");

  // Discord -> Matrix: a member's speech is mixed and sent to the caller.
  const speak = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const speechTimer = setInterval(() => voice.emit("speech", "discord-user", speak.encode(frame, FRAME_SAMPLES)), 20);
  await waitFor(() => received.length >= 5 || undefined);
  const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  assert.equal(dec.decode(received.at(-1)!).length, FRAME_SAMPLES * 4);
  clearInterval(sendTimer);
  clearInterval(speechTimer);

  // A second call while busy is turned away.
  await bridge.onEvent(ROOM, ev("m.call.invite", {
    call_id: "call-2", party_id: "caller", version: "1", lifetime: 60000,
    offer: { type: "offer", sdp: caller.localDescription!.sdp },
  }));
  assert.ok(matrix.sent.some((s) => s.type === "m.call.hangup" && s.content.call_id === "call-2" && s.content.reason === "user_busy"));

  // The caller hangs up: the bot leaves Discord.
  await bridge.onEvent(ROOM, ev("m.call.hangup", { call_id: callId, party_id: "caller", version: "1" }));
  assert.equal(voice.left, true);
  assert.equal(bridge.activeCall, undefined);
  await caller.close();
});

test("calls from other users and expired invites are ignored", async () => {
  const matrix = new FakeMatrix();
  let joins = 0;
  const bridge = new Bridge(matrix as unknown as MatrixClient, {
    join: async () => {
      joins++;
      return new FakeVoice() as unknown as VoiceSession;
    },
  }, config);
  const offer = { type: "offer", sdp: "v=0" };
  await bridge.onEvent(ROOM, ev("m.call.invite", { call_id: "a", version: "1", lifetime: 60000, offer }, "@stranger:example.org"));
  await bridge.onEvent(ROOM, { ...ev("m.call.invite", { call_id: "b", version: "1", lifetime: 60000, offer }), unsigned: { age: 120000 } });
  await bridge.onEvent(ROOM, ev("m.call.invite", { call_id: "c", version: "1", lifetime: 60000, offer, invitee: "@other:example.org" }));
  assert.equal(joins, 0);
  assert.equal(matrix.sent.length, 0);
});

test("the bot leaves the call when Discord drops it", { timeout: 30000 }, async () => {
  const matrix = new FakeMatrix();
  const voice = new FakeVoice();
  const bridge = new Bridge(matrix as unknown as MatrixClient, { join: async () => voice as unknown as VoiceSession }, config);
  const caller = new RTCPeerConnection({});
  caller.addTransceiver("audio", { direction: "sendrecv" });
  await caller.setLocalDescription(await caller.createOffer());
  await bridge.onEvent(ROOM, ev("m.call.invite", {
    call_id: "d", party_id: "caller", version: "1", lifetime: 60000,
    offer: { type: "offer", sdp: caller.localDescription!.sdp },
  }));
  await bridge.callSetup;
  assert.ok(bridge.activeCall);
  voice.leave();
  assert.ok(matrix.sent.some((s) => s.type === "m.call.hangup" && s.content.call_id === "d"));
  assert.equal(bridge.activeCall, undefined);
  await caller.close();
});

test("hanging up while the bot is still joining Discord leaves the channel again", { timeout: 30000 }, async () => {
  const matrix = new FakeMatrix();
  const voice = new FakeVoice();
  let release!: () => void;
  const joined = new Promise<void>((r) => (release = r));
  const bridge = new Bridge(matrix as unknown as MatrixClient, {
    join: async () => {
      await joined;
      return voice as unknown as VoiceSession;
    },
  }, config);
  const caller = new RTCPeerConnection({});
  caller.addTransceiver("audio", { direction: "sendrecv" });
  await caller.setLocalDescription(await caller.createOffer());
  await bridge.onEvent(ROOM, ev("m.call.invite", {
    call_id: "e", party_id: "caller", version: "1", lifetime: 60000,
    offer: { type: "offer", sdp: caller.localDescription!.sdp },
  }));
  const setup = bridge.callSetup!;
  await waitFor(() => matrix.sent.find((s) => s.type === "m.call.answer"));
  await bridge.onEvent(ROOM, ev("m.call.hangup", { call_id: "e", party_id: "caller", version: "1" }));
  assert.equal(bridge.activeCall, undefined);
  release();
  await setup;
  assert.equal(voice.left, true);
  await caller.close();
});
