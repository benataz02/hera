import { createFileRoute } from "@tanstack/react-router";
import { ConfigsPage } from "../../../components/configurator/ConfigsPage.tsx";

export const Route = createFileRoute("/_authed/configs/")({ component: ConfigsPage });
