import { quoteRouter } from "./routers/quote.ts";
import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { configRouter } from "./routers/config.ts";

export const router = {
  quote: quoteRouter,
  sync: syncRouter,
  entities: entitiesRouter,
  config: configRouter,
};

export type AppRouter = typeof router;
