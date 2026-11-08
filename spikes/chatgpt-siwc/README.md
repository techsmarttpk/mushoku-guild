# spikes/chatgpt-siwc — DISPOSABLE research experiment

> **Not production code.** This is a throwaway Phase 1 experiment that produced evidence for `docs/context.md` §12. It is not part of the application, must not be imported or built upon, and will be deleted or replaced once the real implementation exists (Phase 3). It was run once, on one machine, with one ChatGPT account.

## What it tests
Whether the official *Sign in with ChatGPT* open-source "plan usage" flow works end to end: dynamic registration, OAuth authorization code + PKCE with the documented loopback redirect, token exchange, ID-token validation, model discovery, and one streamed Responses API request.

## What it does not do
No token refresh, revocation, persistence, multi-account handling, usage-limit handling or tests. It handles only RS256 ID tokens. The OpenAI DevKit code was neither used nor read. The behaviour reflects OpenAI's documentation and service as of 2026-11-08 and may change; the flow is still described by OpenAI as a preview.

## Safety properties
- Authentication happens in the user's own browser on `auth.openai.com`; the script never sees a password.
- Tokens exist only in process memory. **Nothing is written to disk**, and tokens are never printed (all output passes through a redactor that masks known tokens and JWT-shaped strings).
- Uses only documented endpoints: `auth.openai.com/api/accounts/authorize` and `/oauth/token`, the discovery document and JWKS, `api.openai.com/v1/models`, `api.openai.com/v1/responses`. No API key, no cookies, no website automation, no `backend-api`.
- Running it creates a connected-app grant ("Mushoku Guild") in the signed-in ChatGPT account. The script does not revoke it; remove it in ChatGPT Settings after testing.
- Running it uses a small amount of the account's ChatGPT plan usage.

## Run (Node 20+, no install, no dependencies)
`node spikes/chatgpt-siwc/spike.mjs` (optional env: `SPIKE_PORT`, default 1455; `SPIKE_MODEL`, default the first listed model).

## References
https://developers.openai.com/siwc/token-sharing-open-source · https://developers.openai.com/siwc/token-sharing-open-source/sign-in · https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
