import { BrandMark } from "./brand-mark";
import { GITHUB_URL } from "./content";

export function Header() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href="/" aria-label="GramScope home">
          <BrandMark />
          <span>GramScope</span>
        </a>

        <nav className="site-nav" aria-label="Primary navigation">
          <a href="#workflows">Workflows</a>
          <a href="#deploy">Deploy</a>
        </nav>

        <a
          className="header-action"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </header>
  );
}
