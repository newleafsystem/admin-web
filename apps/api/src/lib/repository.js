import crypto from 'node:crypto';

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function applyTimestamps(record, timestamp) {
  return {
    ...record,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function listFromMap(map, predicate = () => true) {
  return Array.from(map.values()).filter(predicate).map(copy);
}

function compareUpdatedAtDesc(left, right) {
  return String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? ''));
}

function comparePublishedAtDesc(left, right) {
  return String(right.publishedAt ?? right.updatedAt ?? '').localeCompare(String(left.publishedAt ?? left.updatedAt ?? ''));
}

function loadCollection(map, records, key = 'id') {
  for (const record of records ?? []) {
    if (record?.[key]) {
      map.set(record[key], record);
    }
  }
}

export function createInMemoryRepository({ clock = nowIso, localStorePromise = null } = {}) {
  const jobs = new Map();
  const artifacts = new Map();
  const providerJobs = new Map();
  const webhookEvents = new Map();
  const publishPlans = new Map();
  const publishAttempts = new Map();
  const socialAccounts = new Map();
  const oauthStates = new Map();
  const secrets = new Map();
  const serviceClients = new Map();
  const smartCollections = new Map();
  const recommendationBatches = new Map();
  const marketWatchlists = new Map();
  const marketUniverseSymbols = new Map();
  const appUsers = new Map();
  let hydrated = false;

  async function hydrate() {
    if (hydrated || !localStorePromise) {
      hydrated = true;
      return;
    }
    const localStore = await localStorePromise;
    const persisted = await localStore.readJson('repository.json', {
      jobs: [],
      artifacts: [],
      providerJobs: [],
      webhookEvents: [],
      publishPlans: [],
      publishAttempts: [],
      socialAccounts: [],
      secrets: [],
      serviceClients: [],
      smartCollections: [],
      recommendationBatches: [],
      marketWatchlists: [],
      marketUniverseSymbols: [],
      appUsers: [],
    });
    loadCollection(jobs, persisted.jobs);
    loadCollection(artifacts, persisted.artifacts);
    loadCollection(providerJobs, persisted.providerJobs);
    loadCollection(webhookEvents, persisted.webhookEvents, 'idempotencyKey');
    loadCollection(publishPlans, persisted.publishPlans);
    loadCollection(publishAttempts, persisted.publishAttempts);
    loadCollection(socialAccounts, persisted.socialAccounts);
    loadCollection(secrets, persisted.secrets);
    loadCollection(serviceClients, persisted.serviceClients);
    loadCollection(smartCollections, persisted.smartCollections);
    loadCollection(recommendationBatches, persisted.recommendationBatches);
    loadCollection(marketWatchlists, persisted.marketWatchlists);
    loadCollection(marketUniverseSymbols, persisted.marketUniverseSymbols);
    loadCollection(appUsers, persisted.appUsers);
    hydrated = true;
  }

  async function persist() {
    if (!localStorePromise) {
      return;
    }
    const localStore = await localStorePromise;
    await localStore.writeJson('repository.json', {
      jobs: Array.from(jobs.values()),
      artifacts: Array.from(artifacts.values()),
      providerJobs: Array.from(providerJobs.values()),
      webhookEvents: Array.from(webhookEvents.values()),
      publishPlans: Array.from(publishPlans.values()),
      publishAttempts: Array.from(publishAttempts.values()),
      socialAccounts: Array.from(socialAccounts.values()),
      secrets: Array.from(secrets.values()),
      serviceClients: Array.from(serviceClients.values()),
      smartCollections: Array.from(smartCollections.values()),
      recommendationBatches: Array.from(recommendationBatches.values()),
      marketWatchlists: Array.from(marketWatchlists.values()),
      marketUniverseSymbols: Array.from(marketUniverseSymbols.values()),
      appUsers: Array.from(appUsers.values()),
    });
  }

  return {
    async createJob(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('job');
      const job = applyTimestamps(
        {
          id,
          title: input.title,
          type: input.type ?? 'trade_video',
          status: input.status ?? 'draft',
          sourceType: input.sourceType ?? null,
          ownerUid: input.ownerUid ?? null,
          currentScriptId: null,
          currentVideoArtifactId: null,
          targetDurationSec: input.targetDurationSec ?? null,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      jobs.set(id, job);
      await persist();
      return copy(job);
    },

    async listJobs(filters = {}) {
      await hydrate();
      return listFromMap(jobs, (job) => !filters.status || job.status === filters.status);
    },

    async getJob(jobId) {
      await hydrate();
      return copy(jobs.get(jobId));
    },

    async updateJob(jobId, patch) {
      await hydrate();
      const existing = jobs.get(jobId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      jobs.set(jobId, updated);
      await persist();
      return copy(updated);
    },

    async deleteJob(jobId) {
      await hydrate();
      const existing = jobs.get(jobId);
      if (!existing) return null;

      const deletedArtifacts = [];
      for (const artifact of Array.from(artifacts.values())) {
        if (artifact.jobId === jobId) {
          deletedArtifacts.push(copy(artifact));
          artifacts.delete(artifact.id);
        }
      }

      const deletedProviderJobs = [];
      for (const providerJob of Array.from(providerJobs.values())) {
        if (providerJob.jobId === jobId) {
          deletedProviderJobs.push(copy(providerJob));
          providerJobs.delete(providerJob.id);
        }
      }

      jobs.delete(jobId);
      await persist();
      return {
        job: copy(existing),
        artifacts: deletedArtifacts,
        providerJobs: deletedProviderJobs,
      };
    },

    async createArtifact(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('artifact');
      const artifact = applyTimestamps(
        {
          id,
          jobId: input.jobId,
          kind: input.kind,
          storageProvider: input.storageProvider ?? 'dev-memory',
          storageKey: input.storageKey,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes ?? null,
          checksum: input.checksum ?? null,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      artifacts.set(id, artifact);
      await persist();
      return copy(artifact);
    },

    async getArtifact(artifactId) {
      await hydrate();
      return copy(artifacts.get(artifactId));
    },

    async listArtifactsForJob(jobId) {
      await hydrate();
      return listFromMap(artifacts, (artifact) => artifact.jobId === jobId);
    },

    async createProviderJob(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('providerJob');
      const providerJob = applyTimestamps(
        {
          id,
          jobId: input.jobId,
          provider: input.provider,
          status: input.status ?? 'processing',
          externalId: input.externalId ?? null,
          callbackId: input.callbackId ?? null,
          requestPayload: input.requestPayload ?? null,
          requestPayloadRef: input.requestPayloadRef ?? null,
          lastPolledAt: null,
          lastProviderEventAt: null,
          errorCode: null,
          errorMessage: null,
        },
        timestamp,
      );
      providerJobs.set(id, providerJob);
      await persist();
      return copy(providerJob);
    },

    async getProviderJob(providerJobId) {
      await hydrate();
      return copy(providerJobs.get(providerJobId));
    },

    async findProviderJob(filters) {
      await hydrate();
      const providerJob = Array.from(providerJobs.values()).find((candidate) => {
        if (filters.provider && candidate.provider !== filters.provider) return false;
        if (filters.externalId && candidate.externalId !== filters.externalId) return false;
        if (filters.callbackId && candidate.callbackId !== filters.callbackId) return false;
        if (filters.jobId && candidate.jobId !== filters.jobId) return false;
        return true;
      });
      return copy(providerJob);
    },

    async listProviderJobs(filters = {}) {
      await hydrate();
      return listFromMap(providerJobs, (providerJob) => {
        if (filters.provider && providerJob.provider !== filters.provider) return false;
        if (filters.status && providerJob.status !== filters.status) return false;
        if (filters.jobId && providerJob.jobId !== filters.jobId) return false;
        return true;
      });
    },

    async updateProviderJob(providerJobId, patch) {
      await hydrate();
      const existing = providerJobs.get(providerJobId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      providerJobs.set(providerJobId, updated);
      await persist();
      return copy(updated);
    },

    async recordWebhookEvent(input) {
      await hydrate();
      const existing = webhookEvents.get(input.idempotencyKey);
      if (existing) {
        return { duplicate: true, event: copy(existing) };
      }
      const timestamp = clock();
      const event = applyTimestamps(
        {
          id: makeId('webhookEvent'),
          idempotencyKey: input.idempotencyKey,
          provider: input.provider,
          eventType: input.eventType,
          payload: input.payload,
          verification: input.verification,
        },
        timestamp,
      );
      webhookEvents.set(input.idempotencyKey, event);
      await persist();
      return { duplicate: false, event: copy(event) };
    },

    async createPublishPlan(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('publishPlan');
      const plan = applyTimestamps(
        {
          id,
          jobId: input.jobId,
          status: input.status ?? 'draft',
          scheduledAt: input.scheduledAt ?? null,
          approvedBy: null,
          platforms: input.platforms,
          metadata: input.metadata ?? {},
          createdBy: input.createdBy ?? null,
        },
        timestamp,
      );
      publishPlans.set(id, plan);
      await persist();
      return copy(plan);
    },

    async getPublishPlan(planId) {
      await hydrate();
      return copy(publishPlans.get(planId));
    },

    async listPublishPlans(filters = {}) {
      await hydrate();
      return listFromMap(publishPlans, (plan) => {
        if (filters.jobId && plan.jobId !== filters.jobId) return false;
        if (filters.status && plan.status !== filters.status) return false;
        return true;
      });
    },

    async updatePublishPlan(planId, patch) {
      await hydrate();
      const existing = publishPlans.get(planId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      publishPlans.set(planId, updated);
      await persist();
      return copy(updated);
    },

    async createPublishAttempt(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('publishAttempt');
      const attempt = applyTimestamps(
        {
          id,
          planId: input.planId,
          jobId: input.jobId,
          platform: input.platform,
          connectedAccountId: input.connectedAccountId ?? null,
          status: input.status ?? 'queued',
          providerPostId: input.providerPostId ?? null,
          providerUrl: input.providerUrl ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          attemptNo: input.attemptNo ?? 1,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      publishAttempts.set(id, attempt);
      await persist();
      return copy(attempt);
    },

    async getPublishAttempt(attemptId) {
      await hydrate();
      return copy(publishAttempts.get(attemptId));
    },

    async updatePublishAttempt(attemptId, patch) {
      await hydrate();
      const existing = publishAttempts.get(attemptId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      publishAttempts.set(attemptId, updated);
      await persist();
      return copy(updated);
    },

    async listPublishAttempts(filters = {}) {
      await hydrate();
      return listFromMap(publishAttempts, (attempt) => {
        if (filters.planId && attempt.planId !== filters.planId) return false;
        if (filters.jobId && attempt.jobId !== filters.jobId) return false;
        if (filters.platform && attempt.platform !== filters.platform) return false;
        if (filters.status && attempt.status !== filters.status) return false;
        return true;
      });
    },

    async listSocialAccounts(filters = {}) {
      await hydrate();
      return listFromMap(socialAccounts, (account) => {
        if (filters.platform && account.platform !== filters.platform) return false;
        if (filters.ownerUid && account.ownerUid !== filters.ownerUid) return false;
        return true;
      });
    },

    async getSocialAccount(accountId) {
      await hydrate();
      return copy(socialAccounts.get(accountId));
    },

    async upsertSocialAccount(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('socialAccount');
      const existing = socialAccounts.get(id);
      const account = {
        id,
        platform: input.platform,
        accountName: input.accountName,
        ownerUid: input.ownerUid,
        status: input.status ?? 'connected',
        scopes: input.scopes ?? [],
        tokenSecretRef: input.tokenSecretRef ?? null,
        providerAccountId: input.providerAccountId ?? existing?.providerAccountId ?? null,
        tokenHealth: input.tokenHealth ?? existing?.tokenHealth ?? 'unknown',
        metadata: input.metadata ?? existing?.metadata ?? {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      socialAccounts.set(id, account);
      await persist();
      return copy(account);
    },

    async deleteSocialAccount(accountId) {
      await hydrate();
      const existing = socialAccounts.get(accountId);
      if (!existing) return null;
      socialAccounts.delete(accountId);
      await persist();
      return copy(existing);
    },

    async createOAuthState(input) {
      const timestamp = clock();
      const id = input.id ?? makeId('oauthState');
      const state = applyTimestamps(
        {
          id,
          platform: input.platform,
          actorUid: input.actorUid,
          accountName: input.accountName ?? null,
          reconnectAccountId: input.reconnectAccountId ?? null,
          scopes: input.scopes ?? [],
          redirectAfter: input.redirectAfter ?? null,
          expiresAt: input.expiresAt ?? null,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      oauthStates.set(id, state);
      return copy(state);
    },

    async consumeOAuthState(stateId) {
      const existing = oauthStates.get(stateId);
      if (!existing) return null;
      oauthStates.delete(stateId);
      return copy(existing);
    },

    async putSecret(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('secret');
      const existing = secrets.get(id);
      const secret = {
        id,
        provider: input.provider,
        kind: input.kind,
        value: input.value,
        metadata: input.metadata ?? {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      secrets.set(id, secret);
      await persist();
      return {
        id,
        secretRef: `dev-memory:${id}`,
        provider: secret.provider,
        kind: secret.kind,
        metadata: copy(secret.metadata),
      };
    },

    async getSecret(secretRefOrId) {
      await hydrate();
      const id = String(secretRefOrId ?? '').startsWith('dev-memory:')
        ? String(secretRefOrId).slice('dev-memory:'.length)
        : secretRefOrId;
      return copy(secrets.get(id));
    },

    async createServiceClient(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('serviceClient');
      const client = applyTimestamps(
        {
          id,
          name: input.name,
          contactEmail: input.contactEmail ?? null,
          status: input.status ?? 'active',
          keyId: input.keyId,
          secretRef: input.secretRef,
          scopes: input.scopes ?? ['text_to_heygen'],
          rateLimitPerMinute: input.rateLimitPerMinute ?? null,
          requireSignedRequests: input.requireSignedRequests !== false,
          createdBy: input.createdBy ?? null,
          rotatedAt: input.rotatedAt ?? null,
          revokedAt: input.revokedAt ?? null,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      serviceClients.set(id, client);
      await persist();
      return copy(client);
    },

    async listServiceClients(filters = {}) {
      await hydrate();
      return listFromMap(serviceClients, (client) => {
        if (filters.status && client.status !== filters.status) return false;
        return true;
      });
    },

    async getServiceClient(clientId) {
      await hydrate();
      return copy(serviceClients.get(clientId));
    },

    async findServiceClientByKeyId(keyId) {
      await hydrate();
      const client = Array.from(serviceClients.values()).find((candidate) => candidate.keyId === keyId);
      return copy(client);
    },

    async updateServiceClient(clientId, patch) {
      await hydrate();
      const existing = serviceClients.get(clientId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      serviceClients.set(clientId, updated);
      await persist();
      return copy(updated);
    },

    async createSmartCollection(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('smartCollection');
      const smartCollection = applyTimestamps(
        {
          id,
          name: input.name,
          description: input.description ?? null,
          type: input.type ?? 'content_jobs',
          status: input.status ?? 'active',
          visibility: input.visibility ?? 'team',
          ownerUid: input.ownerUid ?? null,
          criteria: input.criteria ?? {},
          sort: input.sort ?? {},
          columns: input.columns ?? [],
          metadata: input.metadata ?? {},
          createdBy: input.createdBy ?? null,
        },
        timestamp,
      );
      smartCollections.set(id, smartCollection);
      await persist();
      return copy(smartCollection);
    },

    async listSmartCollections(filters = {}) {
      await hydrate();
      return listFromMap(smartCollections, (smartCollection) => {
        if (filters.status && smartCollection.status !== filters.status) return false;
        if (filters.type && smartCollection.type !== filters.type) return false;
        if (filters.ownerUid && smartCollection.ownerUid !== filters.ownerUid) return false;
        return true;
      });
    },

    async getSmartCollection(collectionId) {
      await hydrate();
      return copy(smartCollections.get(collectionId));
    },

    async updateSmartCollection(collectionId, patch) {
      await hydrate();
      const existing = smartCollections.get(collectionId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      smartCollections.set(collectionId, updated);
      await persist();
      return copy(updated);
    },

    async deleteSmartCollection(collectionId) {
      await hydrate();
      const existing = smartCollections.get(collectionId);
      if (!existing) return null;
      smartCollections.delete(collectionId);
      await persist();
      return copy(existing);
    },

    async createRecommendationBatch(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? makeId('recommendationBatch');
      const batch = applyTimestamps(
        {
          id,
          tradeDate: input.tradeDate,
          weekId: input.weekId ?? null,
          title: input.title,
          theme: input.theme ?? '',
          dateRange: input.dateRange ?? '',
          status: input.status ?? 'draft',
          recommendations: input.recommendations ?? [],
          channels: input.channels ?? {},
          publicData: input.publicData ?? null,
          outputArtifacts: input.outputArtifacts ?? {},
          scriptJobId: input.scriptJobId ?? null,
          createdBy: input.createdBy ?? null,
          approvedBy: input.approvedBy ?? null,
          approvedAt: input.approvedAt ?? null,
          publishedBy: input.publishedBy ?? null,
          publishedAt: input.publishedAt ?? null,
          metadata: input.metadata ?? {},
        },
        timestamp,
      );
      recommendationBatches.set(id, batch);
      await persist();
      return copy(batch);
    },

    async listRecommendationBatches(filters = {}) {
      await hydrate();
      return listFromMap(recommendationBatches, (batch) => {
        if (filters.status && batch.status !== filters.status) return false;
        return true;
      }).sort(compareUpdatedAtDesc);
    },

    async getRecommendationBatch(batchId) {
      await hydrate();
      return copy(recommendationBatches.get(batchId));
    },

    async updateRecommendationBatch(batchId, patch) {
      await hydrate();
      const existing = recommendationBatches.get(batchId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      recommendationBatches.set(batchId, updated);
      await persist();
      return copy(updated);
    },

    async getLatestPublishedRecommendationBatch() {
      await hydrate();
      const published = Array.from(recommendationBatches.values()).filter((batch) => batch.status === 'published');
      published.sort(comparePublishedAtDesc);
      return copy(published[0]);
    },

    async getMarketWatchlist(watchlistId) {
      await hydrate();
      return copy(marketWatchlists.get(watchlistId));
    },

    async upsertMarketWatchlist(watchlistId, input) {
      await hydrate();
      const timestamp = clock();
      const existing = marketWatchlists.get(watchlistId);
      const watchlist = {
        ...input,
        id: watchlistId,
        createdAt: existing?.createdAt ?? input.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      marketWatchlists.set(watchlistId, watchlist);
      await persist();
      return copy(watchlist);
    },

    async listMarketUniverseSymbols(filters = {}) {
      await hydrate();
      return listFromMap(marketUniverseSymbols, (symbol) => {
        if (filters.market && symbol.market !== filters.market) return false;
        return symbol.active !== false;
      });
    },

    async listAppUsers() {
      await hydrate();
      return listFromMap(appUsers);
    },

    async getAppUser(userId) {
      await hydrate();
      return copy(appUsers.get(userId));
    },

    async findAppUserByEmail(email) {
      await hydrate();
      const normalizedEmail = String(email ?? '').toLowerCase();
      const user = Array.from(appUsers.values()).find(
        (candidate) => String(candidate.email ?? '').toLowerCase() === normalizedEmail,
      );
      return copy(user);
    },

    async upsertAppUser(input) {
      await hydrate();
      const timestamp = clock();
      const id = input.id ?? input.uid ?? makeId('appUser');
      const existing = appUsers.get(id);
      const user = {
        id,
        uid: input.uid ?? existing?.uid ?? id,
        email: input.email ?? existing?.email ?? null,
        displayName: input.displayName ?? existing?.displayName ?? null,
        photoUrl: input.photoUrl ?? existing?.photoUrl ?? null,
        role: input.role ?? existing?.role ?? 'anonymous',
        roles: input.roles ?? existing?.roles ?? [],
        appAccess: input.appAccess ?? existing?.appAccess ?? {},
        status: input.status ?? existing?.status ?? 'active',
        immutable: Boolean(input.immutable ?? existing?.immutable ?? false),
        accessManagedBy: input.accessManagedBy ?? existing?.accessManagedBy ?? null,
        accessUpdatedAt: input.accessUpdatedAt ?? existing?.accessUpdatedAt ?? null,
        accessUpdatedBy: input.accessUpdatedBy ?? existing?.accessUpdatedBy ?? null,
        firstSeenAt: input.firstSeenAt ?? existing?.firstSeenAt ?? timestamp,
        lastLoginAt: input.lastLoginAt ?? existing?.lastLoginAt ?? null,
        lastLoginContext: input.lastLoginContext ?? existing?.lastLoginContext ?? null,
        roleUpdatedAt: input.roleUpdatedAt ?? existing?.roleUpdatedAt ?? null,
        roleUpdatedBy: input.roleUpdatedBy ?? existing?.roleUpdatedBy ?? null,
        notificationPreferences: input.notificationPreferences ?? existing?.notificationPreferences ?? undefined,
        notificationsUpdatedAt: input.notificationsUpdatedAt ?? existing?.notificationsUpdatedAt ?? null,
        notificationsUpdatedBy: input.notificationsUpdatedBy ?? existing?.notificationsUpdatedBy ?? null,
        metadata: input.metadata ?? existing?.metadata ?? {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      appUsers.set(id, user);
      await persist();
      return copy(user);
    },

    async updateAppUser(userId, patch) {
      await hydrate();
      const existing = appUsers.get(userId);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: clock(),
      };
      appUsers.set(userId, updated);
      await persist();
      return copy(updated);
    },

    async deleteAppUser(userId) {
      await hydrate();
      const existing = appUsers.get(userId);
      if (!existing) return null;
      appUsers.delete(userId);
      await persist();
      return copy(existing);
    },
  };
}
