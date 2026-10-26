// catalog is Codar's model list as its own client keeps it: the answer to
// GET /v1/codar/models, reduced to what magpie needs, kept as the list the
// provider has before the vendor is asked (and when it cannot be reached).
// Regenerate it when Codar adds models; `provider.models` refreshes it live.
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
    "reasoning": true,
    "rate": "0.20x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 2.0,
      "output": 8.0,
      "cached_input": 0.04
    }
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
    "reasoning": true,
    "rate": "1.50x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 12.5,
      "output": 62.5,
      "cached_input": 1.25
    }
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
    "reasoning": true,
    "rate": "1.20x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 10.0,
      "output": 50.0,
      "cached_input": 0.5
    }
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
    "reasoning": true,
    "rate": "0.48x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 4.0,
      "output": 20.0,
      "cached_input": 0.2
    }
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
    "reasoning": true,
    "rate": "0.60x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 5.0,
      "output": 25.0,
      "cached_input": 0.5
    }
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
    "reasoning": true,
    "rate": "0.60x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 5.0,
      "output": 25.0,
      "cached_input": 0.5
    }
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
    "reasoning": true,
    "rate": "0.24x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 2.0,
      "output": 10.0,
      "cached_input": 0.2
    }
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
    "reasoning": true,
    "rate": "0.20x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 2.0,
      "output": 8.0,
      "cached_input": 0.04
    }
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
    "reasoning": true,
    "rate": "0.72x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 9.0,
      "output": 27.0,
      "cached_input": 0.3
    }
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
    "reasoning": true,
    "rate": "0.20x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 2.0,
      "output": 8.0,
      "cached_input": 0.04
    }
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
    "reasoning": true,
    "rate": "0.72x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 8.0,
      "output": 28.0,
      "cached_input": 2.0
    }
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
    "reasoning": true,
    "rate": "0.72x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 8.0,
      "output": 28.0,
      "cached_input": 2.0
    }
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
    "reasoning": true,
    "rate": "0.07x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 0.8,
      "output": 2.8,
      "cached_input": 0.23
    }
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
    "reasoning": true,
    "rate": "0.56x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 4.0,
      "output": 24.0,
      "cached_input": 0.4
    }
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
    "reasoning": true,
    "rate": "0.74x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 6.2,
      "output": 31.0,
      "cached_input": 0.62
    }
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
    "reasoning": true,
    "rate": "0.19x",
    "pricing": {
      "currency": "CNY",
      "unit": "per_million_tokens",
      "input": 1.6,
      "output": 8.0,
      "cached_input": 0.16
    }
  }
]
