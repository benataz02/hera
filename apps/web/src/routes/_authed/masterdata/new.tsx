import { createFileRoute } from "@tanstack/react-router";
import { MasterdataEditor } from "../../../components/masterdata/MasterdataEditor.tsx";

export const Route = createFileRoute("/_authed/masterdata/new")({ component: () => <MasterdataEditor /> });
