import { DeploymentGuide } from "./_components/landing/deployment-guide";
import { Footer } from "./_components/landing/footer";
import { Header } from "./_components/landing/header";
import { Hero } from "./_components/landing/hero";
import { TrustBoundaries } from "./_components/landing/trust-boundaries";
import { WorkflowExplorer } from "./_components/landing/workflow-explorer";

export default function HomePage() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <WorkflowExplorer />
        <TrustBoundaries />
        <DeploymentGuide />
      </main>
      <Footer />
    </>
  );
}
