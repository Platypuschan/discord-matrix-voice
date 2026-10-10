import assert from "node:assert/strict";
import { test } from "node:test";
import OpusScript from "opusscript";
import { FRAME_BYTES, FRAME_SAMPLES, Mixer, OpusPacketQueue } from "../src/audio.js";
import { loadConfig, parsePortRange } from "../src/config.js";

function tone(amplitude: number, freq: number): Buffer {
  const pcm = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 48000));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

function rms(pcm: Buffer): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

test("mixer returns null when nobody talks", () => {
  const mixer = new Mixer();
  assert.equal(mixer.mixFrame(), null);
  mixer.close();
});

test("mixer sums two speakers and clamps", () => {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const mixer = new Mixer();
  // Opus needs a few frames to settle; compare the steady state.
  for (let n = 0; n < 5; n++) {
    mixer.addPacket("a", enc.encode(tone(8000, 440), FRAME_SAMPLES));
  }
  const encB = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  for (let n = 0; n < 5; n++) {
    mixer.addPacket("b", encB.encode(tone(8000, 440), FRAME_SAMPLES));
  }
  let last: Buffer | null = null;
  for (let n = 0; n < 5; n++) last = mixer.mixPcm();
  assert.ok(last);
  // Two in-phase tones of equal level: about twice the single-tone RMS (~5657).
  assert.ok(rms(last!) > 8000, `rms ${rms(last!)}`);
  assert.equal(mixer.mixPcm(), null);
  mixer.removeSource("a");
  assert.equal(mixer.sourceCount, 1);
  mixer.close();
  enc.delete();
  encB.delete();
});

test("mixer bounds each speaker's backlog", () => {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const mixer = new Mixer(3);
  for (let n = 0; n < 10; n++) mixer.addPacket("a", enc.encode(tone(1000, 300), FRAME_SAMPLES));
  let frames = 0;
  while (mixer.mixPcm()) frames++;
  assert.equal(frames, 3);
  mixer.close();
  enc.delete();
});

test("mixer output is valid opus", () => {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const mixer = new Mixer();
  mixer.addPacket("a", enc.encode(tone(5000, 440), FRAME_SAMPLES));
  const opus = mixer.mixFrame();
  assert.ok(opus && opus.length > 0);
  assert.equal(dec.decode(opus!).length, FRAME_BYTES);
  mixer.close();
});

test("packet queue drops the oldest packets", async () => {
  const q = new OpusPacketQueue(3);
  for (let n = 0; n < 6; n++) q.pushPacket(Buffer.from([n]));
  const got: number[] = [];
  let p: Buffer | null;
  while ((p = q.read())) got.push(p[0]!);
  assert.deepEqual(got, [3, 4, 5]);
  assert.equal(q.read(), null);
  q.pushPacket(Buffer.from([9]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(q.read(), Buffer.from([9]));
});

test("config parsing", () => {
  assert.deepEqual(parsePortRange("40000-40100"), [40000, 40100]);
  assert.equal(parsePortRange(""), undefined);
  assert.throws(() => parsePortRange("80-90"));
  const env = {
    MATRIX_HOMESERVER_URL: "https://matrix.example.org",
    MATRIX_ACCESS_TOKEN: "t",
    MATRIX_ALLOWED_USER: "@me:example.org",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_VOICE_CHANNEL_ID: "2",
    WEBRTC_PUBLIC_IP: "203.0.113.5",
  };
  const config = loadConfig(env);
  assert.deepEqual(config.webrtc.publicAddresses, ["203.0.113.5"]);
  assert.equal(config.webrtc.useHomeserverTurn, true);
  assert.throws(() => loadConfig({ ...env, MATRIX_ALLOWED_USER: "me" }));
  assert.throws(() => loadConfig({ ...env, DISCORD_BOT_TOKEN: "" }));
});
