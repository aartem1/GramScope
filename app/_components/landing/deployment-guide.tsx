import { deploymentSteps, OPERATIONS_URL } from "./content";

const prerequisites = [
  "Dedicated Telegram account",
  "Node.js 20+",
  "Debian or Ubuntu VPS",
  "Vercel and WorkOS AuthKit",
] as const;

export function DeploymentGuide() {
  return (
    <section
      className="deployment-guide"
      id="deploy"
      aria-labelledby="deploy-title"
    >
      <div className="section-shell deployment-guide__layout">
        <header className="section-heading deployment-guide__heading">
          <p className="eyebrow">Deployment</p>
          <h2 id="deploy-title">From repository to private relay</h2>
          <p>
            Bring the infrastructure, then follow the operations CLI through a
            repeatable setup.
          </p>

          <div className="deployment-guide__prerequisites">
            <h3>Prerequisites</h3>
            <ul>
              {prerequisites.map((prerequisite) => (
                <li key={prerequisite}>{prerequisite}</li>
              ))}
            </ul>
          </div>
        </header>

        <div>
          <ol className="deployment-steps">
            {deploymentSteps.map((step) => (
              <li key={step.index}>
                <span className="deployment-step__index" aria-hidden="true">
                  {step.index}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <a
            className="button button--secondary deployment-guide__action"
            href={OPERATIONS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Read the operations guide
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  );
}
