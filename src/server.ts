import dotenv from 'dotenv';
import { Logger } from './utils';
import { connectDB } from './db';
import { associateModels } from './db/associateModels';
import { createApp } from './app';

// Env config
dotenv.config();

const logger = new Logger('server');
const PORT = process.env.PORT || 5000;
const app = createApp();

(async () => {
  await connectDB();
  await associateModels();

  app.listen(PORT, () => {
    logger.log(
      `Server is working on port ${PORT} in ${process.env.NODE_ENV} mode`
    );
  });
})();
