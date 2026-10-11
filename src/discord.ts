import { EventEmitter } from "node:events";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { ChannelType, Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { OpusPacketQueue } from "./audio.js";
import { log } from "./log.js";

export interface DiscordOptions {
  token: string;
  guildId: string;
  channelId: string;
}

/** The Discord bot account; joins the configured voice channel on demand. */
export class DiscordBot {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  constructor(private readonly opts: DiscordOptions) {}

  async login(): Promise<void> {
    const ready = new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(this.opts.token);
    await ready;
    const channel = await this.channel();
    log.info(`discord: logged in as ${this.client.user?.tag}, bridging to #${channel.name} in ${channel.guild.name}`);
  }

  async channel(): Promise<VoiceBasedChannel> {
    const channel = await this.client.channels.fetch(this.opts.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(`Discord channel ${this.opts.channelId} is not a voice channel the bot can see`);
    }
    if (channel.guildId !== this.opts.guildId) {
      throw new Error(`Discord channel ${this.opts.channelId} is not in guild ${this.opts.guildId}`);
    }
    return channel;
  }

  /** Joins the voice channel; resolves once audio can flow. */
  async join(): Promise<VoiceSession> {
    const channel = await this.channel();
    const connection = joinVoiceChannel({
      guildId: channel.guild.id,
      channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`could not join Discord voice channel #${channel.name}: ${(err as Error).message}`);
    }
    const humans = channel.members.filter((m) => !m.user.bot).size;
    return new VoiceSession(connection, this.client.user!.id, channel.name, humans);
  }

  destroy(): Promise<void> {
    return this.client.destroy();
  }
}

/**
 * One stay in the voice channel. Emits `speech` (userId, opusPacket) for
 * every packet a member sends, `silence` (userId) when they stop, and
 * `ended` (reason) once the connection is gone for good.
 */
export class VoiceSession extends EventEmitter {
  private readonly player: AudioPlayer;
  private readonly queue = new OpusPacketQueue();
  private ended = false;

  constructor(
    private readonly connection: VoiceConnection,
    private readonly botUserId: string,
    readonly channelName: string,
    readonly memberCount: number,
  ) {
    super();
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Infinity },
    });
    this.player.on("error", (err) => log.warn(`discord: audio player error: ${err.message}`));
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.ended) log.warn("discord: audio player went idle");
    });
    this.player.play(createAudioResource(this.queue, { inputType: StreamType.Opus }));
    connection.subscribe(this.player);

    connection.receiver.speaking.on("start", (userId) => this.listen(userId));
    connection.on("stateChange", (_old, state) => {
      if (state.status === VoiceConnectionStatus.Disconnected) void this.onDisconnected();
      else if (state.status === VoiceConnectionStatus.Destroyed) this.finish("destroyed");
    });
    connection.on("error", (err) => log.warn(`discord: voice connection error: ${err.message}`));
  }

  /** Plays one Opus packet from Matrix into the channel. */
  play(opus: Buffer): void {
    if (!this.ended) this.queue.pushPacket(opus);
  }

  private listen(userId: string): void {
    if (userId === this.botUserId || this.connection.receiver.subscriptions.has(userId)) return;
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
    });
    stream.on("data", (packet: Buffer) => this.emit("speech", userId, packet));
    stream.on("error", (err) => log.debug(`discord: receive stream ${userId}: ${err.message}`));
    stream.once("close", () => this.emit("silence", userId));
  }

  private async onDisconnected(): Promise<void> {
    // Moved to another channel or a brief network issue: give it a chance to reconnect.
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      this.leave("disconnected");
    }
  }

  leave(reason = "left"): void {
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.player.stop(true);
    this.queue.destroy();
    log.info(`discord: left voice channel (${reason})`);
    this.emit("ended", reason);
  }
}
