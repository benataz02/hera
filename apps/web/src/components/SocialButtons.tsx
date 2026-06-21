import { Button } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";

// Brand glyphs as inline SVG (no icon dependency). Shared by login + signup.
const GoogleGlyph = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.2 13.5 17.6 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
    <path fill="#FBBC05" d="M10.4 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-2.9.8-4.3l-7.8-6.1C.9 16.7 0 20.2 0 24s.9 7.3 2.6 10.4l7.8-6.1z" />
    <path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.5-5.8c-2 1.4-4.7 2.3-7.8 2.3-6.4 0-11.8-4-13.6-9.7l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
  </svg>
);
const MicrosoftGlyph = () => (
  <svg viewBox="0 0 23 23" aria-hidden="true">
    <path fill="#F25022" d="M1 1h10v10H1z" />
    <path fill="#7FBA00" d="M12 1h10v10H12z" />
    <path fill="#00A4EF" d="M1 12h10v10H1z" />
    <path fill="#FFB900" d="M12 12h10v10H12z" />
  </svg>
);

export function SocialButtons({ callbackURL = "/" }: { callbackURL?: string }) {
  return (
    <div className="auth-social">
      <Button onClick={() => authClient.signIn.social({ provider: "google", callbackURL })}>
        <span className="auth-social__label"><GoogleGlyph /> Continue with Google</span>
      </Button>
      <Button onClick={() => authClient.signIn.social({ provider: "microsoft", callbackURL })}>
        <span className="auth-social__label"><MicrosoftGlyph /> Continue with Microsoft</span>
      </Button>
    </div>
  );
}
