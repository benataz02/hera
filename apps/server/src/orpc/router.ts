import { quoteRouter } from "./routers/quote.ts";
import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { modelsRouter } from "./routers/models.ts";
import { tablesRouter } from "./routers/tables.ts";
import { configureRouter } from "./routers/configure.ts";

export const router = {
  quote: quoteRouter,
  sync: syncRouter,
  entities: entitiesRouter,
  models: modelsRouter,
  tables: tablesRouter,
  configure: configureRouter,
};

export type AppRouter = typeof router;
