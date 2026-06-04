import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import swaggerUi from 'swagger-ui-express';
import { Express, Request, Response, NextFunction } from 'express';

function loadOpenApiSpec(): Record<string, unknown> {
  const specPath = path.join(process.cwd(), 'openapi.yaml');
  const raw = fs.readFileSync(specPath, 'utf8');
  return yaml.parse(raw) as Record<string, unknown>;
}

const swaggerUiOptions: swaggerUi.SwaggerUiOptions = {
  customSiteTitle: 'LBC Rider API Docs',
  customCss: `
    .swagger-ui .auth-wrapper { justify-content: flex-end; }
    .swagger-ui .btn.authorize {
      border-color: #49cc90;
      color: #49cc90;
      font-weight: bold;
    }
    .swagger-ui .btn.authorize svg { fill: #49cc90; }
  `,
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
    filter: true,
    tryItOutEnabled: true,
  },
};

export function setupSwagger(app: Express): void {
  app.use(
    '/api/docs',
    swaggerUi.serve,
    (_req: Request, res: Response, next: NextFunction) => {
      const swaggerDocument = loadOpenApiSpec();
      swaggerUi.setup(swaggerDocument, swaggerUiOptions)(_req, res, next);
    }
  );
}
