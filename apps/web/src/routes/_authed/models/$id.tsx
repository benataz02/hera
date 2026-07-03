import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/configurator/ModelBuilderPage.tsx";

export const Route = createFileRoute("/_authed/models/$id")({ component: Builder });

function Builder() {
  const { id } = Route.useParams();
  return <ModelBuilderPage key={id} id={id} />;
}
