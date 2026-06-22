import { createFileRoute } from "@tanstack/react-router";
import { EntityListPage } from "../../../components/EntityListPage.tsx";

export const Route = createFileRoute("/_authed/_entities/$entity")({ component: Page });

function Page() {
  const { entity } = Route.useParams();
  return <EntityListPage entity={entity} />;
}
