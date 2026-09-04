export const GITHUB_URL = "https://github.com/aartem1/GramScope";
export const OPERATIONS_URL = `${GITHUB_URL}/blob/main/docs/operations.md`;

export type RequestNode = {
  id: "client" | "vercel" | "boundary" | "worker" | "telegram";
  index: string;
  title: string;
  detail: string;
  tone: "cyan" | "violet" | "mint";
};

export type Workflow = {
  id: "catch-up" | "research" | "discover" | "organize" | "media";
  label: string;
  title: string;
  prompt: string;
  outcome: string;
  tools: readonly string[];
};

export type Fact = { title: string; body: string };
export type DeploymentStep = Fact & { index: string };

export const requestPath = [
  {
    id: "client",
    index: "01",
    title: "Any compatible AI client",
    detail: "Tested with ChatGPT and Grok Bot.",
    tone: "cyan",
  },
  {
    id: "vercel",
    index: "02",
    title: "Vercel app",
    detail: "OAuth, MCP schemas, and short-lived media links.",
    tone: "violet",
  },
  {
    id: "boundary",
    index: "",
    title: "Private boundary",
    detail: "Mutual TLS carries bounded operations to your server.",
    tone: "mint",
  },
  {
    id: "worker",
    index: "03",
    title: "Your VPS worker",
    detail: "The only process that holds the Telegram session.",
    tone: "mint",
  },
  {
    id: "telegram",
    index: "04",
    title: "Telegram",
    detail:
      "Messages, folders, memberships, and read state remain the source of truth.",
    tone: "cyan",
  },
] as const satisfies readonly RequestNode[];

export const workflows = [
  {
    id: "catch-up",
    label: "Catch up",
    title: "Turn unread channels into a focused briefing.",
    prompt:
      "Catch me up on unread posts from my Research folder. Prioritize recurring themes and link every conclusion to its source.",
    outcome: "A bounded summary built from your current Telegram read state.",
    tools: ["get_unread_summary", "get_messages"],
  },
  {
    id: "research",
    label: "Research",
    title: "Search across the sources you already trust.",
    prompt:
      "Find recent discussions of local AI models across my joined channels and compare the strongest claims.",
    outcome: "Search results with enough surrounding context to verify the synthesis.",
    tools: ["search_messages", "get_messages"],
  },
  {
    id: "discover",
    label: "Discover",
    title: "Find useful public sources without leaving the conversation.",
    prompt:
      "Find public channels about practical home automation, then show related sources for the two most relevant results.",
    outcome: "Telegram-native discovery results that you choose whether to join.",
    tools: ["search_channels", "get_similar_channels"],
  },
  {
    id: "organize",
    label: "Organize",
    title: "Keep Telegram folders aligned with how you work.",
    prompt:
      "Show my folders, then move the sources I approve into a new Robotics folder.",
    outcome: "Explicit, bounded folder changes after you select the sources.",
    tools: ["list_folders", "manage_folder"],
  },
  {
    id: "media",
    label: "Media",
    title: "Inspect media attached to a message on demand.",
    prompt:
      "Open the image attached to the selected post so we can discuss the chart it contains.",
    outcome: "One bounded representation or short-lived link for the chosen message.",
    tools: ["get_media"],
  },
] as const satisfies readonly Workflow[];

export const trustBoundaries = [
  {
    title: "Owner-scoped OAuth",
    body: "Tokens must match the configured issuer, audience, and owner identity.",
  },
  {
    title: "Bounded operations",
    body: "The worker accepts a fixed domain operation set rather than raw Telegram requests.",
  },
  {
    title: "Untrusted source content",
    body: "Telegram content is treated as material to analyze, never as instruction or verified evidence.",
  },
] as const satisfies readonly Fact[];

export const deploymentSteps = [
  {
    index: "01",
    title: "Prepare",
    body: "Bring a dedicated Telegram account, API credentials, Node.js 20+, a Debian or Ubuntu VPS, Vercel, and WorkOS AuthKit.",
  },
  {
    index: "02",
    title: "Clone",
    body: "Clone GramScope and configure the gramscope-worker SSH alias used by its operations CLI.",
  },
  {
    index: "03",
    title: "Install",
    body: "Use ./scripts/gramscope for setup and complete the interactive Telegram login on the VPS.",
  },
  {
    index: "04",
    title: "Connect",
    body: "Point a compatible AI client at your deployed MCP endpoint and authorize with OAuth.",
  },
] as const satisfies readonly DeploymentStep[];
