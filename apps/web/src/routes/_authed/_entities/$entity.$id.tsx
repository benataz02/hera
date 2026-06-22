import { createFileRoute } from "@tanstack/react-router";
import { EntityObjectPage } from "../../../components/EntityObjectPage.tsx";

export const Route = createFileRoute("/_authed/_entities/$entity/$id")({ component: Page });

function Page() {
  const { entity, id } = Route.useParams();
  return <EntityObjectPage entity={entity} recordKey={id} />;
}
