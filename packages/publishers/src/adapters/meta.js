import { createPlaceholderPublisher } from "../placeholder-publisher.js";
import { PLATFORMS } from "../platforms.js";

export const metaTodos = Object.freeze([
  "Refresh OAuth tokens from the connected account secret reference.",
  "Keep publishing behind feature flags until Meta permissions and app review are cleared.",
  "Verify the Instagram account is professional and linked to a Facebook Page.",
  "Implement create-container then publish-container flow for Reels/feed publishing.",
  "Persist container IDs, publish IDs, public URLs, and request/response snapshots."
]);

export const metaPublisher = createPlaceholderPublisher({
  platform: PLATFORMS.META,
  displayName: "Instagram / Facebook",
  todos: metaTodos
});
