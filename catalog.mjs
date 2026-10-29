// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie reads (id, name, context,
// modalities, protocol, reasoning) — the vendor's prices stay out of it, as
// the plugin reports none (see README). Kept as the list the provider has
// before the vendor is asked (and when it cannot be reached). Regenerate it
// when Codar adds models; `provider.models` refreshes it live.
export const CATALOG = [
  {
    "id": "auto",
    "name": "auto",
    "context": 1000000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "claude-opus-5",
    "name": "claude-opus-5",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "claude-opus-5-5",
    "name": "claude-opus-5-5",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "claude-opus-5-5-kiro",
    "name": "claude-opus-5-5-kiro",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "claude-opus-5-kiro",
    "name": "claude-opus-5-kiro",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "claude-sonnet-5",
    "name": "claude-sonnet-5",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "claude-sonnet-5-kiro",
    "name": "claude-sonnet-5-kiro",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true
  },
  {
    "id": "deepseek-v4-flash",
    "name": "deepseek-v4-flash",
    "context": 1000000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "deepseek-v4-pro",
    "name": "deepseek-v4-pro",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "deepseek-v4.1-flash",
    "context": 1000000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "glm-5.2",
    "name": "glm-5.2",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "glm-5.3",
    "name": "glm-5.3",
    "context": 1000000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "glm-5.3-flash",
    "name": "glm-5.3-flash",
    "context": 1000000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "gpt-5.6-sol",
    "name": "gpt-5.6-sol",
    "context": 128000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "gpt-6-astra",
    "name": "gpt-6-astra",
    "context": 128000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  },
  {
    "id": "gpt-6-sol",
    "name": "gpt-6-sol",
    "context": 128000,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true
  }
]
