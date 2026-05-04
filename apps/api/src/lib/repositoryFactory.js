import { config } from '../config.js';
import { getFirestore } from './firebaseAdmin.js';
import { createFirestoreRepository } from './firestoreRepository.js';
import { createLocalStore } from './localStore.js';
import { createInMemoryRepository } from './repository.js';

export function createRepository(options = {}) {
  const provider = options.provider ?? config.repository.provider;

  if (provider === 'firestore') {
    return createFirestoreRepository({
      getFirestore,
      collectionPrefix: config.repository.firestoreCollectionPrefix,
    });
  }

  return createInMemoryRepository({
    localStorePromise: createLocalStore(),
  });
}
