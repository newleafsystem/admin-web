export {
  VideoAssemblerError,
  assembleVideo,
  createConcatFile,
  getOrderedSegments,
  loadManifest,
  normalizeClip,
  stitchClips,
  validateManifest,
  validateSegments
} from "./videoAssembler.js";

export {
  VideoTimelineError,
  calculateDuration,
  exportFinalVideo,
  loadTimeline,
  normalizeSourceVideo,
  renderAudioTrack,
  renderAvatarOverlay,
  renderCallouts,
  renderTimeline,
  renderVideoTrack,
  renderZoomEffects,
  validateTimeline
} from "./videoTimelineRenderer.js";

export { downloadSegment } from "./downloadSegment.js";

export {
  createSegmentStatusService,
  getPendingRequiredSegments,
  isProjectReadyToStitch,
  SegmentStatusService,
  updateSegmentCompletion
} from "./segmentStatusService.js";
