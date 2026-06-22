import { createFileRoute } from "@tanstack/react-router";
import { EntityObjectPage } from "../../../components/EntityObjectPage.tsx";

// Trailing `_` on `$entity_` un-nests this from the list route ($entity.tsx), which has no
// <Outlet/>. So the object page renders full-page in _authed's Outlet. Path stays /$entity/$id.
export const Route = createFileRoute("/_authed/_entities/$entity_/$id")({ component: Page });

function Page() {
  const { entity, id } = Route.useParams();
  return <EntityObjectPage entity={entity} recordKey={id} />;
}
