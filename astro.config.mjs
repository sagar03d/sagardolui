import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

const site = 'https://sagardolui.com'

// Map each blog post URL to its frontmatter date so the sitemap can report lastmod
const postDates = new Map()
const postsDir = './content/posts'
for (const file of existsSync(postsDir) ? readdirSync(postsDir) : []) {
  if (!file.endsWith('.md')) continue
  const source = readFileSync(`${postsDir}/${file}`, 'utf8')
  const slug = source.match(/^slug:\s*['"]?([^'"\n]+)['"]?/m)?.[1]
  const date = source.match(/^date:\s*['"]?([^'"\n]+)['"]?/m)?.[1]
  if (slug && date) postDates.set(`${site}/${slug}/`, new Date(date).toISOString())
}

export default defineConfig({
  site,
  integrations: [
    sitemap({
      serialize(item) {
        const lastmod = postDates.get(item.url)
        if (lastmod) {
          item.lastmod = lastmod
          item.changefreq = 'monthly'
          item.priority = 0.8
        } else if (item.url === `${site}/` || item.url === `${site}/blog/`) {
          item.changefreq = 'weekly'
          item.priority = 1.0
        }
        return item
      },
    }),
  ],
  markdown: {
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: true,
    },
  },
})
