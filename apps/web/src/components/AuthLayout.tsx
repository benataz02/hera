import type { CSSProperties, ReactNode } from "react";
import "./AuthLayout.css";

const delay = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });

// Branded split-screen used by login / signup / onboarding. Left panel is pure
// presentation (the cloud -> agent -> B1 sync motif); right panel slots the form.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-root">
      <aside className="auth-brand">
        <div className="auth-brand__inner">
          <h1 className="auth-brand__mark reveal" style={delay(0)}>HERA</h1>
          <p className="auth-brand__tagline reveal" style={delay(90)}>
            Quotes that reach SAP&nbsp;B1.<br />
            <em>Exactly once.</em>
          </p>
          <div className="auth-brand__pulse reveal" style={delay(180)} aria-hidden="true">
            <span className="node">CLOUD</span>
            <span className="wire"><i className="dot" /></span>
            <span className="node">AGENT</span>
            <span className="wire"><i className="dot dot--2" /></span>
            <span className="node">SAP&nbsp;B1</span>
          </div>
          <p className="auth-brand__foot reveal" style={delay(260)}>
            Outbound-only · idempotent by design
          </p>
        </div>
      </aside>
      <main className="auth-panel">
        <div className="auth-panel__form reveal" style={delay(120)}>{children}</div>
      </main>
    </div>
  );
}
