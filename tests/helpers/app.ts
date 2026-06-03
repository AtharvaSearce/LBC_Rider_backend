import express, { Express, Router, RequestHandler } from 'express';

export interface BuildAppOptions {
  mountPath: string;
  router: Router;
  preMiddleware?: RequestHandler[];
}

export function buildApp(options: BuildAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (options.preMiddleware) {
    for (const mw of options.preMiddleware) {
      app.use(mw);
    }
  }

  app.use(options.mountPath, options.router);
  return app;
}
