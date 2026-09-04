import { GITHUB_URL } from "./content";
import { RequestPath } from "./request-path";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__glow" aria-hidden="true" />
      <div className="hero__inner">
        <div className="hero__copy">
          <p className="eyebrow">
            <span aria-hidden="true" />
            Self-hosted · Open source
          </p>
          <h1 id="hero-title">Your Telegram. Inside your AI.</h1>
          <p className="hero__lead">
            A private MCP bridge that lets compatible AI clients read, research
            and organize Telegram — without handing your session to a hosted
            service.
          </p>
          <div className="hero__actions">
            <a
              className="button button--primary"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub
              <span aria-hidden="true">↗</span>
            </a>
            <a className="button button--secondary" href="#deploy">
              Deployment guide
              <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>

        <RequestPath />
      </div>
    </section>
  );
}
