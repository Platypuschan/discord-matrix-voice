import { FrameClock, Mixer } from "./audio.js";
import { CallSession, type IceServer, type MatrixCandidate } from "./call.js";
import type { Config } from "./config.js";
import type { VoiceSession } from "./discord.js";
import { log } from "./log.js";
import type { MatrixClient, MatrixEvent } from "./matrix.js";

/** What the bridge needs from the Discord side (lets tests fake it). */
export interface VoiceProvider {
  join(): Promise<VoiceSession>;
}

interface ActiveCall {
  roomId: string;
  call: CallSession;
  setup?: Promise<void>;
  voice?: VoiceSession;
  mixer?: Mixer;
  clock?: FrameClock;
}

/**
 * Accepts Matrix 1:1 calls from the one allowed user and connects each call
 * to the configured Discord voice channel for as long as it lasts.
 */
export class Bridge {
  private active: ActiveCall | undefined;
  private readonly encryptedNotified = new Set<string>();
  /** Events are handled strictly in order, so candidates never overtake their invite. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly matrix: MatrixClient,
    private readonly discord: VoiceProvider,
    private readonly config: Config,
  ) {
    matrix.on("invite", (roomId: string, inviter: string) => void this.onInvite(roomId, inviter));
    matrix.on("event", (roomId: string, ev: MatrixEvent) => void this.onEvent(roomId, ev));
  }

  get activeCall(): CallSession | undefined {
    return this.active?.call;
  }

  /** Resolves once the current call is answered and bridged (or has failed). */
  get callSetup(): Promise<void> | undefined {
    return this.active?.setup;
  }

  /** Makes sure the allowed user has an unencrypted room with the bot. */
  async ensureRoom(): Promise<void> {
    const user = this.config.matrix.allowedUser;
    for (const [roomId, room] of this.matrix.rooms) {
      const membership = room.members.get(user);
      if (!room.encrypted && (membership === "join" || membership === "invite")) {
        log.info(`matrix: using room ${roomId} with ${user}`);
        return;
      }
    }
    const roomId = await this.matrix.createDirectRoom(user, this.config.matrix.roomName);
    log.info(`matrix: created unencrypted room ${roomId} and invited ${user}`);
    await this.matrix.sendNotice(roomId, "Start a voice call in this room to join the Discord voice channel. Hang up to leave it.");
  }

  private async onInvite(roomId: string, inviter: string): Promise<void> {
    if (inviter !== this.config.matrix.allowedUser) {
      log.info(`matrix: ignoring invite to ${roomId} from ${inviter}`);
      return;
    }
    try {
      await this.matrix.joinRoom(roomId);
      log.info(`matrix: joined ${roomId} on invite from ${inviter}`);
    } catch (err) {
      log.error(`matrix: joining ${roomId} failed: ${(err as Error).message}`);
    }
  }

  /** Queues one timeline event; the returned promise settles once it is handled. */
  onEvent(roomId: string, ev: MatrixEvent): Promise<void> {
    this.queue = this.queue
      .then(() => this.handleEvent(roomId, ev))
      .catch((err) => log.error(`handling ${ev.type} failed: ${(err as Error).stack}`));
    return this.queue;
  }

  private async handleEvent(roomId: string, ev: MatrixEvent): Promise<void> {
    if (ev.sender === this.matrix.userId) return;
    const allowed = ev.sender === this.config.matrix.allowedUser;
    const c = ev.content ?? {};
    const call = this.active?.call;
    const ours = !!call && this.active!.roomId === roomId && c.call_id === call.callId;

    switch (ev.type) {
      case "m.call.invite":
        if (allowed) await this.onCallInvite(roomId, ev);
        else log.info(`matrix: ignoring call from ${ev.sender}`);
        break;
      case "m.call.candidates":
        if (ours && allowed) await call!.addRemoteCandidates((c.candidates ?? []) as MatrixCandidate[]);
        break;
      case "m.call.negotiate":
        if (ours && allowed && c.description) await call!.negotiate(c.description);
        break;
      case "m.call.select_answer":
        if (ours && c.selected_party_id !== call!.partyId) call!.remoteEnded("answered_elsewhere");
        break;
      case "m.call.hangup":
      case "m.call.reject":
        if (ours) call!.remoteEnded(c.reason ?? ev.type.slice(7));
        break;
      case "m.room.encrypted":
        if (allowed && !this.encryptedNotified.has(roomId)) {
          this.encryptedNotified.add(roomId);
          await this.matrix.sendNotice(
            roomId,
            "This room is encrypted and the bridge can't read it. Please call me from an unencrypted room (I created one for you).",
          );
        }
        break;
    }
  }

  private async onCallInvite(roomId: string, ev: MatrixEvent): Promise<void> {
    const c = ev.content;
    const callId: string | undefined = c.call_id;
    const sdp: string | undefined = c.offer?.sdp;
    if (!callId || !sdp) return;
    if (c.invitee && c.invitee !== this.matrix.userId) return;
    const lifetime = typeof c.lifetime === "number" ? c.lifetime : 60000;
    if ((ev.unsigned?.age ?? 0) > lifetime) {
      log.info(`call ${callId}: invite expired, ignoring`);
      return;
    }
    const version = c.version ?? 0;
    if (this.active && !this.active.call.isEnded) {
      if (this.active.call.callId === callId) return;
      log.info(`call ${callId}: busy with ${this.active.call.callId}, rejecting`);
      await this.matrix.sendEvent(roomId, "m.call.hangup", { call_id: callId, party_id: "busy", version, reason: "user_busy" });
      return;
    }

    log.info(`call ${callId}: incoming from ${ev.sender} in ${roomId}`);
    const call = new CallSession({
      callId,
      version,
      iceServers: await this.iceServers(),
      icePortRange: this.config.webrtc.portRange,
      publicAddresses: this.config.webrtc.publicAddresses,
      send: (type, content) => this.matrix.sendEvent(roomId, type, content),
    });
    call.remotePartyId = c.party_id;
    const active: ActiveCall = { roomId, call };
    this.active = active;
    call.once("ended", () => this.teardown(active));
    // Answering and joining Discord take a while; later events (candidates,
    // hangup) must not wait for that, so it runs outside the event queue.
    active.setup = this.setUpCall(active, sdp);
  }

  private async setUpCall(active: ActiveCall, sdp: string): Promise<void> {
    const { call, roomId } = active;
    const callId = call.callId;
    const joining = this.discord.join();
    joining.catch(() => {}); // handled below
    try {
      await call.answer(sdp);
    } catch (err) {
      log.error(`call ${callId}: answering failed: ${(err as Error).message}`);
      call.hangup("unknown_error");
      joining.then((voice) => voice.leave("call failed")).catch(() => {});
      return;
    }

    let voice: VoiceSession;
    try {
      voice = await joining;
    } catch (err) {
      log.error(`call ${callId}: ${(err as Error).message}`);
      await this.matrix.sendNotice(roomId, `Could not join the Discord voice channel: ${(err as Error).message}`).catch(() => {});
      call.hangup("unknown_error");
      return;
    }
    if (call.isEnded) {
      voice.leave("call already ended");
      return;
    }
    this.connect(active, voice);
    const others = voice.memberCount;
    await this.matrix
      .sendNotice(roomId, `Connected to Discord #${voice.channelName} (${others} ${others === 1 ? "person" : "people"} there).`)
      .catch(() => {});
  }

  private connect(active: ActiveCall, voice: VoiceSession): void {
    const mixer = new Mixer();
    const clock = new FrameClock(() => active.call.sendFrame(mixer.mixFrame()));
    active.voice = voice;
    active.mixer = mixer;
    active.clock = clock;
    active.call.on("audio", (opus: Buffer) => voice.play(opus));
    voice.on("speech", (userId: string, opus: Buffer) => mixer.addPacket(userId, opus));
    voice.on("silence", (userId: string) => mixer.removeSource(userId));
    voice.once("ended", (reason: string) => {
      if (!active.call.isEnded) active.call.hangup(reason === "disconnected" ? "unknown_error" : "user_hangup");
    });
    clock.begin();
    log.info(`call ${active.call.callId}: bridged to Discord #${voice.channelName}`);
  }

  private teardown(active: ActiveCall): void {
    active.clock?.stop();
    active.voice?.leave("call ended");
    active.mixer?.close();
    if (this.active === active) this.active = undefined;
  }

  /** Ends the current call, e.g. on shutdown. */
  shutdown(): void {
    this.active?.call.hangup("user_hangup");
  }

  private async iceServers(): Promise<IceServer[]> {
    const servers: IceServer[] = [];
    if (this.config.webrtc.useHomeserverTurn) {
      const turn = await this.matrix.turnServer();
      if (turn) servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
    if (this.config.webrtc.stunServers.length) servers.push({ urls: this.config.webrtc.stunServers });
    return servers;
  }
}
