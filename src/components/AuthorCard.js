import React from 'react'
import { Link } from 'gatsby'

export const AuthorCard = () => {
  return (
    <aside className="author-card">
      <img src="/ram.png" alt="" width="80" height="80" />
      <p>
        Hey! I'm Sagar, Senior Full-Stack Engineer architecting scalable
        systems and exploring GenAI & cloud architectures. You can read{' '}
        <Link to="/me">more about me</Link>, explore my{' '}
        <Link to="/projects">projects</Link>, or reach out via{' '}
        <a href="mailto:sagar03d@gmail.com">email</a>.
      </p>
    </aside>
  )
}
