import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { createAssetsRouter } from './routes/assets.js';
import { createHeyGenWebhookRouter, createSocialWebhookRouter } from './routes/webhooks.js';
import { createJobsRouter } from './routes/jobs.js';
import { createPublishingRouter } from './routes/publishing.js';
import { createMarketDataRouter } from './routes/marketData.js';
import { createPublicAssetsRouter } from './routes/publicAssets.js';
import { createServiceApiRouter } from './routes/serviceApi.js';
import { createServiceClientsRouter } from './routes/serviceClients.js';
import { createServiceDocsRouter } from './routes/serviceDocs.js';
import { createSmartCollectionsRouter } from './routes/smartCollections.js';
import { createSocialAccountsRouter, createSocialOAuthCallbackRouter } from './routes/socialAccounts.js';
import { createAuthSessionRouter } from './routes/authSession.js';
import { createFirestoreBridgeRouter, createPublicFirestoreBridgeRouter } from './routes/firestoreBridge.js';
import { createUsersRouter } from './routes/users.js';
import { createVideoProjectsRouter } from './routes/videoProjects.js';
import { createWatchlistsRouter } from './routes/watchlists.js';
import { authenticateRequest } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRepository } from './lib/repositoryFactory.js';
import { deleteObjectStorageArtifact, deleteObjectStoragePrefix, shouldUseObjectStorage } from './lib/assetStorage.js';
import { createHeyGenService } from './services/heygenService.js';
import { createJobStateService } from './services/jobStateService.js';
import { createSocialConfigService } from './services/socialConfigService.js';
import { createSocialOAuthService } from './services/socialOAuthService.js';
import { createSocialPublisherService } from './services/socialPublisherService.js';
import { startPublicationSyncScheduler } from './services/publicationSyncScheduler.js';
import { createYouTubeOAuthService } from './services/youtubeOAuthService.js';
import { createYouTubePublisherService } from './services/youtubePublisherService.js';
import { createUserAccessService } from './services/userAccessService.js';
import { createVideoAssemblyService } from './services/videoAssemblyService.js';
import { createVideoReviewService } from './services/videoReviewService.js';
import { createVideoStudioService } from './services/videoStudioService.js';
import { createVideoThumbnailService } from './services/videoThumbnailService.js';
import { createWatchlistService } from './services/watchlistService.js';

export function createApp(options = {}) {
  const repository = options.repository ?? createRepository();
  const heygenService = options.heygenService ?? createHeyGenService();
  const userAccessService = options.userAccessService ?? createUserAccessService({ repository });
  const videoThumbnailService =
    options.videoThumbnailService ?? createVideoThumbnailService({ repository });
  const videoAssemblyService =
    options.videoAssemblyService ??
    createVideoAssemblyService({ repository, heygenService, videoThumbnailService });
  const jobStateService = options.jobStateService ?? createJobStateService({ repository, videoAssemblyService });
  const socialConfigService = options.socialConfigService ?? createSocialConfigService();
  const socialOAuthService = options.socialOAuthService ?? createSocialOAuthService();
  const youtubeOAuthService = options.youtubeOAuthService ?? createYouTubeOAuthService();
  const videoReviewService = options.videoReviewService ?? createVideoReviewService();
  const videoStudioService = options.videoStudioService ?? createVideoStudioService();
  const watchlistService = options.watchlistService ?? createWatchlistService({ repository });
  const youtubePublisherService =
    options.youtubePublisherService ??
    createYouTubePublisherService({ repository, jobStateService, youtubeOAuthService });
  const publisherService =
    options.publisherService ??
    createSocialPublisherService({ repository, jobStateService, youtubePublisherService });
  const artifactStorageService = options.artifactStorageService ?? {
    deleteObjectStorageArtifact,
    deleteObjectStoragePrefix,
    shouldUseObjectStorage,
  };
  const services = {
    artifactStorageService,
    repository,
    heygenService,
    jobStateService,
    publisherService,
    socialConfigService,
    socialOAuthService,
    userAccessService,
    videoAssemblyService,
    youtubeOAuthService,
    youtubePublisherService,
    videoReviewService,
    videoStudioService,
    videoThumbnailService,
    watchlistService,
  };

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') ?? crypto.randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });

  app.use(corsMiddleware());

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      service: 'newleaf-api',
      requestId: req.requestId,
    });
  });

  app.get('/api/v1/health', (req, res) => {
    res.json({
      ok: true,
      service: 'newleaf-api',
      requestId: req.requestId,
    });
  });

  app.use(
    '/api/v1/webhooks/heygen',
    express.raw({ type: '*/*', limit: '1mb' }),
    createHeyGenWebhookRouter(services),
  );

  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use('/api/v1/webhooks/social', createSocialWebhookRouter(services));
  app.use('/api/v1/social', createSocialOAuthCallbackRouter(services));
  app.use('/api/v1/service', createServiceDocsRouter(services));
  app.use('/api/v1/service', createServiceApiRouter(services));
  app.use('/api/auth', createAuthSessionRouter(services));
  app.use('/api/v1/public', createPublicAssetsRouter(services));
  app.use('/api/v1/public/firestore', createPublicFirestoreBridgeRouter());

  app.use(authenticateRequest({ repository, userAccessService }));
  app.use('/api/v1/firestore', createFirestoreBridgeRouter());
  app.use('/api/v1', createUsersRouter(services));
  app.use('/api/v1', createWatchlistsRouter(services));
  app.use('/api/v1/assets', createAssetsRouter(services));
  app.use('/api/v1/jobs', createJobsRouter(services));
  app.use('/api/v1/market', createMarketDataRouter(services));
  app.use('/api/v1', createVideoProjectsRouter(services));
  app.use('/api/v1', createPublishingRouter(services));
  app.use('/api/v1', createServiceClientsRouter(services));
  app.use('/api/v1', createSmartCollectionsRouter(services));
  app.use('/api/v1/social', createSocialAccountsRouter(services));

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (config.social.autoResumeQueuedUploads && options.autoResumeQueuedUploads !== false) {
    setTimeout(() => {
      publisherService.resumeQueuedAttempts().catch((error) => {
        console.error('Unable to resume queued publisher uploads', error);
      });
    }, 0);
  }

  if (options.autoSyncPublications !== false) {
    startPublicationSyncScheduler({
      publisherService,
      config: config.social,
    });
  }

  return app;
}
