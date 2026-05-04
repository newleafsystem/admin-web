import { createPlaceholderPublisher } from "../placeholder-publisher.js";
import { PLATFORMS } from "../platforms.js";

export const xTwitterTodos = Object.freeze([
  "Refresh OAuth tokens from the connected account secret reference.",
  "Implement X media upload initialize, append chunks, finalize, and status polling.",
  "Persist media_id and processing state before creating the final post.",
  "Create the final post only after media processing is complete.",
  "Resume retries from persisted upload state to avoid duplicate posts."
]);

export const xTwitterPublisher = createPlaceholderPublisher({
  platform: PLATFORMS.X,
  displayName: "X / Twitter",
  todos: xTwitterTodos
});
