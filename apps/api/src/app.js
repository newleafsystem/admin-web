import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { createAssetsRouter } from './routes/assets.js';
import { createHeyGenWebhookRouter, createSocialWebhookRouter } from './routes/webhooks.js';
import { createJobsRouter } from './routes/jobs.js';
import { createPublishingRouter } from './routes/publishing.js';
import { createServiceApiRouter } from './routes/serviceApi.js';
import { createServiceClientsRouter } from './routes/serviceClients.js';
import { createServiceDocsRouter } from './routes/serviceDocs.js';
import { createSmartCollectionsRouter } from './routes/smartCollections.js';
import { createSocialAccountsRouter, createSocialOAuthCallbackRouter } from './routes/socialAccounts.js';
import { createVideoProjectsRouter } from './routes/videoProjects.js';
import { authenticateRequest } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRepository } from './lib/repositoryFactory.js';
import { createHeyGenService } from './services/heygenService.js';
import { createJobStateService } from './services/jobStateService.js';
import { createSocialConfigService } from './services/socialConfigService.js';
import { createSocialOAuthService } from './services/socialOAuthService.js';
import { createSocialPublisherService } from './services/socialPublisherService.js';
import { createYouTubeOAuthService } from './services/youtubeOAuthService.js';
import { createYouTubePublisherService } from './services/youtubePublisherService.js';
import { createVideoAssemblyService } from './services/videoAssemblyService.js';
import { createVideoReviewService } from './services/videoReviewService.js';
import { createVideoStudioService } from './services/videoStudioService.js';
import { createVideoThumbnailService } from './services/videoThumbnailService.js';

export function createApp(options = {}) {
  const repository = options.repository ?? createRepository();
  const heygenService = options.heygenService ?? createHeyGenService();
  const videoAssemblyService =
    options.videoAssemblyService ?? createVideoAssemblyService({ repository, heygenService });
  const jobStateService = options.jobStateService ?? createJobStateService({ repository, videoAssemblyService });
  const socialConfigService = options.socialConfigService ?? createSocialConfigService();
  const socialOAuthService = options.socialOAuthService ?? createSocialOAuthService();
  const youtubeOAuthService = options.youtubeOAuthService ?? createYouTubeOAuthService();
  const videoReviewService = options.videoReviewService ?? createVideoReviewService();
  const videoStudioService = options.videoStudioService ?? createVideoStudioService();
  const videoThumbnailService =
    options.videoThumbnailService ?? createVideoThumbnailService({ repository });
  const youtubePublisherService =
    options.youtubePublisherService ??
    createYouTubePublisherService({ repository, jobStateService, youtubeOAuthService });
  const publisherService =
    options.publisherService ??
    createSocialPublisherService({ repository, jobStateService, youtubePublisherService });
  const services = {
    repository,
    heygenService,
    jobStateService,
    publisherService,
    socialConfigService,
    socialOAuthService,
    videoAssemblyService,
    youtubeOAuthService,
    youtubePublisherService,
    videoReviewService,
    videoStudioService,
    videoThumbnailService,
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
  app.use('/api/v1/service', createServiceDocsRouter());
  app.use('/api/v1/service', createServiceApiRouter(services));

  app.use(authenticateRequest());
  app.use('/api/v1/assets', createAssetsRouter(services));
  app.use('/api/v1/jobs', createJobsRouter(services));
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

  return app;
}
