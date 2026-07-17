import "@ui5/webcomponents-react/dist/Assets.js";
import "@ui5/webcomponents-icons/dist/AllIcons.js"; // registers the SAP-icons-v5 glyph loader (horizon); Assets.js only loads icon i18n. ponytail: AllIcons pulls the whole set — switch to per-icon imports if bundle size bites
import { ThemeProvider } from "@ui5/webcomponents-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { authClient } from "./auth-client.ts";
import { routeTree } from "./routeTree.gen.ts";
import { RouteError, RouteNotFound } from "./components/Boundaries.tsx";

const queryClient = new QueryClient();
queryClient.setQueryDefaults(["session"], {
  queryFn: async () => (await authClient.getSession()).data ?? null,
  staleTime: 1000 * 60 * 5, // 5 minutes
});

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  // Router-wide floor; a route can still set its own errorComponent/notFoundComponent.
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
