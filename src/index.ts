import { Bridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { DiscordBot } from "./discord.js";
import { log } from "./log.js";
import { MatrixClient } from "./matrix.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const matrix = new MatrixClient(config.matrix.homeserver, config.matrix.accessToken);
  const discord = new DiscordBot(config.discord);

  log.info(`matrix: logged in as ${await matrix.whoami()}, accepting calls from ${config.matrix.allowedUser}`);
  await discord.login();

  const bridge = new Bridge(matrix, discord, config);
  matrix.once("ready", () => {
    bridge.ensureRoom().catch((err) => log.error(`matrix: setting up the room failed: ${(err as Error).message}`));
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    bridge.shutdown();
    matrix.stop();
    // Let the hangup event go out before the process exits.
    await new Promise((r) => setTimeout(r, 500));
    await discord.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  await matrix.run();
}

main().catch((err) => {
  const cause = (err as Error).cause as Error | undefined;
  log.error(`${(err as Error).message}${cause?.message ? ` (${cause.message})` : ""}`);
  log.debug((err as Error).stack ?? "");
  process.exit(1);
});
