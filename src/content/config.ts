import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.string().optional(),
    updated: z.string().optional(),
    slug: z.string().optional(),
    template: z.string().optional().default('post'),
    series: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    categories: z.array(z.string()).optional().default([]),
    description: z.string().optional().default(''),
    thumbnail: z.string().optional(),
    comments_off: z.boolean().optional().default(false),
    dated: z.boolean().optional().default(false),
  }),
})

const pages = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    slug: z.string().optional(),
    template: z.string().optional().default('page'),
    description: z.string().optional().default(''),
    thumbnail: z.string().optional(),
    htmlTitle: z.string().optional(),
  }),
})

export const collections = {
  posts,
  pages,
}
