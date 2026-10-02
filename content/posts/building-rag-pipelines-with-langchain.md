---
template: 'post'
title: 'Building Production RAG Pipelines with Node.js, LangChain & OpenAI'
date: '2023-09-05'
slug: 'building-rag-pipelines-with-langchain'
series: 'Production GenAI & RAG Pipelines'
tags: ['genai', 'rag', 'openai', 'node', 'langchain']
categories: ['Engineering', 'GenAI']
description: 'Step-by-step architecture for building an automated AI content pipeline using retrieval-augmented generation (RAG) in TypeScript.'
thumbnail: '../thumbnails/ai.png'
---

Retrieval-Augmented Generation (RAG) allows Large Language Models (LLMs) to answer queries using dynamic, domain-specific private data without costly fine-tuning.

In building **Blogineers** and AI classroom capabilities for **SessionOrbit**, we engineered high-accuracy RAG workflows capable of ingesting raw markdown and documents, vectorizing them, and synthesizing accurate answers.

A RAG demo takes an afternoon. A RAG system that gives correct, grounded answers day after day, across tenants, with content that changes constantly, takes considerably more thought. In this post I'll walk through the pipeline end to end in TypeScript: ingestion, chunking, embeddings, storage, retrieval and generation, along with the trade-offs and pitfalls that matter once real users start asking real questions.

## Why RAG Instead of Fine-Tuning?

Fine-tuning teaches a model a *style* or a *behaviour*. It's a poor way to teach it *facts*, especially facts that change. For our use cases (blog content, course material and class transcripts), the data was updated daily and had to be scoped per user or per organisation.

| Concern | RAG | Fine-tuning |
| --- | --- | --- |
| Fresh data | Re-index a document and it's live | Requires retraining |
| Per-tenant isolation | Metadata filters at query time | Separate model per tenant |
| Citations / traceability | Retrieved chunks can be shown as sources | Not available |
| Cost to update | Embedding calls only | Training run + evaluation |

RAG keeps the model general and moves the knowledge into a database you control. That's the property that makes it production-friendly.

## The Core Pipeline

```
[Raw Documents / Transcripts]
            │
      Text Splitter (RecursiveCharacterTextSplitter)
            │ Chunks (500 tokens, 10% overlap)
            ▼
   Embedding Generation (text-embedding-3-small)
            │
            ▼
    Vector Store (Supabase pgvector / Pinecone)
            │
   [User Query] ──► Query Embedding ──► Cosine Similarity Top-K
                                                │
                                                ▼
                             Context Injection + Prompt Template
                                                │
                                                ▼
                                    LLM Generation (OpenAI GPT-4o / Claude)
```

The pipeline splits naturally into two halves that run at very different times:

1. **Ingestion (offline / async):** load, clean, split, embed and store. This runs when content is created or updated, ideally in a background job.
2. **Query (online / latency-sensitive):** embed the question, retrieve, build the prompt and generate. This runs on every user request.

Keeping these separate, with ingestion in a queue worker and querying in the API, means a large upload never slows down a user's chat response.

## Step 1: Setting Up the Vector Store

We used **Supabase with pgvector** for most workloads and Pinecone where a fully managed vector index made more sense. The appeal of pgvector is that your vectors live next to your relational data, so tenant IDs, permissions and timestamps are all queryable with plain SQL in the same transaction.

`text-embedding-3-small` produces 1536-dimensional vectors, so the column must match:

```sql
create extension if not exists vector;

create table documents (
  id bigserial primary key,
  content text not null,
  metadata jsonb not null default '{}',
  embedding vector(1536)
);

-- Approximate nearest-neighbour index for cosine distance
create index on documents using hnsw (embedding vector_cosine_ops);
create index on documents using gin (metadata);

create or replace function match_documents (
  query_embedding vector(1536),
  match_count int default null,
  filter jsonb default '{}'
) returns table (id bigint, content text, metadata jsonb, similarity float)
language plpgsql
as $$
begin
  return query
  select d.id, d.content, d.metadata,
         1 - (d.embedding <=> query_embedding) as similarity
  from documents d
  where d.metadata @> filter
  order by d.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

The `filter` argument is what LangChain's `SupabaseVectorStore` passes through when you supply a metadata filter, and it's the foundation for multi-tenant isolation later on.

## Step 2: Ingestion and Chunking

Chunking has more influence on answer quality than almost any other parameter. Chunks that are too large dilute the embedding with unrelated content; chunks that are too small lose the surrounding context the LLM needs to answer.

One subtlety: `RecursiveCharacterTextSplitter` measures `chunkSize` in **characters** by default, not tokens. If you want token-based sizing to match the diagram's ~500 tokens, either use a token-aware splitter or a rough rule of thumb of about four characters per token for English text.

```typescript
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Document } from '@langchain/core/documents';

export async function ingestMarkdown(
  client: SupabaseClient,
  markdown: string,
  meta: { tenantId: string; sourceId: string; title: string }
) {
  // Markdown-aware separators: split on headings first, then paragraphs, then sentences
  const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
    chunkSize: 2000,   // ~500 tokens
    chunkOverlap: 200, // ~10% overlap
  });

  const chunks = await splitter.splitDocuments([
    new Document({ pageContent: markdown, metadata: meta }),
  ]);

  const embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });
  const vectorStore = new SupabaseVectorStore(embeddings, {
    client,
    tableName: 'documents',
    queryName: 'match_documents',
  });

  // Remove stale chunks for this source before re-indexing
  await client
    .from('documents')
    .delete()
    .eq('metadata->>sourceId', meta.sourceId)
    .eq('metadata->>tenantId', meta.tenantId);

  await vectorStore.addDocuments(chunks);
}
```

A few things that paid off in practice:

- **Clean before you split.** Strip navigation, boilerplate, repeated headers and timestamps from transcripts. Noise that gets embedded gets retrieved.
- **Carry metadata into every chunk.** Tenant ID, source ID, title and section heading all belong in `metadata`. They power filtering, citations and re-indexing.
- **Make ingestion idempotent.** Deleting a source's old chunks before inserting new ones (as above) prevents stale and duplicate content from piling up when a document is edited.
- **Batch embedding calls.** `OpenAIEmbeddings` batches inputs for you; keep ingestion in a background worker so rate limits and retries never touch the user-facing path.

## Step 3: TypeScript Query Implementation

Here's the core query function. Compared to a naive version, it types the Supabase client properly and uses the current `model` option on the LangChain OpenAI classes.

```typescript
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function queryRAG(question: string, client: SupabaseClient) {
  const embeddings = new OpenAIEmbeddings({
    model: 'text-embedding-3-small',
  });

  const vectorStore = new SupabaseVectorStore(embeddings, {
    client,
    tableName: 'documents',
    queryName: 'match_documents',
  });

  const relevantDocs = await vectorStore.similaritySearch(question, 4);
  const context = relevantDocs.map((doc) => doc.pageContent).join('\n---\n');

  const model = new ChatOpenAI({
    model: 'gpt-4o',
    temperature: 0.2,
  });

  const prompt = PromptTemplate.fromTemplate(`
    You are an expert technical advisor. Answer based ONLY on the following context:
    {context}

    Question: {question}
  `);

  const chain = prompt.pipe(model).pipe(new StringOutputParser());
  return await chain.invoke({ context, question });
}
```

### Making it production-ready

The function above works, but production traffic exposes a few gaps. Here's a version that adds tenant filtering, a relevance threshold, a fallback when nothing relevant is found, and source citations:

```typescript
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOpenAI } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';

const MIN_SIMILARITY = 0.3; // tune against your own evaluation set

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert technical advisor. Answer ONLY from the context below.
If the context does not contain the answer, say "I don't know based on the available material."
Cite sources using their [n] markers.

Context:
{context}`,
  ],
  ['human', '{question}'],
]);

export async function queryRAGForTenant(
  question: string,
  tenantId: string,
  vectorStore: SupabaseVectorStore,
  model: ChatOpenAI
) {
  const results = await vectorStore.similaritySearchWithScore(question, 6, { tenantId });
  const relevant = results.filter(([, score]) => score >= MIN_SIMILARITY);

  if (relevant.length === 0) {
    return { answer: "I don't know based on the available material.", sources: [] };
  }

  const context = relevant
    .map(([doc], i) => `[${i + 1}] ${doc.metadata.title}\n${doc.pageContent}`)
    .join('\n---\n');

  const chain = prompt.pipe(model).pipe(new StringOutputParser());
  const answer = await chain.invoke({ context, question });

  return {
    answer,
    sources: relevant.map(([doc]) => ({ title: doc.metadata.title, sourceId: doc.metadata.sourceId })),
  };
}
```

Why these changes matter:

- **The tenant filter runs inside the SQL query**, not after retrieval. Filtering after the top-K search can return zero results for a tenant even though relevant documents exist, and, worse, filtering in application code is one bug away from leaking another tenant's data into a prompt.
- **A similarity threshold plus an explicit "I don't know" path** is the single most effective guard against hallucination. Without it, the model will happily answer from loosely related chunks.
- **Returning sources** lets the UI show citations, which builds user trust and makes bad answers easy to debug.
- **Create the vector store and model once** and pass them in, rather than constructing them on every request.

For chat interfaces, swap `invoke` for `stream` on the same chain to send tokens to the client as they're generated; perceived latency drops dramatically even when total generation time doesn't.

## Retrieval Trade-offs Worth Knowing

| Decision | Option A | Option B | Notes |
| --- | --- | --- | --- |
| Top-K | Small (3–4) | Larger (8–10) | More context improves recall but costs tokens and can distract the model |
| Search | Pure vector | Hybrid (vector + keyword) | Hybrid helps with exact terms like error codes, names and IDs |
| Store | pgvector | Pinecone | pgvector keeps data with your relational model; Pinecone offloads index ops |
| Re-ranking | None | Cross-encoder / LLM re-rank | Re-ranking a larger candidate set improves precision at the cost of latency |

A typical starting point is a top-K of around four with a similarity threshold, then adding hybrid search or re-ranking only when evaluation shows retrieval is the weak link.

## Common Pitfalls

- **Mismatched embedding models.** Querying with a different model (or dimension) than you indexed with silently returns garbage. Store the embedding model name in metadata and re-index when you change it.
- **Character vs. token confusion** in chunk sizes, as noted above.
- **Prompt injection via documents.** Retrieved content is untrusted input. Keep instructions in the system message and treat context as data, not commands.
- **No evaluation set.** Without a fixed list of questions with known good answers, every tweak to chunking or prompts is guesswork. Even a few dozen hand-written Q&A pairs, re-run after every change, catch most regressions.
- **Unbounded context.** Concatenating every retrieved chunk can blow past your token budget and your cost estimates. Cap the context length explicitly.

## Best Practices

1. **Chunk Overlap**: Always preserve 10-15% chunk overlap to maintain context across boundary splits.
2. **Metadata Filtering**: Filter by tenant ID and date before similarity ranking to enforce multi-tenant isolation.
3. **Low Temperature**: Use temperatures between `0.0` and `0.3` for factual question-answering systems.
4. **Idempotent Ingestion**: Re-indexing a document should replace its chunks, never duplicate them.
5. **Grounded Refusals**: Give the model an explicit way to say "I don't know" and use a similarity threshold to trigger it.
6. **Citations**: Return the sources behind every answer.

## Key Takeaways Checklist

- [ ] Separate ingestion (background) from querying (request path).
- [ ] Match the vector column dimension to your embedding model and index it (HNSW or IVFFlat).
- [ ] Split with markdown-aware separators and ~10% overlap; know whether your sizes are characters or tokens.
- [ ] Attach tenant, source and title metadata to every chunk.
- [ ] Filter by tenant inside the database query, not after retrieval.
- [ ] Apply a similarity threshold with a graceful "I don't know" fallback.
- [ ] Keep temperature low and instructions in the system message.
- [ ] Maintain a small evaluation set and re-run it on every change.

## Conclusion

RAG is less about the LLM and more about the data pipeline in front of it. The model is only as good as the context you hand it, so most of the engineering effort goes into clean ingestion, sensible chunking, strict filtering and honest fallbacks. Get those right, and a fairly simple LangChain chain on top of pgvector can deliver accurate, grounded answers over content that changes every day, without ever fine-tuning a model.
