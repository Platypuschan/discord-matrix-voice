import { Readable } from "node:stream";
import OpusScript from "opusscript";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
/** Samples per channel in one 20 ms frame. */
export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
export const FRAME_MS = 20;

/**
 * Object-mode stream of Opus packets for the Discord audio player.
 * Keeps at most `maxPackets` queued and drops the oldest ones, so a burst
 * from the network turns into a short skip instead of growing latency.
 */
export class OpusPacketQueue extends Readable {
  private readonly queue: Buffer[] = [];
  private waiting = false;

  constructor(private readonly maxPackets = 10) {
    super({ objectMode: true, highWaterMark: 1 });
  }

  get backlog(): number {
    return this.queue.length;
  }

  pushPacket(packet: Buffer): void {
    if (this.destroyed || packet.length === 0) return;
    if (this.waiting) {
      this.waiting = false;
      this.push(packet);
      return;
    }
    this.queue.push(packet);
    if (this.queue.length > this.maxPackets) {
      this.queue.splice(0, this.queue.length - this.maxPackets);
    }
  }

  override _read(): void {
    const next = this.queue.shift();
    if (next) this.push(next);
    else this.waiting = true;
  }
}

interface Source {
  decoder: OpusScript;
  pending: Buffer;
  frames: Buffer[];
}

/**
 * Mixes the Opus streams of several Discord speakers into one Opus stream.
 * Each source is decoded to 48 kHz stereo PCM and buffered per 20 ms frame;
 * `mixFrame()` takes one frame from every source, sums them and re-encodes.
 */
export class Mixer {
  private readonly sources = new Map<string, Source>();
  private readonly encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);

  constructor(private readonly maxFrames = 10) {
    this.encoder.setBitrate(64000);
  }

  get sourceCount(): number {
    return this.sources.size;
  }

  addPacket(sourceId: string, opus: Buffer): void {
    let source = this.sources.get(sourceId);
    if (!source) {
      source = {
        decoder: new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP),
        pending: Buffer.alloc(0),
        frames: [],
      };
      this.sources.set(sourceId, source);
    }
    let pcm: Buffer;
    try {
      pcm = source.decoder.decode(opus);
    } catch {
      return; // corrupt packet
    }
    let data = source.pending.length ? Buffer.concat([source.pending, pcm]) : pcm;
    while (data.length >= FRAME_BYTES) {
      source.frames.push(Buffer.from(data.subarray(0, FRAME_BYTES)));
      data = data.subarray(FRAME_BYTES);
    }
    source.pending = Buffer.from(data);
    if (source.frames.length > this.maxFrames) {
      source.frames.splice(0, source.frames.length - this.maxFrames);
    }
  }

  removeSource(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.decoder.delete();
    this.sources.delete(sourceId);
  }

  /** Mixed PCM for the next 20 ms, or null when nobody is talking. */
  mixPcm(): Buffer | null {
    const frames: Buffer[] = [];
    for (const source of this.sources.values()) {
      const frame = source.frames.shift();
      if (frame) frames.push(frame);
    }
    if (frames.length === 0) return null;
    if (frames.length === 1) return frames[0]!;
    const out = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      let sum = 0;
      for (const frame of frames) sum += frame.readInt16LE(i);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
    }
    return out;
  }

  /** Mixed and Opus-encoded next 20 ms, or null when nobody is talking. */
  mixFrame(): Buffer | null {
    const pcm = this.mixPcm();
    return pcm ? this.encoder.encode(pcm, FRAME_SAMPLES) : null;
  }

  close(): void {
    for (const id of [...this.sources.keys()]) this.removeSource(id);
    this.encoder.delete();
  }
}

/**
 * Calls `tick` every 20 ms, catching up after timer drift (at most a few
 * frames at once) so the RTP clock keeps pace with real time.
 */
export class FrameClock {
  private timer: NodeJS.Timeout | undefined;
  private start = 0;
  private ticks = 0;

  constructor(private readonly tick: () => void) {}

  begin(): void {
    if (this.timer) return;
    this.start = performance.now();
    this.ticks = 0;
    this.timer = setInterval(() => this.run(), FRAME_MS / 2);
  }

  private run(): void {
    const due = Math.floor((performance.now() - this.start) / FRAME_MS);
    if (due - this.ticks > 5) this.ticks = due - 5;
    while (this.ticks < due) {
      this.ticks++;
      this.tick();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
