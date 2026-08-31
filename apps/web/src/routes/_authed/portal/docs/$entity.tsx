import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityListPage } from "../../../../components/b1/EntityListPage.tsx";

// The four document sets a portal client may browse. The server fences this independently
// (portal.docs's PORTAL_ENTITIES); this guard only keeps a typo out of the URL bar.
const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

export const Route = createFileRoute("/_authed/portal/docs/$entity")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_ENTITIES.has(params.entity)) throw redirect({ to: "/portal" });
  },
  component: () => <EntityListPage entity={Route.useParams().entity} scope="portal" />,
});
