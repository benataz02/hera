# Contextual follow-up suggestions

## Goal

Do not invoke `suggestFollowUps` for greetings or other turns that do not advance a product configuration.

## Behavior

- Call `suggestFollowUps` only after handling a substantive configuration request or completing a configurator action.
- Call it only when one or more concrete, relevant next steps exist.
- Do not call it for greetings, thanks, casual conversation, capability questions, clarification requests, failed actions, or no-op turns.
- When it is not applicable, answer the user directly without emitting the tool's status event.

## Implementation

Replace the unconditional follow-up instruction in `buildAssistPrompt` with the eligibility rules above. Keep the tool and event flow unchanged.

## Verification

Add a focused prompt-builder test that asserts the prompt contains both the positive eligibility rule and the explicit exclusions.
