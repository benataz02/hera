import { createAssistantRouter } from "../assistant/router.ts";
import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";
import { configsRouter } from "./routers/configs.ts";
import { extractionRouter } from "./routers/extraction.ts";
import { portalClientsRouter, portalRouter } from "./routers/portal.ts";
import { dashboardRouter } from "./routers/dashboard.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { sessionProcedure, membershipFromHost } from "./base.ts";

export const router = {
  // Who am I on this tenant subdomain? One call answers all three questions the app shell asks:
  // signed in (UNAUTHORIZED), member of this workspace (FORBIDDEN — the membership join IS the
  // check), and with what role. sessionProcedure, not userProcedure: portal (client-role)
  // accounts need this too, and userProcedure fences them out.
  me: sessionProcedure.handler(async ({ context }) => ({
    ...(await membershipFromHost(context.headers, context.user.id)),
    user: context.user,
  })),
  variants: variantsRouter,
  models: modelsRouter,
  configs: configsRouter,
  extraction: extractionRouter,
  portal: portalRouter,
  portalClients: portalClientsRouter,
  dashboard: dashboardRouter,
  entities: entitiesRouter,
  assist: createAssistantRouter(),
};

export type AppRouter = typeof router;
