"use client";

import { useState } from "react";
import { type Workflow, workflows } from "./content";

export function WorkflowExplorer() {
  const [activeId, setActiveId] = useState<Workflow["id"]>("catch-up");
  const activeWorkflow =
    workflows.find(({ id }) => id === activeId) ?? workflows[0]!;

  return (
    <section
      className="workflow-explorer"
      id="workflows"
      aria-labelledby="workflows-title"
    >
      <div className="workflow-explorer__inner">
        <header className="workflow-explorer__heading">
          <p className="eyebrow">Workflows</p>
          <h2 id="workflows-title">Put your Telegram context to work</h2>
          <p>
            Explore focused workflows built from the messages, sources, and
            structure you already have.
          </p>
        </header>

        <div className="workflow-explorer__layout">
          <div
            className="workflow-explorer__tabs"
            role="tablist"
            aria-label="Example workflows"
          >
            {workflows.map((workflow) => {
              const isSelected = workflow.id === activeId;

              return (
                <button
                  key={workflow.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls="workflow-panel"
                  onClick={() => setActiveId(workflow.id)}
                >
                  {workflow.label}
                </button>
              );
            })}
          </div>

          <div
            className="workflow-explorer__panel"
            id="workflow-panel"
            role="tabpanel"
            aria-live="polite"
          >
            <p className="workflow-explorer__label">Example prompt</p>
            <h3>{activeWorkflow.title}</h3>
            <blockquote>{activeWorkflow.prompt}</blockquote>
            <div className="workflow-explorer__outcome">
              <span>Outcome</span>
              <p>{activeWorkflow.outcome}</p>
            </div>
            <ul className="workflow-explorer__tools" aria-label="Tools used">
              {activeWorkflow.tools.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          </div>
        </div>

        <noscript>
          Interaction is unavailable, so the first workflow example is shown.
        </noscript>
      </div>
    </section>
  );
}
