import { createPlaceholderPublisher } from "../placeholder-publisher.js";
import { PLATFORMS } from "../platforms.js";

export const linkedinTodos = Object.freeze([
  "Refresh OAuth tokens from the connected account secret reference.",
  "Support person-owned and organization-owned video publishing.",
  "Implement initialize upload, part upload, finalize upload, and share creation.",
  "Preserve upload ETags for finalize.",
  "Persist video URN, share URN, public URL, and request/response snapshots."
]);

export const linkedinPublisher = createPlaceholderPublisher({
  platform: PLATFORMS.LINKEDIN,
  displayName: "LinkedIn",
  todos: linkedinTodos
});
