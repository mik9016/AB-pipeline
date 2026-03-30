import { setupSentry } from './sentry.js';
import { config } from './config.js';
import { logger } from './logger.js';

await setupSentry();

const { default: app } = await import('./app.js');

app
  .listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        ollamaModel: config.ollamaModel,
        queueConcurrency: config.queueConcurrency,
      },
      'Document processor server started',
    );
  })
  .on('error', (err) => {
    logger.fatal(err, 'Failed to bind port');
    process.exit(1);
  });
