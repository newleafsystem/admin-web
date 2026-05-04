export const navItems = [
  "Dashboard",
  "Create Content",
  "Content Queue",
  "Review",
  "Video Studio",
  "Published Videos",
  "Accounts",
  "Vendors",
  "Audit"
];

export const routeByView = Object.freeze({
  Dashboard: "/",
  "Create Content": "/create",
  "Content Queue": "/content-queue",
  Review: "/review",
  "Video Studio": "/video-studio",
  "Published Videos": "/published-videos",
  Accounts: "/accounts",
  Vendors: "/vendors",
  Audit: "/audit"
});

export const viewByRoute = new Map(
  [
    ...Object.entries(routeByView).map(([view, route]) => [route, view]),
    ["/video-status", "Content Queue"],
    ["/publishing", "Content Queue"]
  ]
);

export const statusText = {
  draft: "Draft",
  source_ingested: "Source ingested",
  content_extracted: "Content extracted",
  review_required: "Review required",
  video_requested: "Video requested",
  video_ready: "Video ready",
  partial_failed: "Partial failed",
  script_ready: "Script ready",
  approved: "Approved",
  publishing: "Publishing",
  published: "Published",
  delete_requested: "Deleting",
  deleted: "Deleted",
  connected: "Connected",
  configured: "Configured",
  attention: "Attention",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  oauth_pending: "OAuth pending",
  healthy: "Healthy",
  ready: "Ready",
  not_requested: "Not requested",
  queued: "Queued",
  uploading: "Uploading",
  processing: "Processing",
  blocked: "Blocked",
  private: "Private",
  public: "Public",
  unlisted: "Unlisted",
  unknown: "Unknown",
  failed: "Failed"
};

export const socialPlatforms = [
  {
    id: "youtube",
    label: "YouTube",
    provider: "Google",
    scopes: ["youtube.upload", "youtube.readonly", "youtube.force-ssl"],
    defaultAccountName: "NewLeaf YouTube Channel",
    publisherEnabled: true
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    provider: "LinkedIn",
    scopes: ["openid", "profile", "email", "w_member_social", "r_organization_social"],
    defaultAccountName: "NewLeaf LinkedIn Page",
    publisherEnabled: true
  },
  {
    id: "x",
    label: "X",
    provider: "X",
    scopes: ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"],
    defaultAccountName: "@newleafsystem",
    publisherEnabled: true
  },
  {
    id: "instagram",
    label: "Instagram",
    provider: "Meta",
    scopes: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish"],
    defaultAccountName: "NewLeaf Instagram",
    publisherEnabled: true
  },
  {
    id: "facebook",
    label: "Facebook",
    provider: "Meta",
    scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    defaultAccountName: "NewLeaf Facebook Page",
    publisherEnabled: true
  },
  {
    id: "tiktok",
    label: "TikTok",
    provider: "TikTok",
    scopes: ["video.upload"],
    defaultAccountName: "NewLeaf TikTok",
    publisherEnabled: false
  }
];

export const intakeModes = [
  {
    id: "video_upload",
    label: "Upload video",
    sourceType: "video_upload",
    reviewStatus: "review_required"
  },
  {
    id: "youtube_embed",
    label: "YouTube embed",
    sourceType: "youtube_embed",
    reviewStatus: "review_required"
  },
  {
    id: "text_to_heygen",
    label: "Text to HeyGen",
    sourceType: "text_to_heygen",
    reviewStatus: "script_ready"
  },
  {
    id: "segmented_video",
    label: "Segmented / hybrid",
    sourceType: "text_to_heygen",
    reviewStatus: "script_ready"
  }
];

export const REVIEWABLE_STATUSES = new Set(["review_required", "video_ready"]);

export const initialContentDraft = {
  mode: "video_upload",
  title: "",
  youtubeUrl: "",
  prompt: "",
  targetDurationSec: 180,
  thumbnailLabel: "Auto placeholder thumbnail",
  videoFile: null,
  segments: [
    {
      sequence: 10,
      segmentKey: "intro",
      title: "Intro",
      prompt: "",
      clipFile: null
    },
    {
      sequence: 20,
      segmentKey: "main",
      title: "Main Story",
      prompt: "",
      clipFile: null
    },
    {
      sequence: 30,
      segmentKey: "outro",
      title: "Outro",
      prompt: "",
      clipFile: null
    }
  ],
  isSubmitting: false,
  error: null,
  message: null
};

export const initialPublishDraft = {
  jobId: "",
  title: "",
  description: "",
  hashtagsText: "",
  youtubeTagsText: "",
  scheduledAt: "",
  platforms: ["youtube"],
  isGeneratingYoutubeTags: false,
  isSubmitting: false,
  error: null
};
