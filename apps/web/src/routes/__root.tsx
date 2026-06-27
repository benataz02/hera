import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

// Bare shell so auth screens (login/signup/onboarding) can render full-bleed.
// ponytail: app chrome + the auth gate live on the home route; promote to a `_authed`
//           pathless layout when a second authenticated route appears.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />
});
