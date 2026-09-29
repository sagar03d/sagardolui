import rss from '@astrojs/rss'
import { getCollection } from 'astro:content'
import config from '../utils/config'

export async function GET(context) {
  const posts = await getCollection('posts')
  const sortedPosts = posts.sort((a, b) => {
    const dateA = new Date(a.data.date || 0).getTime()
    const dateB = new Date(b.data.date || 0).getTime()
    return dateB - dateA
  })

  return rss({
    title: `${config.siteTitle} | RSS Feed`,
    description: config.description,
    site: context.site || config.siteUrl,
    items: sortedPosts.map((post) => {
      const slug = post.data.slug || post.slug || post.id.replace(/\.(md|mdx)$/, '')
      const cleanSlug = slug.startsWith('/') ? slug : `/${slug}`

      return {
        title: post.data.title,
        pubDate: new Date(post.data.date || Date.now()),
        description: post.data.description,
        link: `${cleanSlug}/`,
      }
    }),
    customData: `<language>en-us</language>`,
  })
}
