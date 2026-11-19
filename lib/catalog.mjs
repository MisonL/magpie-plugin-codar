// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie reads (id, name, context,
// maxOutput, input, output, protocol, reasoning, rate). rate is the vendor's
// own credit multiple (rate_badge, "0.20x"), shown by magpie beside the
// model; the vendor's prices in CNY stay out of it, as magpie's cost column is
// US dollars (see README). maxOutput is the reply ceiling the vendor's own
// request schema states (max_tokens.maximum), 0 where it states none. Kept as
// the list the provider has before the vendor is asked (and when it cannot be
// reached). Regenerate it with `node scripts/catalog.mjs` when Codar adds
// models; `provider.models` refreshes it live.
export const CATALOG = [
  {
    "id": "auto",
    "name": "auto",
    "context": 1000000,
    "maxOutput": 393216,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.2
  },
  {
    "id": "claude-opus-5-5",
    "name": "claude-opus-5-5",
    "context": 1000000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true,
    "rate": 1.37
  },
  {
    "id": "claude-opus-5-5-kiro",
    "name": "claude-opus-5-5-kiro",
    "context": 1000000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true,
    "rate": 0.55
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "claude-sonnet-5-5",
    "context": 1000000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true,
    "rate": 0.93
  },
  {
    "id": "claude-sonnet-5-5-kiro",
    "name": "claude-sonnet-5-5-kiro",
    "context": 1000000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "anthropic_messages",
    "reasoning": true,
    "rate": 0.37
  },
  {
    "id": "deepseek-v4-flash",
    "name": "deepseek-v4-flash",
    "context": 1000000,
    "maxOutput": 393216,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.2
  },
  {
    "id": "deepseek-v4-pro",
    "name": "deepseek-v4-pro",
    "context": 1000000,
    "maxOutput": 393216,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.95
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "deepseek-v4.1-flash",
    "context": 1000000,
    "maxOutput": 393216,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.2
  },
  {
    "id": "deepseek-v4.1-flash-economy",
    "name": "deepseek-v4.1-flash-economy",
    "context": 1000000,
    "maxOutput": 393216,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.12
  },
  {
    "id": "gemini-4-argon",
    "name": "gemini-4-argon",
    "context": 1048576,
    "maxOutput": 65536,
    "input": [
      "text",
      "image",
      "audio"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.55
  },
  {
    "id": "gemini-4-argon-official",
    "name": "gemini-4-argon-official",
    "context": 1048576,
    "maxOutput": 65536,
    "input": [
      "text",
      "image",
      "audio"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 3.28
  },
  {
    "id": "glm-5.2",
    "name": "glm-5.2",
    "context": 1000000,
    "maxOutput": 131072,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 2.57
  },
  {
    "id": "glm-5.3",
    "name": "glm-5.3",
    "context": 1000000,
    "maxOutput": 131072,
    "input": [
      "text"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 2.57
  },
  {
    "id": "glm-5.3-flash",
    "name": "glm-5.3-flash",
    "context": 1000000,
    "maxOutput": 131072,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.29
  },
  {
    "id": "gpt-5.6-sol",
    "name": "gpt-5.6-sol",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.77
  },
  {
    "id": "gpt-6-astra",
    "name": "gpt-6-astra",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 1.48
  },
  {
    "id": "gpt-6-sol",
    "name": "gpt-6-sol",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.3
  },
  {
    "id": "gpt-6.1-sol",
    "name": "gpt-6.1-sol",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.3
  },
  {
    "id": "gpt-6.2-astra",
    "name": "gpt-6.2-astra",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.87
  },
  {
    "id": "gpt-6.2-sol",
    "name": "gpt-6.2-sol",
    "context": 1050000,
    "maxOutput": 128000,
    "input": [
      "text",
      "image"
    ],
    "output": [
      "text"
    ],
    "protocol": "openai_chat_completions",
    "reasoning": true,
    "rate": 0.3
  }
]
