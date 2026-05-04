import { createPlaceholderPublisher } from "../placeholder-publisher.js";
import { PLATFORMS } from "../platforms.js";

export const youtubeTodos = Object.freeze([
  "Refresh OAuth tokens from the connected account secret reference.",
  "Verify the youtube.upload OAuth scope before upload.",
  "Implement YouTube Data API videos.insert with resumable upload.",
  "Map title, description, tags, privacy, publish time, and synthetic media declaration.",
  "Account for unaudited API projects that may force private visibility.",
  "Persist YouTube video ID, processing state, watch URL, and request/response snapshots."
]);

export const youtubePublisher = createPlaceholderPublisher({
  platform: PLATFORMS.YOUTUBE,
  displayName: "YouTube",
  todos: youtubeTodos
});
