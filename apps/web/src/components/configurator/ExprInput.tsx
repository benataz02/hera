import { useId, useMemo, useState, type CSSProperties } from "react";
import { Input, List, ListItemStandard, Popover } from "@ui5/webcomponents-react";
import { DslError, parse, type Issue, type ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions, type Suggestion } from "./exprHelpers.ts";

// The one expression editor used everywhere in the builder: monospace, parse-on-change with
// span-accurate messages, trailing-token suggestions in a Popover (spec: "suggestion Popover").

// Monospace inside the shadow DOM via the exposed `input` CSS part.
if (typeof document !== "undefined" && !document.getElementById("hera-expr-style")) {
  const el = document.createElement("style");
  el.id = "hera-expr-style";
  el.textContent = `.hera-expr::part(input){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}`;
  document.head.appendChild(el);
}

export function ExprInput({
  value,
  onChange,
  model,
  extraVars,
  placeholder,
  optional = false,
  issue,
  fieldId,
  style,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  model: ModelDef;
  extraVars?: string[];
  placeholder?: string;
  /** empty input -> undefined (for condition/when/default fields) */
  optional?: boolean;
  /** semantic issue from checkModel for this field, shown when the text parses */
  issue?: Issue;
  /** DOM id (MessageView jump target); defaults to a generated one */
  fieldId?: string;
  style?: CSSProperties;
}) {
  const autoId = useId().replace(/[^a-zA-Z0-9_-]/g, "_"); // ui5 Popover opener needs a plain id
  const id = fieldId ?? `expr-${autoId}`;
  const [focused, setFocused] = useState(false);
  const text = value ?? "";
  const all = useMemo(() => scopeSuggestions(model, extraVars), [model, extraVars]);

  const parseError = useMemo(() => {
    if (text.trim() === "") return null; // emptiness is the caller's concern (optional/required)
    try {
      parse(text);
      return null;
    } catch (e) {
      return e instanceof DslError ? e : null;
    }
  }, [text]);
  const error = parseError ?? issue ?? null;
  const errorText = error
    ? `${error.message}${error.from !== undefined ? ` — at «${text.slice(error.from, error.to) || "end"}»` : ""}`
    : "";

  const sugg = focused ? matches(all, text).slice(0, 8) : [];
  const pick = (s: Suggestion) => onChange(complete(text, s));

  return (
    <>
      <Input
        id={id}
        style={{ width: "100%", ...style }}
        className="hera-expr" // fontFamily via CSS part is unavailable; monospace set inline below
        value={text}
        placeholder={placeholder}
        valueState={error ? "Negative" : "None"}
        valueStateMessage={<div>{errorText}</div>}
        onInput={(e) => {
          const v = e.target.value ?? "";
          onChange(v === "" && optional ? undefined : v);
        }}
        onFocus={() => setFocused(true)}
        // Delay so a click on a suggestion lands before the popover unmounts.
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        data-expr-input
      />
      {sugg.length > 0 && (
        <Popover opener={id} open placement="Bottom" preventInitialFocus hideArrow>
          <List
            onItemClick={(e) => {
              const t = (e.detail.item as HTMLElement).dataset.suggest;
              const s = sugg.find((x) => x.text === t);
              if (s) pick(s);
            }}
          >
            {sugg.map((s) => (
              <ListItemStandard key={s.text} data-suggest={s.text} additionalText={s.kind}>
                {s.text}
              </ListItemStandard>
            ))}
          </List>
        </Popover>
      )}
    </>
  );
}
