import React, { useState, useEffect } from 'react'
import Helmet from 'react-helmet'
import { Link } from 'gatsby'

import { StarIcon } from '../assets/StarIcon'
import { Layout } from '../components/Layout'
import { SEO } from '../components/SEO'
import { Hero } from '../components/Hero'
import { PageLayout } from '../components/PageLayout'
import config from '../utils/config'
import { projectsList } from '../data/projectsList'
import projects from '../assets/nav-projects.png'

export default function Projects() {
  const [repos, setRepos] = useState([])
  const title = 'Projects'
  const description =
    "Platforms, SaaS backends, and AI architectures I've designed and engineered over 8+ years of professional experience."

  useEffect(() => {
    async function getStars() {
      try {
        const res = await fetch(
          'https://api.github.com/users/sagar03d/repos?per_page=100'
        )
        if (res.ok) {
          const data = await res.json()
          setRepos(Array.isArray(data) ? data : [])
        }
      } catch (err) {
        console.error(err)
      }
    }

    getStars()
  }, [])

  return (
    <>
      <Helmet title={`${title} | ${config.siteTitle}`} />
      <SEO customTitle={title} customDescription={description} />

      <PageLayout>
        <Hero title={title} description={description} icon={projects} />

        <div className="cards">
          {projectsList.map((project) => {
            const repo = repos.find((r) => r.name === project.slug)

            return (
              <div className="card" key={project.slug}>
                <div className="stars">
                  {repo && (
                    <div className="star">
                      <a
                        href={`https://github.com/sagar03d/${project.slug}/stargazers`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {Number(repo.stargazers_count).toLocaleString()}
                      </a>
                      <StarIcon />
                    </div>
                  )}
                </div>
                <time>{project.date}</time>
                <a
                  className="card-header"
                  href={project.url || `https://github.com/sagar03d/${project.slug}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {project.name}
                </a>
                <p>{project.tagline}</p>
                <div className="card-links">
                  {project.writeup && <Link to={project.writeup}>Article</Link>}
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
      </PageLayout>
    </>
  )
}

Projects.Layout = Layout
