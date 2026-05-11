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

function stripUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((item) => item !== undefined);
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const cleaned = stripUndefined(child);
    if (cleaned !== undefined) {
      result[key] = cleaned;
    }
  }
  return result;
}

function safeWebhookEventId(idempotencyKey) {
  return Buffer.from(String(idempotencyKey), 'utf8').toString('base64url');
}

function maybeSecretId(secretRefOrId) {
  const value = String(secretRefOrId ?? '');
  if (value.startsWith('firestore-secret:')) {
    return value.slice('firestore-secret:'.length);
  }
  if (value.startsWith('dev-memory:')) {
    return value.slice('dev-memory:'.length);
  }
  return value;
}

function defaultCollections(prefix = '') {
  const normalizedPrefix = prefix ? `${prefix.replace(/_+$/, '')}_` : '';
  return {
    jobs: `${normalizedPrefix}contentJobs`,
    artifacts: `${normalizedPrefix}artifacts`,
    providerJobs: `${normalizedPrefix}providerJobs`,
    webhookEvents: `${normalizedPrefix}webhookEvents`,
    publishPlans: `${normalizedPrefix}publishPlans`,
    publishAttempts: `${normalizedPrefix}publishAttempts`,
    socialAccounts: `${normalizedPrefix}connectedAccounts`,
    oauthStates: `${normalizedPrefix}oauthStates`,
    secrets: `${normalizedPrefix}repositorySecrets`,
    serviceClients: `${normalizedPrefix}serviceClients`,
    smartCollections: `${normalizedPrefix}smartCollections`,
    marketWatchlists: `${normalizedPrefix}marketWatchlists`,
    appUsers: `${normalizedPrefix}users`,
  };
}

export function createFirestoreRepository({
  firestorePromise,
  getFirestore = null,
  clock = nowIso,
  collectionPrefix = '',
} = {}) {
  const collections = defaultCollections(collectionPrefix);

  async function db() {
    const firestore = await (firestorePromise ?? getFirestore?.());
    if (!firestore) {
      throw new Error(
        'Firestore repository is enabled, but Firebase Admin could not initialize. ' +
          'Set FIREBASE_USE_APPLICATION_DEFAULT=true on Cloud Run or provide Firebase credentials.',
      );
    }
    return firestore;
  }

  async function collection(name) {
    return (await db()).collection(collections[name]);
  }

  async function getRecord(collectionName, id) {
    if (!id) return undefined;
    const snapshot = await (await collection(collectionName)).doc(id).get();
    return snapshot.exists ? copy(snapshot.data()) : undefined;
  }

  async function setRecord(collectionName, id, record) {
    const cleaned = stripUndefined(record);
    await (await collection(collectionName)).doc(id).set(cleaned);
    return copy(cleaned);
  }

  async function updateRecord(collectionName, id, patch) {
    const existing = await getRecord(collectionName, id);
    if (!existing) return null;
    return setRecord(collectionName, id, {
      ...existing,
      ...patch,
      updatedAt: clock(),
    });
  }

  async function listRecords(collectionName, predicate = () => true) {
    const snapshot = await (await collection(collectionName)).get();
    return snapshot.docs
      .map((doc) => doc.data())
      .filter(predicate)
      .sort(compareCreatedAt)
      .map(copy);
  }

  async function deleteRecord(collectionName, id) {
    const existing = await getRecord(collectionName, id);
    if (!existing) return null;
    await (await collection(collectionName)).doc(id).delete();
    return copy(existing);
  }

  async function deleteWhere(collectionName, predicate) {
    const records = await listRecords(collectionName, predicate);
    if (records.length === 0) {
      return [];
    }

    const firestore = await db();
    let batch = firestore.batch();
    let pending = 0;
    const collectionRef = await collection(collectionName);

    for (const record of records) {
      batch.delete(collectionRef.doc(record.id));
      pending += 1;
      if (pending === 450) {
        await batch.commit();
        batch = firestore.batch();
        pending = 0;
      }
    }

    if (pending > 0) {
      await batch.commit();
    }

    return records;
  }

  return {
    async createJob(input) {
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
      return setRecord('jobs', id, job);
    },

    async listJobs(filters = {}) {
      return listRecords('jobs', (job) => !filters.status || job.status === filters.status);
    },

    async getJob(jobId) {
      return getRecord('jobs', jobId);
    },

    async updateJob(jobId, patch) {
      return updateRecord('jobs', jobId, patch);
    },

    async deleteJob(jobId) {
      const existing = await deleteRecord('jobs', jobId);
      if (!existing) return null;

      const [deletedArtifacts, deletedProviderJobs] = await Promise.all([
        deleteWhere('artifacts', (artifact) => artifact.jobId === jobId),
        deleteWhere('providerJobs', (providerJob) => providerJob.jobId === jobId),
      ]);

      return {
        job: copy(existing),
        artifacts: deletedArtifacts,
        providerJobs: deletedProviderJobs,
      };
    },

    async createArtifact(input) {
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
      return setRecord('artifacts', id, artifact);
    },

    async getArtifact(artifactId) {
      return getRecord('artifacts', artifactId);
    },

    async listArtifactsForJob(jobId) {
      return listRecords('artifacts', (artifact) => artifact.jobId === jobId);
    },

    async createProviderJob(input) {
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
      return setRecord('providerJobs', id, providerJob);
    },

    async getProviderJob(providerJobId) {
      return getRecord('providerJobs', providerJobId);
    },

    async findProviderJob(filters) {
      const matches = await listRecords('providerJobs', (candidate) => {
        if (filters.provider && candidate.provider !== filters.provider) return false;
        if (filters.externalId && candidate.externalId !== filters.externalId) return false;
        if (filters.callbackId && candidate.callbackId !== filters.callbackId) return false;
        if (filters.jobId && candidate.jobId !== filters.jobId) return false;
        return true;
      });
      return copy(matches[0]);
    },

    async listProviderJobs(filters = {}) {
      return listRecords('providerJobs', (providerJob) => {
        if (filters.provider && providerJob.provider !== filters.provider) return false;
        if (filters.status && providerJob.status !== filters.status) return false;
        if (filters.jobId && providerJob.jobId !== filters.jobId) return false;
        return true;
      });
    },

    async updateProviderJob(providerJobId, patch) {
      return updateRecord('providerJobs', providerJobId, patch);
    },

    async recordWebhookEvent(input) {
      const firestore = await db();
      const eventId = safeWebhookEventId(input.idempotencyKey);
      const collectionRef = await collection('webhookEvents');
      const eventRef = collectionRef.doc(eventId);

      return firestore.runTransaction(async (transaction) => {
        const existingSnapshot = await transaction.get(eventRef);
        if (existingSnapshot.exists) {
          return { duplicate: true, event: copy(existingSnapshot.data()) };
        }

        const timestamp = clock();
        const event = stripUndefined(
          applyTimestamps(
            {
              id: makeId('webhookEvent'),
              idempotencyKey: input.idempotencyKey,
              provider: input.provider,
              eventType: input.eventType,
              payload: input.payload,
              verification: input.verification,
            },
            timestamp,
          ),
        );
        transaction.set(eventRef, event);
        return { duplicate: false, event: copy(event) };
      });
    },

    async createPublishPlan(input) {
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
      return setRecord('publishPlans', id, plan);
    },

    async getPublishPlan(planId) {
      return getRecord('publishPlans', planId);
    },

    async listPublishPlans(filters = {}) {
      return listRecords('publishPlans', (plan) => {
        if (filters.jobId && plan.jobId !== filters.jobId) return false;
        if (filters.status && plan.status !== filters.status) return false;
        return true;
      });
    },

    async updatePublishPlan(planId, patch) {
      return updateRecord('publishPlans', planId, patch);
    },

    async createPublishAttempt(input) {
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
      return setRecord('publishAttempts', id, attempt);
    },

    async getPublishAttempt(attemptId) {
      return getRecord('publishAttempts', attemptId);
    },

    async updatePublishAttempt(attemptId, patch) {
      return updateRecord('publishAttempts', attemptId, patch);
    },

    async listPublishAttempts(filters = {}) {
      return listRecords('publishAttempts', (attempt) => {
        if (filters.planId && attempt.planId !== filters.planId) return false;
        if (filters.jobId && attempt.jobId !== filters.jobId) return false;
        if (filters.platform && attempt.platform !== filters.platform) return false;
        if (filters.status && attempt.status !== filters.status) return false;
        return true;
      });
    },

    async listSocialAccounts(filters = {}) {
      return listRecords('socialAccounts', (account) => {
        if (filters.platform && account.platform !== filters.platform) return false;
        if (filters.ownerUid && account.ownerUid !== filters.ownerUid) return false;
        return true;
      });
    },

    async getSocialAccount(accountId) {
      return getRecord('socialAccounts', accountId);
    },

    async upsertSocialAccount(input) {
      const timestamp = clock();
      const id = input.id ?? makeId('socialAccount');
      const existing = await getRecord('socialAccounts', id);
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
      return setRecord('socialAccounts', id, account);
    },

    async deleteSocialAccount(accountId) {
      return deleteRecord('socialAccounts', accountId);
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
      return setRecord('oauthStates', id, state);
    },

    async consumeOAuthState(stateId) {
      const state = await getRecord('oauthStates', stateId);
      if (!state) return null;
      await (await collection('oauthStates')).doc(stateId).delete();
      return copy(state);
    },

    async putSecret(input) {
      const timestamp = clock();
      const id = input.id ?? makeId('secret');
      const existing = await getRecord('secrets', id);
      const secret = {
        id,
        provider: input.provider,
        kind: input.kind,
        value: input.value,
        metadata: input.metadata ?? {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await setRecord('secrets', id, secret);
      return {
        id,
        secretRef: `firestore-secret:${id}`,
        provider: secret.provider,
        kind: secret.kind,
        metadata: copy(secret.metadata),
      };
    },

    async getSecret(secretRefOrId) {
      return getRecord('secrets', maybeSecretId(secretRefOrId));
    },

    async createServiceClient(input) {
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
      return setRecord('serviceClients', id, client);
    },

    async listServiceClients(filters = {}) {
      return listRecords('serviceClients', (client) => {
        if (filters.status && client.status !== filters.status) return false;
        return true;
      });
    },

    async getServiceClient(clientId) {
      return getRecord('serviceClients', clientId);
    },

    async findServiceClientByKeyId(keyId) {
      const matches = await listRecords('serviceClients', (candidate) => candidate.keyId === keyId);
      return copy(matches[0]);
    },

    async updateServiceClient(clientId, patch) {
      return updateRecord('serviceClients', clientId, patch);
    },

    async createSmartCollection(input) {
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
      return setRecord('smartCollections', id, smartCollection);
    },

    async listSmartCollections(filters = {}) {
      return listRecords('smartCollections', (smartCollection) => {
        if (filters.status && smartCollection.status !== filters.status) return false;
        if (filters.type && smartCollection.type !== filters.type) return false;
        if (filters.ownerUid && smartCollection.ownerUid !== filters.ownerUid) return false;
        return true;
      });
    },

    async getSmartCollection(collectionId) {
      return getRecord('smartCollections', collectionId);
    },

    async updateSmartCollection(collectionId, patch) {
      return updateRecord('smartCollections', collectionId, patch);
    },

    async deleteSmartCollection(collectionId) {
      return deleteRecord('smartCollections', collectionId);
    },

    async getMarketWatchlist(watchlistId) {
      return getRecord('marketWatchlists', watchlistId);
    },

    async upsertMarketWatchlist(watchlistId, input) {
      const timestamp = clock();
      const existing = await getRecord('marketWatchlists', watchlistId);
      return setRecord('marketWatchlists', watchlistId, {
        ...input,
        id: watchlistId,
        createdAt: existing?.createdAt ?? input.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    },

    async listAppUsers() {
      return listRecords('appUsers');
    },

    async getAppUser(userId) {
      return getRecord('appUsers', userId);
    },

    async findAppUserByEmail(email) {
      const normalizedEmail = String(email ?? '').toLowerCase();
      const matches = await listRecords(
        'appUsers',
        (candidate) => String(candidate.email ?? '').toLowerCase() === normalizedEmail,
      );
      return copy(matches[0]);
    },

    async upsertAppUser(input) {
      const timestamp = clock();
      const id = input.id ?? input.uid ?? makeId('appUser');
      const existing = await getRecord('appUsers', id);
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
      return setRecord('appUsers', id, user);
    },

    async updateAppUser(userId, patch) {
      return updateRecord('appUsers', userId, patch);
    },

    async deleteAppUser(userId) {
      return deleteRecord('appUsers', userId);
    },
  };
}

function compareCreatedAt(left, right) {
  return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
}
