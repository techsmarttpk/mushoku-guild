# Multi-model provider research

Status: **research only (Cycle 6, 2026-11-09). Nothing in this document is implemented.** The existing ChatGPT OAuth/Codex pipeline and the Claude Code CLI integration are unchanged.

## 1. Recommendation (short)

1. **Keep** ChatGPT OAuth (Rust, `chatgpt.rs`) and the native Claude Code CLI (`claude.rs`) exactly as they are.
2. **Add one Rust-native "OpenAI-compatible" provider adapter** (base URL + optional API key + model id). It covers, with configuration only: **Ollama**, **LM Studio**, **OpenRouter**, **Gemini** (through Google's OpenAI-compatibility endpoint), a direct **OpenAI API key**, and a hosted gateway such as **Vercel AI Gateway**. This confirms your initial preference.
3. **Do not** add the Vercel AI SDK (or any Node/TypeScript runtime) to the app. Its value is a JavaScript abstraction; the app already has a Rust security boundary, and the gateway behind it can be used as a plain base URL without the SDK.
4. **Defer** a dedicated Anthropic API adapter and a native Gemini adapter. Claude is already served by Claude Code; Gemini works through the compatible endpoint for chat. Build them only if a concrete need appears (for example Claude without Claude Code, Gemini-only features).
5. Provider use stays **chat-first** (Universal Chat). Letting a third-party model drive repository work (quests) is a separate decision because it needs tool calling, an approval model and sandboxing that only Claude Code provides today.

Where research **challenged** the preference: OpenRouter, Ollama and Gemini are not perfectly "OpenAI-compatible". The adapter must tolerate documented differences (streaming usage, tool-call deltas, image handling), see §4.

## 2. What was checked

Sources used (official documentation unless marked). Search snippets were read; pages marked *(not fetched)* were only seen through search results, so their details should be re-confirmed before implementation.

| Topic | Source |
|---|---|
| OpenAI Responses API: image input, function calling, structured outputs (`text.format`) | [Images and vision](https://platform.openai.com/docs/guides/images-vision), [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Migrate to Responses](https://platform.openai.com/docs/guides/migrate-to-responses) |
| Anthropic Messages API: SSE streaming, tool use, `x-api-key` | [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [API usage primer](https://platform.claude.com/docs/en/claude_api_primer) |
| Gemini OpenAI compatibility, base URL, API key | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai); forum reports on streamed tool calls and usage ([thread](https://discuss.ai.google.dev/t/gemini-openai-compatibility-issue-with-tool-call-streaming/59886), [thread](https://discuss.ai.google.dev/t/gemini-openai-compatibility-does-it-support-the-stream-options-parameter/92785)) are community reports |
| OpenRouter: `/api/v1/chat/completions`, `/api/v1/responses`, SSE, tools, usage and cost | [API reference](https://openrouter.ai/docs/api_reference/overview), [Create a chat completion](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [FAQ](https://openrouter.ai/docs/faq) |
| Ollama: `/v1/chat/completions` with streaming, vision, tools | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility); GitHub issues on streamed tool calls and image URLs are community reports |
| LM Studio: local server `localhost:1234`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`, structured output, tool use | [OpenAI compatibility](https://lmstudio.ai/docs/app/api/endpoints/openai), [Structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output), [Tool use](https://lmstudio.ai/docs/developer/openai-compat/tools) |
| Vercel AI Gateway: OpenAI Chat/Responses and Anthropic Messages compatible, token pass-through pricing | [AI Gateway](https://vercel.com/ai-gateway), [pricing](https://vercel.com/academy/ai-gateway/ai-gateway-pricing) (vendor pages) |

Not independently verified in this cycle (stated from general knowledge, re-check before building): the exact shape of each provider's *list models* endpoint, rate limits and current prices, and each vendor's terms for third-party clients. **Terms:** an API key is the normal, supported way for a third-party app to call a vendor API. Using someone's *consumer subscription* login from a third-party app is a different matter and is exactly why the current ChatGPT pipeline is kept isolated and unchanged; none of the new providers should reuse subscription credentials.

## 3. Provider comparison

| | Complexity (in Rust, on top of the generic adapter) | Auth | Streaming | Vision | Tools | Structured output | Model discovery | Cost visibility | Offline |
|---|---|---|---|---|---|---|---|---|---|
| **OpenAI API (key)** | Low (same adapter; Responses API later) | API key | SSE | Yes (`input_image`, URL or base64) | Yes | Yes (`json_schema`) | list-models endpoint | Dashboard + `usage` in responses | No |
| **Anthropic API (key)** | Medium (own adapter: different request/stream format) | `x-api-key` | SSE (typed events) | Yes | Yes | Yes (tool/JSON schema) | list-models endpoint | `usage` in responses | No |
| **Gemini** | Low through the compatible endpoint; medium for native | API key | SSE; community reports of missing tool-call `index` and usage needing `stream_options` | Yes | Yes, with the caveats above | Partly | list-models endpoint | `usage` only if requested when streaming | No |
| **OpenRouter** | Low (same adapter) | API key | SSE; usage arrives in a final chunk that also has `choices` (differs from OpenAI) | Model dependent | Model dependent (`supported_parameters`) | Model dependent | Models endpoint with per-model pricing and capabilities | **Best**: `usage` with `cost` per call | No |
| **Generic OpenAI-compatible** | Low | Optional key | SSE | Server dependent | Server dependent | Server dependent | `GET /models` when offered | Server dependent | If self-hosted |
| **Ollama** | Low (same adapter; native `/api/chat` is the fallback if compat streaming of tools misbehaves) | None (local) | Yes | Yes (community: needs `data:` URLs, not https URLs) | Yes (community: streamed tool calls were unreliable on the compat endpoint in some versions) | Yes | Installed-model list | None (free, local compute) | **Yes** |
| **LM Studio** | Low (same adapter) | None (local) | Yes | Model dependent | Yes (`tool_choice` supported) | Yes (`json_schema`) | `GET /v1/models` (loaded models) | None | **Yes** |
| **Vercel AI SDK** | High *for this app*: JS runtime, JS credentials | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Vercel AI Gateway** (service) | Low (just a base URL; OpenAI/Anthropic compatible) | Gateway key | SSE | Model dependent | Model dependent | Model dependent | Gateway model list | Pass-through pricing, billing in Vercel | No |

Billing implications: OpenAI/Anthropic/Gemini API keys are **pay-per-token on a separate account**, not the ChatGPT or Claude subscriptions the app uses today. OpenRouter and gateways add one aggregated bill; Vercel states no token markup. Local models cost nothing per token but need capable hardware.

## 4. Architecture evaluation

| Option | Verdict | Why |
|---|---|---|
| Rust-native provider abstraction | **Yes, minimal** | Rust already owns credentials (`keyring`), processes and HTTP (`ureq` with SSE parsing in `chatgpt.rs`). One small trait (`stream(messages, options) -> deltas`) satisfies ADR-0009's "smallest boundary that works". |
| Provider-specific adapters | **Only when needed** | Anthropic native and Gemini native have real format differences; add each only for a feature the generic adapter cannot provide. |
| Generic OpenAI-compatible adapter | **Yes, first** | Covers six of the eight requested options with configuration. Tolerate the known differences: usage in a final chunk or only when `stream_options` asks, tool-call deltas without `index`, images as `data:` URLs, model lists missing or partial. |
| Unified TypeScript SDK through a backend boundary | **No** | Needs a Node sidecar or putting keys in the webview. Both break the security boundary the app relies on, for no capability the Rust adapter lacks. |
| Gateway (OpenRouter, Vercel AI Gateway) | **Optional, as a preset** | Useful for model choice and cost reporting. It is just a base URL in the generic adapter, so it adds no architecture. It also adds a third party that sees prompts. |

### Security design for the future adapter
- Credentials: Windows Credential Manager through the existing `keyring` dependency; never SQLite, never the webview, never logs (reuse the existing redaction).
- Base URL rules: `https://` for remote hosts; plain `http://` only for loopback (`localhost`, `127.0.0.1`, `[::1]`). No redirects to other hosts with the key attached.
- The webview CSP stays closed (`connect-src 'self' ipc:`): all provider traffic stays in Rust.
- Data flow is explicit per provider: Universal Chat sends only that conversation; repository content is never sent to a third-party provider unless the user chooses it for that action, and the UI says which provider receives it.
- Responses are untrusted text (same rule as today); no provider output is executed.
- Model lists are fetched on demand, bounded, and cached briefly; a provider that does not implement `/models` accepts a typed model id.

## 5. Recommended implementation order (future cycles)

1. **Provider settings and storage:** a `providers` table (id, label, kind, base URL, default model, no secret) and key storage in Credential Manager. Settings UI with a "Test connection" button (`GET /models`, then a one-token completion).
2. **Generic OpenAI-compatible adapter** for Universal Chat only: Chat Completions, SSE streaming, model list, error taxonomy mapped to the existing `ErrorKind`.
3. **Presets:** Ollama (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`), OpenRouter, Gemini (`https://generativelanguage.googleapis.com/v1beta/openai/`), OpenAI. Each preset is only defaults plus a short list of known quirks.
4. **Usage display:** show tokens and, where the response carries it (OpenRouter `cost`), the cost, per message.
5. **Vision** in Universal Chat for providers that advertise it (reuse the attachment validation from Cycle 5; local servers get `data:` URLs).
6. **Only then**, and only on demand: native Anthropic adapter, native Gemini adapter, tool calling for third-party models, or Responses API for OpenAI.

## 6. What stays unchanged

- **ChatGPT:** OAuth connection, token storage, model selection, the Codex/plan-usage request path and its billing behaviour. No refactor into the new abstraction in the first cycles; it may be wrapped behind the same trait later without changing how it authenticates or bills.
- **Claude:** the installed Claude Code CLI, its own login, stream-json process control, the approval/permission system, and the no-tools conversation mode of Universal Chat.
- **Guild Chat** workflow (ChatGPT advises, Claude researches read-only) and **quests** (Claude Code executes) remain tied to those two providers.

## 7. Risks and open questions

- OpenAI-compatible endpoints drift; keep adapter tests against recorded fixtures plus an opt-in live test per preset.
- Community reports (Ollama streamed tools and image URLs, Gemini tool-call index) are version-dependent: re-test on current versions before relying on tools through those endpoints.
- Provider terms and prices change; the app should link to each provider's terms next to its settings and never hard-code prices.
- Whether non-chat uses (summaries, titles) should ever use a third-party provider is a product decision; today idle dialogue uses zero AI calls and must stay that way.
