import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";
import { configsRouter } from "./routers/configs.ts";
import { extractionRouter } from "./routers/extraction.ts";
import { portalClientsRouter, portalRouter } from "./routers/portal.ts";

export const router = {
  sync: syncRouter,
  entities: entitiesRouter,
  variants: variantsRouter,
  models: modelsRouter,
  configs: configsRouter,
  extraction: extractionRouter,
  portal: portalRouter,
  portalClients: portalClientsRouter,
};

export type AppRouter = typeof router;
