//! The smallest common boundary for model providers that answer chat messages (ADR-0015).
//!
//! OpenRouter implements it today. ChatGPT (OAuth, Codex plan usage) and Claude Code (a CLI process with its own
//! login and permission system) are intentionally NOT forced through it: their authentication, billing and execution
//! models differ, and Cycle 7 must not change them. A provider states what it supports; nothing is assumed.
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::events::ProviderError;

/// What a model can do according to the provider's own metadata. `false` means "not advertised", never "unknown but probably".
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub text_input: bool,
    pub text_output: bool,
    pub image_input: bool,
    pub image_output: bool,
    pub tools: bool,
    pub structured_output: bool,
    /// Streaming is a property of the provider's API, not of a single model.
    pub streaming: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// Money the provider says this call cost. Always zero or absent for the free-only integration; shown so a surprise is visible.
    pub cost: Option<f64>,
}

pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    /// (role, text) pairs, oldest first; roles are "user" and "assistant".
    pub messages: Vec<(String, String)>,
    pub max_tokens: Option<u32>,
}

pub struct ChatOutcome {
    pub text: String,
    pub usage: Option<Usage>,
}

pub trait ChatProvider {
    /// Streams the reply through `on_delta`; returns the whole text. Must honour `cancel` promptly.
    fn stream(&self, req: &ChatRequest, cancel: &AtomicBool, on_delta: &mut dyn FnMut(&str)) -> Result<ChatOutcome, ProviderError>;
}
