import { join } from 'path';
import { existsSync } from 'fs';
import express, { Express, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { apiRateLimit, csrfProtection, errorHandler, securityHeaders } from './middleware';

// Routers
import { snippetRouter } from './routes/snippets';
import { getRawCode } from './controllers/snippets';
import { authRouter } from './routes/auth';
import { taskRouter } from './routes/tasks';
import { adminRouter } from './routes/admin';
import { variableRouter } from './routes/variables';
import { siteRouter } from './routes/sites';
import { runRouter } from './routes/runs';
import { runbookRouter } from './routes/runbooks';
import { agentRouter, deviceRouter } from './routes/devices';
import { scheduleRouter } from './routes/schedules';
import { notificationRouter } from './routes/notifications';
import { alertRouter, policyRouter } from './routes/monitoring';

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
  // Agents send whole inventories (software lists, event logs); give them room
  app.use('/api/agent', express.json({ limit: '4mb', type: 'application/json' }));
  // File uploads to devices travel as base64 in the tool request
  app.use('/api/devices', express.json({ limit: '2mb', type: 'application/json' }));
  app.use(express.json({ limit: '256kb', type: 'application/json' }));
  app.use(cookieParser());
  app.use(csrfProtection);
  clientDirs.forEach(dir => app.use(express.static(dir)));

  // Routes
  app.use('/api', apiRateLimit);
  app.use('/raw', apiRateLimit);
  app.use('/agent', apiRateLimit);
  app.use('/api/auth', authRouter);
  app.use('/api/snippets', snippetRouter);
  app.get('/raw/:rawRef', apiRateLimit, getRawCode);
  app.use('/api/tasks', taskRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/variables', variableRouter);
  app.use('/api/sites', siteRouter);
  app.use('/api/runs', runRouter);
  app.use('/api/runbooks', runbookRouter);
  app.use('/api/devices', deviceRouter);
  app.use('/api/schedules', scheduleRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/alerts', alertRouter);
  app.use('/api/policies', policyRouter);
  app.use('/api/agent', express.urlencoded({ extended: false, limit: '256kb' }), agentRouter);
  // Agent install scripts and the agents themselves
  app.use(
    '/agent',
    express.static(join(__dirname, '../agent'), {
      setHeaders: res => res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    })
  );

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
