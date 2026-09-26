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
import { taskRouter } from './routes/tasks';
import { adminRouter } from './routes/admin';
import { associateModels } from './db/associateModels';

// Env config
dotenv.config();

const app = express();
const logger = new Logger('server');
const PORT = process.env.PORT || 5000;
const publicDir = join(__dirname, '../public');
const clientBuildDir = join(__dirname, '../client/build');

const resolveClientDir = (): string | null => {
  if (existsSync(join(publicDir, 'index.html'))) {
    return publicDir;
  }

  if (existsSync(join(clientBuildDir, 'index.html'))) {
    return clientBuildDir;
  }

  return null;
};

// App config
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '256kb', type: 'application/json' }));
// Express 5 leaves req.body undefined when no body parser ran; keep the
// Express 4 behaviour of an empty object so handlers can read fields safely.
app.use((req, _res, next) => {
  if (req.body === undefined) {
    req.body = {};
  }
  next();
});
app.use(cookieParser());
app.use(express.static(publicDir));
app.use(express.static(clientBuildDir));

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

(async () => {
  await connectDB();
  await associateModels();

  app.listen(PORT, () => {
    logger.log(
      `Server is working on port ${PORT} in ${process.env.NODE_ENV} mode`
    );
  });
})();
