import { quoteRouter } from "./routers/quote.ts";
import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";

export const router = {
  quote: quoteRouter,
  sync: syncRouter,
  entities: entitiesRouter,
};

export type AppRouter = typeof router;
