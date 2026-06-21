import { createRootRoute, Outlet } from "@tanstack/react-router";

// Bare shell so auth screens (login/signup/onboarding) can render full-bleed.
// ponytail: app chrome + the auth gate live on the home route; promote to a `_authed`
//           pathless layout when a second authenticated route appears.
export const Route = createRootRoute({ component: () => <Outlet /> });
