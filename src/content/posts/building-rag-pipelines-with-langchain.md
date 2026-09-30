---
template: 'post'
title: 'Building Production RAG Pipelines with Node.js, LangChain & OpenAI'
date: '2023-09-05'
slug: 'building-rag-pipelines-with-langchain'
series: 'Production GenAI & RAG Pipelines'
tags: ['genai', 'rag', 'openai', 'node', 'langchain']
categories: ['Engineering', 'GenAI']
description: 'Step-by-step architecture for building an automated AI content pipeline using retrieval-augmented generation (RAG) in TypeScript.'
thumbnail: '../thumbnails/ai.svg'
---

Retrieval-Augmented Generation (RAG) allows Large Language Models (LLMs) to answer queries using dynamic, domain-specific private data without costly fine-tuning.

In building **Blogineers** and AI classroom capabilities for **SessionOrbit**, we engineered high-accuracy RAG workflows capable of ingesting raw markdown and documents, vectorizing them, and synthesizing accurate answers.

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

## TypeScript Implementation

```typescript
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';

export async function queryRAG(question: string, client: any) {
  const embeddings = new OpenAIEmbeddings({
    modelName: 'text-embedding-3-small',
  });

  const vectorStore = new SupabaseVectorStore(embeddings, {
    client,
    tableName: 'documents',
    queryName: 'match_documents',
  });

  const relevantDocs = await vectorStore.similaritySearch(question, 4);
  const context = relevantDocs.map((doc) => doc.pageContent).join('\n---\n');

  const model = new ChatOpenAI({
    modelName: 'gpt-4o',
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

## Best Practices
1. **Chunk Overlap**: Always preserve 10-15% chunk overlap to maintain context across boundary splits.
2. **Metadata Filtering**: Filter by tenant ID and date before similarity ranking to enforce multi-tenant isolation.
3. **Low Temperature**: Use temperatures between `0.0` and `0.3` for factual question-answering systems.
