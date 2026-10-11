export interface Config {
  matrix: {
    homeserver: string;
    accessToken: string;
    allowedUser: string;
    roomName: string;
  };
  discord: {
    token: string;
    guildId: string;
    channelId: string;
  };
  webrtc: {
    portRange?: [number, number];
    publicAddresses: string[];
    stunServers: string[];
    useHomeserverTurn: boolean;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePortRange(value: string | undefined): [number, number] | undefined {
  if (!value?.trim()) return undefined;
  const m = /^(\d+)-(\d+)$/.exec(value.trim());
  const min = Number(m?.[1]);
  const max = Number(m?.[2]);
  if (!m || min < 1024 || max > 65535 || min > max) {
    throw new Error(`WEBRTC_PORT_RANGE must look like 40000-40100 (got "${value}")`);
  }
  return [min, max];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedUser = required(env, "MATRIX_ALLOWED_USER");
  if (!/^@[^:]+:.+$/.test(allowedUser)) throw new Error(`MATRIX_ALLOWED_USER must be a full user id like @me:example.org`);
  return {
    matrix: {
      homeserver: required(env, "MATRIX_HOMESERVER_URL"),
      accessToken: required(env, "MATRIX_ACCESS_TOKEN"),
      allowedUser,
      roomName: env.MATRIX_ROOM_NAME?.trim() || "Discord voice",
    },
    discord: {
      token: required(env, "DISCORD_BOT_TOKEN"),
      guildId: required(env, "DISCORD_GUILD_ID"),
      channelId: required(env, "DISCORD_VOICE_CHANNEL_ID"),
    },
    webrtc: {
      portRange: parsePortRange(env.WEBRTC_PORT_RANGE),
      publicAddresses: list(env.WEBRTC_PUBLIC_IP),
      stunServers: list(env.STUN_SERVERS ?? "stun:stun.l.google.com:19302"),
      useHomeserverTurn: (env.USE_HOMESERVER_TURN ?? "true").toLowerCase() !== "false",
    },
  };
}
