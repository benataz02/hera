import { createFileRoute } from "@tanstack/react-router";
import { PortalRequestPage } from "../../../components/portal/PortalRequestPage.tsx";

export const Route = createFileRoute("/_authed/portal/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <PortalRequestPage key={id} id={id} />;
}
