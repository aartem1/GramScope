import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

describe("landing page", () => {
  it("renders the product promise, explicit actions, and request path", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain("Your Telegram. Inside your AI.");
    expect(html).toContain("View on GitHub");
    expect(html).toContain("Deployment guide");
    expect(html).toContain("Any compatible AI client");
    expect(html).toContain("Your VPS worker");
    expect(html).toContain("href=\"#deploy\"");
    expect(html).toContain(
      "href=\"https://github.com/aartem1/GramScope\"",
    );
  });

  it("server-renders a useful default workflow and all workflow controls", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain("id=\"workflows\"");
    expect(html).toContain("Catch up");
    expect(html).toContain("Research");
    expect(html).toContain("Discover");
    expect(html).toContain("Organize");
    expect(html).toContain("Media");
    expect(html).toContain("get_unread_summary");
    expect(html).toContain("role=\"tablist\"");
  });

  it("renders each remaining fact and destination once", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain("Owner-scoped OAuth");
    expect(html).toContain("Bounded operations");
    expect(html).toContain("Untrusted source content");
    expect(html).toContain("id=\"deploy\"");
    expect(html).toContain("Prepare");
    expect(html).toContain("Clone");
    expect(html).toContain("Install");
    expect(html).toContain("Connect");
    expect(html).toContain(
      "href=\"https://github.com/aartem1/GramScope/blob/main/docs/operations.md\"",
    );
    expect(
      html.match(/The only process that holds the Telegram session\./g),
    ).toHaveLength(1);
  });
});
