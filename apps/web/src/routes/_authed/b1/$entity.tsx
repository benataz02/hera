import { createFileRoute } from "@tanstack/react-router";
import { EntityListPage } from "../../../components/b1/EntityListPage.tsx";

export const Route = createFileRoute("/_authed/b1/$entity")({
  component: () => <EntityListPage entity={Route.useParams().entity} />,
});
