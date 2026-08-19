import { createFileRoute } from "@tanstack/react-router";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";
import { sectionSearch } from "../../../sectionParam.ts";

export const Route = createFileRoute("/_authed/configs/$id")({
  validateSearch: sectionSearch,
  component: Process,
});

function Process() {
  const { id } = Route.useParams();
  return <ConfigProcessPage key={id} id={id} />;
}
