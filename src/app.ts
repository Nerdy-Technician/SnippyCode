import { join } from 'path';
import { existsSync } from 'fs';
import express, { Express, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, securityHeaders } from './middleware';

// Routers
import { snippetRouter } from './routes/snippets';
import { getRawCode } from './controllers/snippets';
import { authRouter } from './routes/auth';
import { taskRouter } from './routes/tasks';
import { adminRouter } from './routes/admin';

export interface AppOptions {
  /** Directories that may contain the built client (index.html + assets). */
  clientDirs?: string[];
}

const defaultClientDirs = [
  join(__dirname, '../public'),
  join(__dirname, '../client/build')
];

/**
 * Builds the Express app without connecting to the database or listening,
 * so tests can mount it on an ephemeral port.
 */
export const createApp = (options: AppOptions = {}): Express => {
  const app = express();
  const clientDirs = options.clientDirs || defaultClientDirs;

  const resolveClientDir = (): string | null =>
    clientDirs.find(dir => existsSync(join(dir, 'index.html'))) || null;

  // App config
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb', type: 'application/json' }));
  app.use(cookieParser());
  clientDirs.forEach(dir => app.use(express.static(dir)));

  // Routes
  app.use('/api/auth', authRouter);
  app.use('/api/snippets', snippetRouter);
  app.get('/raw/:rawRef', getRawCode);
  app.use('/api/tasks', taskRouter);
  app.use('/api/admin', adminRouter);

  // Serve client code
  app.get(/^\/(?!api)/, (req: Request, res: Response) => {
    const clientDir = resolveClientDir();

    if (clientDir) {
      res.sendFile(join(clientDir, 'index.html'));
      return;
    }

    res.status(404).json({
      error: 'Client build not found. Run npm run build, or use the React dev server in development.'
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
};
