---
template: 'post'
title: 'Cost-Effective LLM Integration with OpenAI & Claude APIs'
date: '2023-12-01'
slug: 'cost-effective-llm-integration'
tags: ['genai', 'openai', 'api', 'saas', 'python']
categories: ['Engineering', 'GenAI']
description: 'Techniques for prompt caching, token optimization, semantic routing, and streaming responses in production applications.'
thumbnail: '../thumbnails/ai.png'
---

Integrating LLM APIs like OpenAI GPT-4o and Anthropic Claude into high-volume SaaS applications can quickly escalate operational costs if not engineered with token efficiency in mind.

The trap is that it looks cheap in development. A few hundred test calls cost almost nothing, so nobody pays attention to how prompts are built. Then the feature ships, every user action fires a request carrying a multi-thousand-token system prompt, retries double the bill on bad outputs, and the monthly invoice becomes a line item that finance starts asking about.

In this post I'll walk through the strategies I rely on to keep LLM spend predictable without making the product worse: what each one does, why it works, and where it bites you.

## Where the Money Actually Goes

Before optimizing anything, it helps to be precise about the cost model. Both OpenAI and Anthropic bill per token, separately for **input** (prompt) and **output** (completion), and output tokens are priced several times higher than input tokens. A request costs roughly:

```text
cost = (input_tokens × input_price) + (output_tokens × output_price)
```

That formula points directly at the levers:

| Lever | What it reduces | Typical technique |
| --- | --- | --- |
| Don't call the model at all | Everything | Semantic caching |
| Call a cheaper model | Price per token | Model tier routing |
| Send fewer input tokens | Input cost | Prompt trimming, prompt caching |
| Generate fewer output tokens | Output cost | Structured outputs, `max_tokens` |
| Avoid wasted calls | Retries | Schema guarantees, validation |

The first thing I do on any LLM feature is log `usage` from every response (input tokens, output tokens, cached tokens, model) tagged by feature. Without that, you're guessing which endpoint is expensive.

```python
import logging

logger = logging.getLogger("llm.usage")

def log_usage(feature: str, model: str, usage) -> None:
    details = getattr(usage, "prompt_tokens_details", None)
    logger.info(
        "llm_call",
        extra={
            "feature": feature,
            "model": model,
            "input_tokens": usage.prompt_tokens,
            "output_tokens": usage.completion_tokens,
            "cached_tokens": getattr(details, "cached_tokens", 0) if details else 0,
        },
    )
```

## Strategies for Cost Reduction

1. **Semantic Prompt Caching**:
   Using Redis with vector embeddings to return cached responses for semantically identical questions.
2. **Model Tier Routing**:
   Routing simple classification, tag extraction, or formatting tasks to lightweight models (e.g. GPT-4o-mini / Claude 3.5 Haiku) while reserving frontier models for reasoning tasks.
3. **Structured Outputs & Schema Constraints**:
   Enforcing JSON mode with schema guarantees to eliminate repetitive prompt instructions and output truncation retries.

On top of these three, provider-side **prompt caching** and **streaming** round out the toolkit. Let's go through each.

## 1. Semantic Prompt Caching with Redis

An exact-match cache (hash the prompt, look it up) works for deterministic batch jobs, but user-facing questions rarely repeat byte-for-byte. "How do I reset my password?" and "how can I reset my password" should hit the same answer. A semantic cache solves this by embedding the query and looking for a stored entry whose vector is close enough.

The flow is:

1. Embed the incoming query with a cheap embedding model.
2. Run a KNN search against a Redis vector index.
3. If the nearest neighbour is within a distance threshold, return its stored response.
4. Otherwise call the LLM, then store `(embedding, response)` with a TTL.

### Creating the index

```python
import redis
from redis.commands.search.field import TagField, TextField, VectorField
from redis.commands.search.indexDefinition import IndexDefinition, IndexType

r = redis.Redis(host="localhost", port=6379)

EMBED_DIM = 1536  # text-embedding-3-small

schema = (
    TagField("namespace"),
    TextField("response"),
    VectorField(
        "embedding",
        "HNSW",
        {"TYPE": "FLOAT32", "DIM": EMBED_DIM, "DISTANCE_METRIC": "COSINE"},
    ),
)

try:
    r.ft("llm_cache").create_index(
        schema,
        definition=IndexDefinition(prefix=["llmcache:"], index_type=IndexType.HASH),
    )
except redis.ResponseError:
    pass  # index already exists
```

### Lookup and store

```python
import hashlib
import numpy as np
from openai import OpenAI
from redis.commands.search.query import Query

client = OpenAI()
DISTANCE_THRESHOLD = 0.08  # cosine distance; tune against real traffic
TTL_SECONDS = 60 * 60 * 24

def embed(text: str) -> bytes:
    resp = client.embeddings.create(model="text-embedding-3-small", input=text)
    return np.array(resp.data[0].embedding, dtype=np.float32).tobytes()

def cached_completion(namespace: str, question: str, generate) -> str:
    vec = embed(question)
    q = (
        Query(f"(@namespace:{{{namespace}}})=>[KNN 1 @embedding $vec AS distance]")
        .sort_by("distance")
        .return_fields("response", "distance")
        .dialect(2)
    )
    result = r.ft("llm_cache").search(q, query_params={"vec": vec})

    if result.docs and float(result.docs[0].distance) < DISTANCE_THRESHOLD:
        return result.docs[0].response

    answer = generate(question)
    key = "llmcache:" + hashlib.sha256(f"{namespace}:{question}".encode()).hexdigest()
    r.hset(key, mapping={"namespace": namespace, "response": answer, "embedding": vec})
    r.expire(key, TTL_SECONDS)
    return answer
```

### Things that go wrong

- **The threshold is the whole game.** Too loose and "cancel my subscription" returns the answer for "pause my subscription". I start strict and loosen only after reviewing sampled hits against misses.
- **Namespace everything.** The cache key must include anything that changes the correct answer: tenant, locale, prompt version, model. The `namespace` tag above is where that goes. Bump the prompt version and the old entries naturally stop matching.
- **Never cache personalized answers globally.** If the response depends on the user's data, either scope the namespace to that user or don't cache it.
- **The embedding call isn't free.** It's far cheaper than a completion, but on a low-hit-rate endpoint you can end up paying for embeddings with no savings. Measure the hit rate per feature and switch the cache off where it doesn't pay.

## 2. Model Tier Routing

Most of the calls in a typical SaaS product are not hard reasoning problems. Classifying a support ticket, extracting tags, rewriting text into a template, detecting language: a small model handles these well at a fraction of the price. Paying frontier-model rates for them is the single biggest source of waste I see.

I keep routing explicit and boring: a table from task type to model, owned in code and reviewed like any other config.

```python
from enum import Enum

class Task(str, Enum):
    CLASSIFY = "classify"
    EXTRACT_TAGS = "extract_tags"
    FORMAT = "format"
    SUMMARIZE = "summarize"
    REASON = "reason"

MODEL_ROUTES = {
    Task.CLASSIFY: "gpt-4o-mini",
    Task.EXTRACT_TAGS: "gpt-4o-mini",
    Task.FORMAT: "gpt-4o-mini",
    Task.SUMMARIZE: "gpt-4o-mini",
    Task.REASON: "gpt-4o",
}

def pick_model(task: Task, input_tokens: int) -> str:
    model = MODEL_ROUTES[task]
    # Very long inputs for summarization often need the stronger model to stay faithful.
    if task is Task.SUMMARIZE and input_tokens > 20_000:
        return "gpt-4o"
    return model
```

### Escalation instead of guessing

When I'm not sure whether a small model is good enough, I use a **try-cheap-then-escalate** pattern: call the small model first, validate the output (schema check, confidence field, business rules), and only retry on the larger model when validation fails. If the cheap model passes most of the time, the average cost drops sharply while quality on the hard cases is preserved.

```python
def classify_with_escalation(text: str) -> dict:
    result = call_classifier(model="gpt-4o-mini", text=text)
    if result is None or result["confidence"] < 0.7:
        result = call_classifier(model="gpt-4o", text=text)
    return result
```

The alternative I considered, and moved away from, was an LLM-based router that decides which model to use. It adds latency and its own cost on every request, and it's harder to reason about than a static table plus escalation.

### Provider routing

The same idea applies across providers. Claude 3.5 Haiku and GPT-4o-mini sit in a similar tier, and keeping a thin internal interface (`complete(task, messages, schema)`) over both SDKs means I can route by price, latency, or availability, and fail over when one provider has an incident.

## 3. Structured Outputs & Schema Constraints

A surprising amount of token spend goes to *asking* for a format: paragraphs of "respond only with JSON, use these keys, don't add commentary". Then the model occasionally adds commentary anyway, the parser fails, and you pay for a retry.

OpenAI's structured outputs move the format out of the prompt and into a schema that the API enforces:

```python
from pydantic import BaseModel
from openai import OpenAI

client = OpenAI()

class TicketTriage(BaseModel):
    category: str
    priority: int
    tags: list[str]

completion = client.beta.chat.completions.parse(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "Triage the support ticket."},
        {"role": "user", "content": ticket_text},
    ],
    response_format=TicketTriage,
    max_tokens=200,
)

triage = completion.choices[0].message.parsed
```

Benefits for cost:

- **Shorter system prompts**: no formatting instructions or few-shot examples just to show the shape.
- **Fewer retries**: output is guaranteed to match the schema, so parse failures don't trigger re-calls.
- **Smaller outputs**: no preamble like "Sure! Here is the JSON you requested", and terse key names keep completions small.

Always set `max_tokens`. It's both a cost ceiling and a guard against runaway generations. If a response hits the limit (`finish_reason == "length"`), log it. That usually means the limit or the schema needs adjusting, and a truncated JSON object is exactly the kind of failure that causes expensive retries.

On the Claude side, the equivalent pattern is to define a tool with a JSON schema for its input and force the model to call it with `tool_choice={"type": "tool", "name": "..."}`. The tool input becomes your structured result.

## 4. Provider-Side Prompt Caching

Semantic caching avoids calls entirely. Prompt caching makes the calls you *do* make cheaper by reusing the processed prefix of a prompt, which is ideal when a long system prompt, a policy document, or a set of few-shot examples is sent with every request.

### OpenAI

OpenAI applies prompt caching automatically on supported models (including GPT-4o and GPT-4o-mini) once a prompt passes a minimum length (1,024 tokens). Cached input tokens are billed at a discount and show up in `usage.prompt_tokens_details.cached_tokens`. There's no flag to set; the only job is to **structure prompts so the prefix is stable**:

- Put static content first (system prompt, instructions, examples).
- Put variable content last (user message, retrieved context).
- Don't inject timestamps, request IDs, or user names into the system prompt; one changing character near the top breaks the cache for everything after it.

### Anthropic

With Claude, caching is explicit. You mark the end of the cacheable prefix with `cache_control`:

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-3-5-haiku-20241022",
    max_tokens=512,
    system=[
        {
            "type": "text",
            "text": LONG_POLICY_DOCUMENT,  # large, stable prefix
            "cache_control": {"type": "ephemeral"},
        }
    ],
    messages=[{"role": "user", "content": user_question}],
)

print(response.usage.cache_creation_input_tokens, response.usage.cache_read_input_tokens)
```

The first request writes the cache (billed at a small premium over normal input), and subsequent requests within the cache lifetime read it at a large discount. The cache is short-lived (a few minutes, refreshed on each hit), so it pays off for steady traffic and bursts of related calls, not for a prompt used once an hour. Prefixes also have a minimum cacheable length that varies by model, so caching a short system prompt does nothing.

## 5. Streaming Responses

Streaming doesn't reduce token cost directly, but it changes the economics of the product in two useful ways. Time-to-first-token drops from seconds to a fraction of a second, which means users stop hammering "regenerate" out of impatience, and those duplicate requests are pure waste. It also lets you **cancel** generation when the user navigates away, so you stop paying for output tokens nobody will read.

```python
def stream_reply(messages):
    stream = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        max_tokens=800,
        stream=True,
        stream_options={"include_usage": True},
    )

    usage = None
    for chunk in stream:
        if chunk.usage:  # final chunk carries usage and has no choices
            usage = chunk.usage
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content

    if usage:
        log_usage("chat", "gpt-4o", usage)
```

Note `stream_options={"include_usage": True}`. Without it, streamed responses don't report token usage, and your cost dashboards quietly go blind on your most-used endpoint.

## 6. Token Hygiene

A few smaller habits add up:

- **Count before you send.** Use `tiktoken` to measure prompts and enforce a budget per feature.

  ```python
  import tiktoken

  enc = tiktoken.encoding_for_model("gpt-4o")

  def count_tokens(text: str) -> int:
      return len(enc.encode(text))
  ```

- **Trim conversation history.** Keep the last few turns verbatim and replace older ones with a running summary generated by a small model. Sending the full transcript on every turn makes cost grow quadratically with conversation length.
- **Be selective with RAG context.** Retrieving ten chunks "just in case" is often the largest part of the input. Fewer, better-ranked chunks are cheaper and usually give better answers.
- **Use batch APIs for offline work.** Both OpenAI and Anthropic offer asynchronous batch endpoints at a discount for jobs that don't need an immediate answer, such as nightly enrichment, backfills, and evaluations.

## Key Takeaways

- [ ] Log input, output, and cached tokens per feature and model before optimizing anything.
- [ ] Put a semantic cache in front of repetitive, non-personalized queries, with a strict threshold and versioned namespaces.
- [ ] Route by task: small models (GPT-4o-mini, Claude 3.5 Haiku) by default, frontier models only where reasoning is needed, with escalation on validation failure.
- [ ] Replace format instructions with structured outputs and always set `max_tokens`.
- [ ] Keep prompt prefixes stable for OpenAI's automatic caching; add `cache_control` breakpoints for Claude.
- [ ] Stream user-facing responses, support cancellation, and request usage in the stream.
- [ ] Trim history and RAG context, and push offline work to batch APIs.

## Conclusion

None of these techniques is exotic, and none of them requires sacrificing quality. Most of the savings come from not paying for work you don't need: repeated questions, oversized models, verbose prompts, and failed retries. Treat tokens like any other production resource: measure them, budget them, and design the system so the expensive path is the exception rather than the default.
