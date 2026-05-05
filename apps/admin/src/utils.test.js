import assert from 'node:assert/strict';
import { isArchivedContentQueueJob, isArchivedPublishPlan } from './utils.js';

assert.equal(
  isArchivedContentQueueJob({
    id: 'external_youtube_abc123',
    type: 'external_video',
    sourceType: 'external_youtube',
    status: 'published',
  }),
  true,
);

assert.equal(
  isArchivedPublishPlan({
    id: 'external_youtube_plan_abc123',
    status: 'published',
    metadata: {
      externalSource: 'youtube_channel_import',
    },
    attempts: [
      {
        id: 'external_youtube_attempt_abc123',
        status: 'published',
        metadata: {
          externalSource: 'youtube_channel_import',
        },
      },
    ],
  }),
  true,
);

assert.equal(
  isArchivedPublishPlan({
    id: 'publishPlan_active',
    status: 'publishing',
    attempts: [
      {
        id: 'publishAttempt_active',
        status: 'uploading',
      },
    ],
  }),
  false,
);

console.log('Admin utility tests passed.');
