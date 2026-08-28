import { createFileRoute } from "@tanstack/react-router";
import { EntityCatalogPage } from "../../../components/b1/EntityCatalogPage.tsx";

export const Route = createFileRoute("/_authed/b1/")({ component: EntityCatalogPage });
