import { useEffect } from "react";
import { useStats } from "../../api/queries.js";
import { useAuth } from "../../auth/useAuth.js";
import { BuildHero } from "./BuildHero.js";
import { Feed } from "./Feed.js";
import { Landing } from "./Landing.js";
import { Rail } from "./Rail.js";

/**
 * Home. The product is the hero: a live build console, then the ranked feed
 * with the live rail beside it. Signed-out visitors get the loop explained
 * below the fold; signed-in users get the feed and nothing else.
 */
export const Home = () => {
  const auth = useAuth();
  const stats = useStats();

  useEffect(() => {
    document.title = "Pyre — coins that build apps";
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Pyre — coins that build apps</h1>
      <BuildHero />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Feed />
        <div className="hidden xl:block">
          <Rail />
        </div>
      </div>
      {auth.ready && !auth.authenticated && <Landing stats={stats.data} />}
    </div>
  );
};
