import { requestPath } from "./content";

export function RequestPath() {
  return (
    <div className="request-path" aria-labelledby="request-path-title">
      <div className="request-path__heading">
        <p className="eyebrow" id="request-path-title">
          Request path
        </p>
      </div>

      <ol className="request-path__list">
        {requestPath.map((node) => (
          <li
            className={`request-node request-node--${node.tone} request-node--${node.id}`}
            key={node.id}
          >
            <span className="request-node__index" aria-hidden="true">
              {node.index || "TLS"}
            </span>
            <div className="request-node__copy">
              <h2>{node.title}</h2>
              <p>{node.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
