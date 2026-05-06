const DEFAULT_SYNCABLE_PLATFORMS = ['youtube', 'x', 'linkedin', 'instagram', 'facebook'];

export function startPublicationSyncScheduler({
  publisherService,
  config,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!publisherService?.importChannelPublications || !config?.publicationSyncEnabled) {
    return { started: false, stop: () => {} };
  }

  const intervalMs = Math.max(60_000, Number(config.publicationSyncIntervalMs) || 60 * 60 * 1000);
  const platforms = enabledSyncPlatforms(publisherService);
  if (platforms.length === 0) {
    return { started: false, stop: () => {} };
  }

  let isRunning = false;
  const run = async () => {
    if (isRunning) {
      return;
    }
    isRunning = true;
    try {
      for (const platform of platforms) {
        try {
          const result = await publisherService.importChannelPublications({
            platform,
            maxResults: config.publicationSyncMaxResults,
            actorUid: 'publication-sync-scheduler',
          });
          logger.info?.('Publication sync completed', {
            platform,
            imported: result.imported,
            updated: result.updated,
            scanned: result.scanned,
            accountId: result.account?.id ?? null,
          });
        } catch (error) {
          logger.warn?.('Publication sync failed', {
            platform,
            message: error.message,
            status: error.status ?? null,
          });
        }
      }
    } finally {
      isRunning = false;
    }
  };

  const intervalId = setIntervalFn(() => {
    void run();
  }, intervalMs);
  intervalId.unref?.();

  return {
    started: true,
    intervalMs,
    platforms,
    stop: () => clearIntervalFn(intervalId),
    runNow: run,
  };
}

function enabledSyncPlatforms(publisherService) {
  const enabled = new Set(publisherService.enabledPlatforms ?? DEFAULT_SYNCABLE_PLATFORMS);
  const syncable = publisherService.syncablePlatforms ?? DEFAULT_SYNCABLE_PLATFORMS;
  return syncable.filter((platform) => enabled.has(platform));
}
