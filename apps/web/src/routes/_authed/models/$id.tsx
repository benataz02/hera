import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/configurator/ModelBuilderPage.tsx";
import { sectionSearch } from "../../../sectionParam.ts";

export const Route = createFileRoute("/_authed/models/$id")({
  validateSearch: sectionSearch,
  component: Builder,
});

function Builder() {
  const { id } = Route.useParams();
  return <ModelBuilderPage key={id} id={id} />;
}
