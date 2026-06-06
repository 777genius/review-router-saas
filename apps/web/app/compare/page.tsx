import type { Metadata } from "next";
import { CompareSection } from "../compare-section";
import { createPublicPageMetadata } from "../seo";

export const metadata: Metadata = createPublicPageMetadata({
  title: "ReviewRouter vs AI code review apps",
  description:
    "Compare ReviewRouter with CodeRabbit, Qodo Merge, Greptile, GitHub Copilot Code Review, Cursor BugBot, Claude Code Review, Graphite Agent, and hosted AI code review models.",
  path: "/compare",
});

export default function ComparePage(): React.ReactElement {
  return (
    <main className="home-shell flex min-h-screen w-full flex-col overflow-hidden py-8 md:py-10">
      <CompareSection headingLevel={1} />
    </main>
  );
}
