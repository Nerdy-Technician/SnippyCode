import { join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { Logger } from './utils';
import { connectDB } from './db';
import { errorHandler, securityHeaders } from './middleware';

// Routers
import { snippetRouter } from './routes/snippets';
import { getRawCode } from './controllers/snippets';
import { authRouter } from './routes/auth';
import { githubRouter } from './routes/github';
import { taskRouter } from './routes/tasks';
import { adminRouter } from './routes/admin';
import { associateModels } from './db/associateModels';

// Env config
dotenv.config();

const app = express();
const logger = new Logger('server');
const PORT = process.env.PORT || 5000;
const clientIndexPath = join(__dirname, '../public/index.html');

// App config
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '256kb', type: 'application/json' }));
app.use(cookieParser());
app.use(express.static(join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRouter);
app.use('/api/snippets', snippetRouter);
app.get('/raw/:rawRef', getRawCode);
app.use('/api/github', githubRouter);
app.use('/api/tasks', taskRouter);
app.use('/api/admin', adminRouter);

// Serve client code
app.get(/^\/(?!api)/, (req: Request, res: Response) => {
  if (existsSync(clientIndexPath)) {
    res.sendFile(clientIndexPath);
    return;
  }

  res.status(404).json({
    error: 'Client build not found. Use the React dev server in development.'
  });
});

// Error handler
app.use(errorHandler);

(async () => {
  await connectDB();
  await associateModels();

  app.listen(PORT, () => {
    logger.log(
      `Server is working on port ${PORT} in ${process.env.NODE_ENV} mode`
    );
  });
})();
