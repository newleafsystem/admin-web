import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`NewLeaf API listening on http://localhost:${config.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down API server.`);
  server.close((error) => {
    if (error) {
      console.error('Error while shutting down API server', error);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
