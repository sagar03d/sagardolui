import React, { useMemo } from 'react'
import { Link, graphql } from 'gatsby'

import Helmet from 'react-helmet'

import { Layout } from '../components/Layout'
import { Posts } from '../components/Posts'
import { Post } from '../components/Post'
import { SEO } from '../components/SEO'
import { Heading } from '../components/Heading'
import { Hero } from '../components/Hero'
import { PageLayout } from '../components/PageLayout'
import { projectsList } from '../data/projectsList'
import { shelvesList } from '../data/shelvesList'
import { seriesList } from '../data/seriesList'
import { getSimplifiedPosts, slugify } from '../utils/helpers'
import { useContentImages } from '../utils/hooks/useContentImages'
import config from '../utils/config'
import github from '../assets/nav-github.png'

export default function Index({ data }) {
  const latestPosts = data.latestPosts.edges
  const postCount = data.postCount.totalCount
  const imagesByPath = useContentImages()
  const recent = useMemo(
    () => getSimplifiedPosts(latestPosts, { thumbnails: true }),
    [latestPosts]
  )

  return (
    <>
      <Helmet title={config.siteTitle} />
      <SEO />

      <PageLayout>
        <Hero type="index">
          <div className="hero-wrapper">
            <div>
              <h1 className="flex-align-center gap">Hey, I'm Sagar!</h1>
              <p className="hero-description hero-tagline">
                Senior Full-Stack Engineer, System Architect, GenAI Builder.
              </p>
              <Heading title="Career timeline" small />
              <ul className="hero-eras">
                <li>
                  <span className="era-dates">2021&ndash;now</span>
                  <span>
                    <Link to="/resume">Senior Software Engineer</Link> at{' '}
                    <b>Bambinos Learning Solutions</b> (<i>Employee of the Year 2022</i>):
                    Scaled backend infrastructure for 60K+ monthly active users with
                    99.99% uptime. Optimized PostgreSQL indexing and query logic, cutting
                    API latency from 800ms to 320ms (60% improvement). Led migration to
                    high-availability GCP (Compute Engine & Cloud SQL), maintained &gt;90%
                    test coverage, and built real-time WebSocket analytics dashboards in React.
                  </span>
                </li>
                <li>
                  <span className="era-dates">2019&ndash;2021</span>
                  <span>
                    <b>Web Developer</b> at <b>Arobit Business Solutions</b>:
                    Engineered a multi-tenant SaaS backend supporting 300K+ users with
                    multi-domain RESTful APIs. Scaled financial operations by integrating
                    Stripe and Razorpay, processing 50L+ INR monthly with Dockerized
                    environments and NGINX load balancing.
                  </span>
                </li>
                <li>
                  <span className="era-dates">2018</span>
                  <span>
                    <b>Web Developer</b> at <b>Wishnet Pvt Ltd</b>:
                    Developed the Wishtrip hospitality booking platform for 5+ nationwide
                    properties. Reduced SLA breaches by 25% by building automated internal
                    PHP/MySQL monitoring tools.
                  </span>
                </li>
                <li>
                  <span className="era-dates">2018</span>
                  <span>
                    <b>B.C.A. in Artificial Intelligence</b>, Sainath University:
                    Graduated as <i>Best Performing Student (2018 Batch)</i>.
                  </span>
                </li>
              </ul>
              <p className="hero-description">
                <Link to="/me">Projects & Research</Link>: Creator of{' '}
                <Link to="/sessionorbit-ai-virtual-classroom">SessionOrbit</Link>{' '}
                (AI Virtual Classroom) and{' '}
                <Link to="/building-rag-pipelines-with-langchain">Blogineers</Link>{' '}
                (AI Autoblogging SaaS with LangChain RAG & Supabase).
              </p>
            </div>
            <div className="hero-image-container">
              <img src="/ram.png" className="hero-image" alt="Sagar Dolui" />
              <aside className="hero-bubble">
                📍 Bengaluru, India &bull;{' '}
                <a href="mailto:sagar03d@gmail.com">sagar03d@gmail.com</a> &bull;{' '}
                <a href="tel:+919088847921">+91-9088847921</a>
              </aside>
            </div>
          </div>
        </Hero>

        <section className="section-index">
          <Heading title="Latest" slug="/blog" buttonText="All Posts" />
          <Posts data={recent} detailed />
        </section>

        <section className="section-index">
          <Heading
            title="Shelves"
            slug="/shelves"
            buttonText="All Shelves"
            description="Hand-picked paths through systems architecture, databases, AI, and cloud."
          />
          <div className="cards cards-half">
            {shelvesList.map((shelf) => (
              <Link
                className="card card-highlight card-shelf"
                to={`/shelves#${slugify(shelf.title)}`}
                key={shelf.title}
              >
                <div className="flex-space-between">
                  <div className="card-title">{shelf.title}</div>
                  <div className="chip">
                    <span className="chip-highlight">{shelf.links.length}</span>
                  </div>
                </div>
                <p>{shelf.description}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="section-index">
          <Heading
            title="Series"
            description="In-depth engineering series and architectural case studies."
          />
          <div className="posts">
            {seriesList.map((series) => (
              <Post
                key={series.slug}
                detailed
                node={{
                  id: series.slug,
                  slug: series.slug,
                  title: series.title,
                  thumbnail: imagesByPath[series.icon],
                  description: series.description,
                }}
              />
            ))}
          </div>
        </section>

        <section>
          <Heading
            title="Projects"
            slug="/projects"
            buttonText="All Projects"
            description="Platforms and systems architected and built over 8+ years."
            icon={github}
          />

          <div className="cards">
            {projectsList
              .filter((project) => project.highlight)
              .map((project) => {
                return (
                  <div className="card" key={`hightlight-${project.slug}`}>
                    <time>{project.date}</time>
                    <a
                      href={project.url || `https://github.com/sagar03d/${project.slug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {project.name}
                    </a>
                    <p>{project.tagline}</p>
                    <div className="card-links">
                      {project.writeup && (
                        <Link to={project.writeup}>Article</Link>
                      )}
                      {project.url && (
                        <a href={project.url} target="_blank" rel="noreferrer">
                          Link
                        </a>
                      )}
                      <a
                        href={project.url || `https://github.com/sagar03d/${project.slug}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source
                      </a>
                    </div>
                  </div>
                )
              })}
          </div>
        </section>
      </PageLayout>
    </>
  )
}

Index.Layout = Layout

export const pageQuery = graphql`
  query IndexQuery {
    latestPosts: allMarkdownRemark(
      limit: 4
      sort: { frontmatter: { date: DESC } }
      filter: { frontmatter: { template: { eq: "post" } } }
    ) {
      edges {
        node {
          id
          fields {
            slug
          }
          frontmatter {
            date(formatString: "MMMM DD, YYYY")
            title
            tags
            categories
            thumbnail {
              publicURL
            }
          }
        }
      }
    }
    postCount: allMarkdownRemark(
      filter: { frontmatter: { template: { eq: "post" } } }
    ) {
      totalCount
    }
  }
`
