import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityObjectPage } from "../../../../components/b1/EntityObjectPage.tsx";

const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

export const Route = createFileRoute("/_authed/portal/docs/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_ENTITIES.has(params.entity)) throw redirect({ to: "/portal" });
  },
  component: () => {
    const { entity, key } = Route.useParams();
    return <EntityObjectPage entity={entity} entityKey={key} scope="portal" />;
  },
});
