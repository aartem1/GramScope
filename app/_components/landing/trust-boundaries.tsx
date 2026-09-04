import { trustBoundaries } from "./content";

export function TrustBoundaries() {
  return (
    <section className="trust-boundaries" aria-labelledby="trust-title">
      <div className="section-shell">
        <header className="section-heading">
          <p className="eyebrow">Trust boundaries</p>
          <h2 id="trust-title">Private by architecture</h2>
          <p>
            Every boundary is explicit, narrow, and owned by the person running
            GramScope.
          </p>
        </header>

        <div className="trust-boundaries__grid">
          {trustBoundaries.map((boundary, index) => (
            <article className="trust-card" key={boundary.title}>
              <span className="trust-card__index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{boundary.title}</h3>
              <p>{boundary.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
