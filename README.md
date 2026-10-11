# discord-matrix-voice

A personal bridge from a Matrix voice call to a Discord voice channel.

You call the bot from Matrix. The bot joins a configured Discord voice
channel and connects the two: you hear everyone in the channel, and they hear
you. When you hang up, the bot leaves the channel.

```
Element (you) ── Matrix 1:1 call (WebRTC, Opus) ──► bot ──► Discord voice channel
              ◄── mixed audio of the channel ─────── bot ◄── (DAVE end-to-end encrypted)
```

- **One user.** Only calls from `MATRIX_ALLOWED_USER` are accepted; everyone
  else is ignored. One call at a time; a second call gets "busy".
- **Audio only.** Video and screen sharing in the call are declined.
- **Discord → Matrix:** each Discord speaker is decoded, mixed and re-encoded
  as one Opus stream to you.
- **Matrix → Discord:** your Opus packets are forwarded to Discord without
  transcoding.

## Requirements

- **A Matrix client that places classic 1:1 calls** (`m.call.*`): Element Web
  or Element Desktop in a two-person room. Element X only does Element Call
  (MatrixRTC) and is not supported. If your Element Web config sets
  `element_call.use_exclusively`, its call button won't work for this either.
- **An unencrypted room.** The bot has no end-to-end encryption, so it can't
  read call events in an encrypted room. On first start it creates an
  unencrypted room with you and invites you; call it from there. The call
  audio itself is still encrypted (DTLS-SRTP), as in every WebRTC call; only
  the call setup messages are readable by your homeserver.
- **A Discord bot** with View Channel, Connect and Speak permissions in the
  voice channel. No privileged intents are needed.
- **Network reachability** between your client and the bot for the media
  stream, see [Networking](#networking).

## Setup

### 1. Matrix bot account

Register a separate account for the bot (e.g. `@voicebot:example.org`) and get
an access token:

```sh
curl -s -X POST https://matrix.example.org/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"voicebot"},
       "password":"…","initial_device_display_name":"discord-matrix-voice"}'
```

Use `access_token` from the response as `MATRIX_ACCESS_TOKEN`.

### 2. Discord bot

1. Create an application at <https://discord.com/developers/applications>,
   then on **Bot** reset and copy the token (`DISCORD_BOT_TOKEN`).
2. Invite it to your server (replace `APP_ID`; 3146752 = View Channel +
   Connect + Speak):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=3146752`
3. Turn on Developer Mode in Discord, then right-click the server →
   *Copy Server ID* (`DISCORD_GUILD_ID`) and the voice channel → *Copy Channel
   ID* (`DISCORD_VOICE_CHANNEL_ID`).

### 3. Run it

Copy `.env.example` to `.env` and fill it in, then:

```sh
podman build -t discord-matrix-voice .
podman run -d --name discord-matrix-voice --env-file .env --network host discord-matrix-voice
```

Or without a container (Node.js 22+):

```sh
npm ci && npm run build
set -a; . ./.env; set +a; npm start
```

On first start the bot invites you to a room named "Discord voice". Accept it,
press the call button, and you're in the Discord channel.

## Networking

The media goes directly between your Matrix client and the bot over UDP
(WebRTC ICE). The bot offers these routes:

- **Homeserver TURN** (default): if your homeserver has a TURN server
  configured (Synapse `turn_uris`), the bot fetches credentials for each call,
  just like Element does. This is the most reliable option.
- **STUN** to discover its public address (`STUN_SERVERS`).
- **Port forwarding:** set `WEBRTC_PORT_RANGE` (e.g. `40000-40100`), forward
  that UDP range to the bot, and set `WEBRTC_PUBLIC_IP` to your public address.

With `--network host` the bot sees the host's interfaces directly. With a
bridged container network, publish the UDP port range (`-p
40000-40100:40000-40100/udp`) and set `WEBRTC_PUBLIC_IP`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `MATRIX_HOMESERVER_URL` | yes | Client-server API URL of the bot's homeserver |
| `MATRIX_ACCESS_TOKEN` | yes | Access token of the bot account |
| `MATRIX_ALLOWED_USER` | yes | The one user who may call, e.g. `@you:example.org` |
| `MATRIX_ROOM_NAME` | no | Name of the room the bot creates (default `Discord voice`) |
| `DISCORD_BOT_TOKEN` | yes | Discord bot token |
| `DISCORD_GUILD_ID` | yes | Server ID |
| `DISCORD_VOICE_CHANNEL_ID` | yes | Voice channel ID |
| `WEBRTC_PORT_RANGE` | no | UDP port range for media, e.g. `40000-40100` |
| `WEBRTC_PUBLIC_IP` | no | Extra public address(es) to advertise, comma-separated |
| `USE_HOMESERVER_TURN` | no | `false` to skip the homeserver's TURN server |
| `STUN_SERVERS` | no | Comma-separated STUN URLs (default Google's); empty disables |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error` |

## Notes

- People in the Discord channel hear you through a bot. Let them know the
  channel is bridged.
- Discord does not officially document receiving voice for bots. It works
  with `@discordjs/voice` today but could break with Discord changes.
- Discord voice is end-to-end encrypted (DAVE) since March 2026; the bot
  supports it through `@snazzah/davey`.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests include a full WebRTC loopback: a werift peer acting as Element
calls the bridge, and audio is checked in both directions.

## License

MIT
