import { defineCollection, z } from 'astro:content'

const postsCollection = defineCollection({
  type: 'content',
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

const pagesCollection = defineCollection({
  type: 'content',
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
  posts: postsCollection,
  pages: pagesCollection,
}
