import { createFileRoute } from "@tanstack/react-router";
import { EntityObjectPage } from "../../../components/b1/EntityObjectPage.tsx";

export const Route = createFileRoute("/_authed/b1/$entity_/$key")({
  component: () => {
    const { entity, key } = Route.useParams();
    return <EntityObjectPage entity={entity} entityKey={key} />;
  },
});
