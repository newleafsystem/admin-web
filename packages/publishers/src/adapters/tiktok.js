import { createPlaceholderPublisher } from "../placeholder-publisher.js";
import { PLATFORMS } from "../platforms.js";

export const tiktokTodos = Object.freeze([
  "Refresh OAuth tokens from the connected account secret reference.",
  "Implement TikTok Content Posting API direct-post or inbox flow based on approval.",
  "Handle audit restrictions that may limit unaudited clients to private or inbox flows.",
  "Represent inbox/manual-completion state in publish attempt status.",
  "Persist upload IDs, publish IDs, public URLs, and request/response snapshots."
]);

export const tiktokPublisher = createPlaceholderPublisher({
  platform: PLATFORMS.TIKTOK,
  displayName: "TikTok",
  todos: tiktokTodos
});
