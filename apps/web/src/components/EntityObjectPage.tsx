import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BusyIndicator,
  Button,
  MessageStrip,
  ObjectPage,
  ObjectPageHeader,
  ObjectPageTitle,
  ObjectStatus,
  Text,
  Title,
  Toolbar,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import { client, orpc } from "../orpc.ts";
import {
  applySectionPicker,
  availableObjectSections,
  buildWriteData,
  cloneForEdit,
  mergeFetchedIntoDraft,
  missingRequiredFields,
  newEditCommandId,
  resolveEntityCapabilities,
  shouldAbortWriteOnNavigateAway,
  shouldClearDraftOnCancel,
  shouldDisableCancel,
  shouldDisableSave,
  shouldMintNewCommandIdAfterFailed,
  titleForRecord,
  visibleHeaderFields,
  waitWriteDoneVisible,
  writeStatusMessage,
  type WriteUiStatus,
} from "../objectSpec.ts";
import { useSectionParam } from "../sectionParam.ts";
import { useObjectVariants } from "../variants.ts";
import { EntityObjectFacets, renderObjectSections } from "./EntityObjectEditor.tsx";
import { FieldPicker } from "./FieldPicker.tsx";
import { ObjectVariantPopover } from "./ObjectVariantPopover.tsx";

// Reserved picker target for "which sections show at all". B1 collection names never start with "_".
const SECTIONS_PICKER = "__sections";

// Standalone ObjectPage shell: query/refetch, title/header/footer, draft, durable update writes.
// EntityObjectEditor owns forms/tables; create stays for controlled callers only.
export function EntityObjectPage({ entity, recordKey }: { entity: string; recordKey: string }) {
  const qc = useQueryClient();
  const [section, setSection] = useSectionParam();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schemaHint = (enabled.data ?? []).find((e) => e.name === entity);
  const ov = useObjectVariants(entity, recordKey);
  const [pickerTarget, setPickerTarget] = useState<"header" | string | null>(null);

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [writeStatus, setWriteStatus] = useState<WriteUiStatus>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [enqueued, setEnqueued] = useState(false);
  const watchAbortRef = useRef<AbortController | null>(null);
  const enqueuedRef = useRef(false);
  enqueuedRef.current = enqueued;

  const object = useQuery({
    ...orpc.entities.get.queryOptions({
      // Dummy uuid keeps the options typed when no variant yet; query stays disabled.
      input: {
        entity,
        key: recordKey,
        variantId: ov.selectedId ?? "00000000-0000-4000-8000-000000000000",
      },
    }),
    enabled: !!ov.selectedId && ov.ready,
  });

  const definition = ov.definition;
  const record = object.data?.record;
  const schema = object.data?.schema;
  const profile = object.data?.profile ?? null;

  const working = draft ?? record ?? null;
  const capabilities = useMemo(
    () => resolveEntityCapabilities(profile, working ?? {}),
    [profile, working],
  );
  const editing = draft != null;
  const saveDisabled = shouldDisableSave(writeStatus);
  const cancelDisabled = shouldDisableCancel(enqueued, writeStatus);
  const statusStrip = writeStatusMessage(writeStatus, writeError);

  // Variant change while editing: merge newly fetched fields without clobbering dirty/present paths.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirtyPaths);
  dirtyRef.current = dirtyPaths;
  const prevRecordRef = useRef(record);
  useEffect(() => {
    const prev = prevRecordRef.current;
    prevRecordRef.current = record;
    const live = draftRef.current;
    if (!live || !record || !prev || prev === record) return;
    setDraft(mergeFetchedIntoDraft(live, record, dirtyRef.current));
  }, [record]);

  // Abort watch subscription on unmount only — never cancel the durable command.
  useEffect(() => {
    return () => {
      void shouldAbortWriteOnNavigateAway();
      watchAbortRef.current?.abort();
      watchAbortRef.current = null;
    };
  }, []);

  const headerFields = useMemo(
    () => (schema ? visibleHeaderFields(schema, definition) : []),
    [schema, definition],
  );

  const pickerFields = useMemo(() => {
    if (pickerTarget === "header") return definition.header;
    if (pickerTarget === SECTIONS_PICKER) {
      return definition.sections.map((s) => ({ name: s.id, visible: s.visible }));
    }
    return definition.sections.find((s) => s.id === pickerTarget)?.fields ?? [];
  }, [pickerTarget, definition]);

  const pickerAvailable = useMemo(() => {
    if (!schema) return [];
    if (pickerTarget === SECTIONS_PICKER) return availableObjectSections(schema);
    if (pickerTarget === "header" || pickerTarget === "general") {
      return schema.properties.map((p) => ({ name: p.name, label: p.name }));
    }
    const col = schema.collections.find((c) => c.name === pickerTarget);
    return (col?.properties ?? []).map((p) => ({ name: p.name, label: p.name }));
  }, [pickerTarget, schema]);

  const beginEdit = () => {
    if (!record || !capabilities.canEdit) return;
    setDraft(cloneForEdit(record));
    setDirtyPaths(new Set());
    setSaveErrors([]);
    setCommandId(newEditCommandId());
    setWriteStatus(null);
    setWriteError(null);
    setEnqueued(false);
  };

  const cancelEdit = () => {
    if (!shouldClearDraftOnCancel(enqueuedRef.current)) return;
    watchAbortRef.current?.abort();
    watchAbortRef.current = null;
    setDraft(null);
    setDirtyPaths(new Set());
    setSaveErrors([]);
    setCommandId(null);
    setWriteStatus(null);
    setWriteError(null);
    setEnqueued(false);
  };

  const saveEdit = async () => {
    if (!draft || !commandId || saveDisabled) return;
    const missing = missingRequiredFields(profile, draft);
    if (missing.length) {
      setSaveErrors(missing);
      return;
    }
    setSaveErrors([]);
    setWriteError(null);

    // Optimistic lock before the write RPC so Cancel cannot clear mid-flight.
    enqueuedRef.current = true;
    setEnqueued(true);
    setWriteStatus("submitting");

    watchAbortRef.current?.abort();
    const ac = new AbortController();
    watchAbortRef.current = ac;

    try {
      const collNames = [
        ...Object.keys(profile?.collections ?? {}),
        ...(schema?.collections ?? []).map((c) => c.name),
      ];
      const { requestId } = await client.entities.write({
        operation: "update",
        entity,
        key: recordKey,
        data: buildWriteData(draft, dirtyPaths, collNames),
        commandId,
      });
      setWriteStatus("pending");

      const iter = await client.entities.watchWrite({ requestId }, { signal: ac.signal });
      for await (const state of iter) {
        if (ac.signal.aborted) return;
        setWriteStatus(state.status);
        if (state.error) setWriteError(state.error);

        if (state.status === "failed") {
          // Terminal failed request: keep draft, mint a fresh commandId for Save retry.
          if (shouldMintNewCommandIdAfterFailed(state.status)) {
            setCommandId(newEditCommandId());
          }
          setEnqueued(false);
          return;
        }
        if (state.status === "done") {
          // Paint Positive “Saved” while still in edit, then exit + refetch.
          await waitWriteDoneVisible();
          if (ac.signal.aborted) return;
          if (ov.selectedId) {
            await qc.invalidateQueries({
              queryKey: orpc.entities.get.queryOptions({
                input: { entity, key: recordKey, variantId: ov.selectedId },
              }).queryKey,
            });
          }
          setDraft(null);
          setDirtyPaths(new Set());
          setCommandId(null);
          setWriteStatus(null);
          setWriteError(null);
          setEnqueued(false);
          return;
        }
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setWriteStatus("failed");
      setWriteError(err instanceof Error ? err.message : String(err));
      // Write may not have enqueued; mint anyway so a later Save cannot hit a
      // terminal failed agent_request if the server did accept the commandId.
      setCommandId(newEditCommandId());
      setEnqueued(false);
    }
  };

  if (enabled.isPending || ov.isLoading || !ov.ready || (ov.selectedId && object.isPending)) {
    return <BusyIndicator active style={{ margin: "2rem" }} />;
  }
  if (!schemaHint) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
        Entity “{entity}” is not enabled.
      </MessageStrip>
    );
  }
  if (schemaHint.keys.length !== 1) {
    return (
      <MessageStrip design="Information" hideCloseButton style={{ margin: "1rem" }}>
        This entity uses a composite key and cannot be opened yet.
      </MessageStrip>
    );
  }
  if (!ov.selectedId) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
        No object view is available for “{entity}”.
      </MessageStrip>
    );
  }
  if (object.error) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
        {object.error.message}
      </MessageStrip>
    );
  }
  if (!record || !schema || !working) return null;

  const { title, subtitle } = titleForRecord(entity, working, schema, profile);
  const selectedSectionId =
    section && definition.sections.some((s) => s.visible && s.id === section)
      ? section
      : definition.sections.find((s) => s.visible)?.id;

  return (
    <>
      <ObjectPage
        selectedSectionId={selectedSectionId}
        onSelectedSectionChange={(e) => setSection(e.detail.selectedSectionId)}
        titleArea={
          <ObjectPageTitle
            header={<Title level="H4">{title}</Title>}
            subHeader={subtitle ? <Text>{subtitle}</Text> : undefined}
            actionsBar={
              <Toolbar design="Transparent">
                <ObjectVariantPopover ov={ov} />
                <ToolbarButton
                  design="Transparent"
                  icon="course-book"
                  text="Sections"
                  onClick={() => setPickerTarget(SECTIONS_PICKER)}
                />
                <ToolbarButton
                  design="Transparent"
                  text="Header fields"
                  onClick={() => setPickerTarget("header")}
                />
                {!editing ? (
                  <ToolbarButton
                    design="Emphasized"
                    text="Edit"
                    disabled={!capabilities.canEdit}
                    tooltip={
                      capabilities.canEdit
                        ? undefined
                        : (capabilities.reason ?? "Not editable")
                    }
                    onClick={beginEdit}
                  />
                ) : null}
              </Toolbar>
            }
          />
        }
        headerArea={
          headerFields.length ? (
            <ObjectPageHeader>
              <EntityObjectFacets
                entity={entity}
                schema={schema}
                profile={profile}
                variant={definition}
                working={working}
                draft={draft}
                dirtyPaths={dirtyPaths}
                capabilities={capabilities}
                mode={editing ? "edit" : "display"}
                onDraftChange={(next, paths) => {
                  setDraft(next);
                  setDirtyPaths(paths);
                }}
              />
            </ObjectPageHeader>
          ) : undefined
        }
        footerArea={
          editing ? (
            <Bar
              design="FloatingFooter"
              startContent={
                statusStrip ? (
                  <MessageStrip design={statusStrip.design} hideCloseButton>
                    {statusStrip.text}
                  </MessageStrip>
                ) : saveErrors.length ? (
                  <ObjectStatus state="Critical">
                    Required: {saveErrors.join(", ")}
                  </ObjectStatus>
                ) : undefined
              }
              endContent={
                <>
                  <Button design="Transparent" disabled={cancelDisabled} onClick={cancelEdit}>
                    Cancel
                  </Button>
                  <Button design="Emphasized" disabled={saveDisabled} onClick={() => void saveEdit()}>
                    Save
                  </Button>
                </>
              }
            />
          ) : undefined
        }
      >
        {/* Array, not a component: ObjectPage only sees sections that are direct children. */}
        {renderObjectSections({
          entity,
          schema,
          profile,
          record,
          draft,
          dirtyPaths,
          variant: definition,
          capabilities,
          onDraftChange: (next, paths) => {
            setDraft(next);
            setDirtyPaths(paths);
          },
          onEditSectionFields: setPickerTarget,
        })}
      </ObjectPage>

      <FieldPicker
        open={pickerTarget != null}
        title={
          pickerTarget === "header"
            ? "Header fields"
            : pickerTarget === SECTIONS_PICKER
              ? "Sections"
              : `Fields — ${pickerTarget ?? ""}`
        }
        fields={pickerFields}
        available={pickerAvailable}
        onClose={() => setPickerTarget(null)}
        onConfirm={(fields) => {
          if (pickerTarget === "header") {
            ov.setDefinition((d) => ({ ...d, header: fields }));
          } else if (pickerTarget === SECTIONS_PICKER) {
            ov.setDefinition((d) => applySectionPicker(d, fields, schema));
          } else if (pickerTarget) {
            ov.setDefinition((d) => ({
              ...d,
              sections: d.sections.map((s) =>
                s.id === pickerTarget ? { ...s, fields } : s,
              ),
            }));
          }
        }}
      />
    </>
  );
}
