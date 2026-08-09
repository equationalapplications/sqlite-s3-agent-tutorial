import { loadConfig } from './config.js';
import { runFetch } from './agent/fetch.js';
import { createLocalEmbedder } from './embed/local.js';
import { createLocalTemplateFormatter } from './format/local.js';
import { createFetchDiscordPoster } from './discord/poster.js';
import { createSourceFetcher } from './sources/index.js';
import { createLocalStore } from './store/local.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = createLocalStore('/tmp/sqlite-s3-agent-tutorial-store');

  const result = await runFetch({
    dbPath: config.dbPath,
    store,
    storeKey: 'memory.db',
    sources: config.sources.map((name) => createSourceFetcher(name, config.weatherLocation)),
    poster: createFetchDiscordPoster(config.discordWebhookUrl),
    formatter: createLocalTemplateFormatter(),
    embedder: createLocalEmbedder(),
    weatherLocation: config.weatherLocation,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
