import { useNavigate, useSearch } from "@tanstack/react-router";

// The open ObjectPage section lives in `?section=` so a shared link, a refresh or the back button
// lands on the same tab. Two halves: `sectionSearch` on the route, `useSectionParam` in the page.

export const sectionSearch = (s: Record<string, unknown>): { section?: string } => ({
  section: typeof s.section === "string" ? s.section : undefined,
});

export function useSectionParam() {
  const navigate = useNavigate();
  const { section } = useSearch({ strict: false }) as { section?: string };
  // replace: clicking through tabs must not stack history entries you then have to back out of.
  const setSection = (id: string) => {
    if (id === section) return;
    void navigate({ to: ".", search: (prev) => ({ ...prev, section: id }), replace: true });
  };
  return [section, setSection] as const;
}
