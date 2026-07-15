import { useMemo, type CSSProperties } from "react";
import { Input, SuggestionItemCustom } from "@ui5/webcomponents-react";
import { DslError, parse, type Issue, type ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions } from "./exprHelpers.ts";

// The one expression editor used everywhere in the builder: monospace, parse-on-change with
// span-accurate messages, trailing-token suggestions in the Input's native popup. Each
// suggestion's text is the *completed* expression, so picking one just fires onInput with it.

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
  /** DOM id (MessageView jump target) */
  fieldId?: string;
  style?: CSSProperties;
}) {
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

  const sugg = matches(all, text).slice(0, 8);

  return (
    <Input
      id={fieldId}
      style={{ width: "100%", ...style }}
      className="hera-expr" // fontFamily via CSS part
      value={text}
      placeholder={placeholder}
      valueState={error ? "Negative" : "None"}
      valueStateMessage={<div>{errorText}</div>}
      showSuggestions
      noTypeahead // items carry the whole completed expression; autocompleting it while typing fights the caret
      onInput={(e) => {
        const v = e.target.value ?? "";
        onChange(v === "" && optional ? undefined : v);
      }}
      data-expr-input
    >
      {sugg.map((s) => (
        // text drives autocomplete/insertion (the full completed expression, preserving
        // mid-expression completion); children render key + label only.
        // ponytail: secondary blank for non-param kinds; functions still identify by the inserted "(".
        <SuggestionItemCustom key={s.text} text={complete(text, s)}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", width: "100%" }}>
            <span>{s.text}</span>
            <span style={{ color: "var(--sapContent_LabelColor)" }}>{s.label ?? ""}</span>
          </div>
        </SuggestionItemCustom>
      ))}
    </Input>
  );
}
