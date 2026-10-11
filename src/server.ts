import { assertSecretKeyConfigured } from './utils/secretBox';
import dotenv from 'dotenv';
import { Logger, githubSyncTick, monitoringTick, onSchedulerTick, runAutomaticBackup, startScheduler } from './utils';
import { connectDB } from './db';
import { associateModels } from './db/associateModels';
import { createApp } from './app';

// Env config
dotenv.config();

const logger = new Logger('server');
const PORT = process.env.PORT || 5000;
const app = createApp();

(async () => {
  assertSecretKeyConfigured();
  await connectDB();
  await associateModels();
  onSchedulerTick(async now => {
    await runAutomaticBackup(now);
  });
  onSchedulerTick(monitoringTick);
  onSchedulerTick(githubSyncTick);
  startScheduler();

  app.listen(PORT, () => {
    logger.log(
      `Server is working on port ${PORT} in ${process.env.NODE_ENV} mode`
    );
  });
})();
