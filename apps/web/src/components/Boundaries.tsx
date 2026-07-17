import { useNavigate, type ErrorComponentProps, type NotFoundRouteProps } from "@tanstack/react-router";
import { Button, IllustratedMessage } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/ErrorScreen.js";
import "@ui5/webcomponents-fiori/dist/illustrations/PageNotFound.js";
import "@ui5/webcomponents-fiori/dist/illustrations/tnt/CodePlaceholder.js";

// Router-wide boundaries, wired as createRouter defaults in main.tsx. Any route can still
// override with its own errorComponent/notFoundComponent.

// `reset()` is router.invalidate() under the hood — it re-runs the loader, so retry is real.
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <IllustratedMessage
      name="ErrorScreen"
      design="Scene"
      titleText="Something went wrong"
      // ponytail: raw message. Map to friendlier copy per oRPC error code once we have codes users care about.
      subtitleText={error.message}
    >
      <Button design="Emphasized" onClick={() => reset()}>Try again</Button>
      <Button onClick={() => window.location.reload()}>Reload page</Button>
    </IllustratedMessage>
  );
}

// Renders for an unmatched URL and for `throw notFound()` from a loader.
export function RouteNotFound(_props: NotFoundRouteProps) {
  const navigate = useNavigate();
  return (
    <IllustratedMessage name="PageNotFound" design="Scene" titleText="This page doesn't exist"
      subtitleText="The link may be out of date, or the item was deleted.">
      <Button design="Emphasized" onClick={() => navigate({ to: "/" })}>Go to home</Button>
    </IllustratedMessage>
  );
}

// Placeholder for routes that are routed but not built. Use as a route `component`.
export function ToBeDone({ what = "This feature" }: { what?: string }) {
  return (
    <IllustratedMessage name="TntCodePlaceholder" design="Scene" titleText={`${what} isn't built yet`}
      subtitleText="It's on the roadmap. Nothing you do here will break anything." />
  );
}
