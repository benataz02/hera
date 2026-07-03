import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";

export const router = {
  sync: syncRouter,
  entities: entitiesRouter,
  variants: variantsRouter,
  models: modelsRouter,
};

export type AppRouter = typeof router;
