import { topicNames } from '../data/topicNames'

export function normalizeThumbnail(thumbnail) {
  if (!thumbnail) return null
  if (thumbnail.startsWith('http')) return thumbnail
  const cleaned = thumbnail.replace(/^(\.\.\/)+/, '').replace(/^thumbnails\//, '')
  return `/thumbnails/${cleaned}`
}

export function getPostSlug(entry) {
  if (entry.data?.slug) {
    return entry.data.slug.startsWith('/') ? entry.data.slug : `/${entry.data.slug}`
  }
  const cleanId = entry.slug || entry.id.replace(/\.(md|mdx)$/, '')
  return cleanId.startsWith('/') ? cleanId : `/${cleanId}`
}

export function getSimplifiedPosts(posts = [], options = {}) {
  return posts.map((post) => {
    const data = post.data || post
    const slug = getPostSlug(post)
    const thumbnail = normalizeThumbnail(data.thumbnail)

    return {
      id: post.id || slug,
      slug,
      title: data.title,
      date: data.date,
      updated: data.updated,
      tags: data.tags || [],
      categories: data.categories || [],
      series: data.series,
      description: data.description || '',
      thumbnail: options.thumbnails ? thumbnail : thumbnail,
    }
  })
}

export function slugify(string) {
  return (
    string &&
    `${string}`
      .match(
        /[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g
      )
      .map((x) => x.toLowerCase())
      .join('-')
  )
}

export function capitalize(string) {
  if (!string) return ''
  return string.charAt(0).toUpperCase() + string.slice(1)
}

export function formatTopic(tag) {
  return topicNames[tag] ?? tag
}

export function getFormattedDate(dateStr, option = 2) {
  if (!dateStr) return ''
  const dateObj = new Date(dateStr)
  if (isNaN(dateObj.getTime())) return dateStr

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ]
  const month = months[dateObj.getUTCMonth()]
  const day = dateObj.getUTCDate()
  const year = dateObj.getUTCFullYear()

  if (option === 1) {
    return `${month} ${day}`
  }

  return `${month} ${day}, ${year}`
}

export function isNewPost(dateStr) {
  if (!dateStr) return false
  const postDate = new Date(dateStr)
  const today = new Date()
  const diffTime = Math.abs(today - postDate)
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

  return diffDays < 90
}
