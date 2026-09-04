import { BrandMark } from "./brand-mark";
import { GITHUB_URL } from "./content";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__panel">
          <div>
            <p className="eyebrow">Open source</p>
            <h2>Bring Telegram context into your AI.</h2>
          </div>

          <a
            className="button button--primary"
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
          >
            View the source on GitHub
            <span aria-hidden="true">↗</span>
          </a>
        </div>

        <div className="site-footer__meta">
          <a className="brand" href="/" aria-label="GramScope home">
            <BrandMark />
            <span>GramScope</span>
          </a>
          <p>© {new Date().getFullYear()} GramScope. Open source software.</p>
        </div>
      </div>
    </footer>
  );
}
