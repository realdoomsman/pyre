import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Button, EmptyState } from "../ui/index.js";

export const NotFound = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = "Pyre — not found";
  }, []);
  return (
    <div className="mx-auto mt-12 max-w-md">
      <EmptyState
        variant="ash"
        title="nothing here"
        body={
          <>
            <span className="num text-ink-2">{pathname}</span> is not a page. if you followed a coin link, the coin may have been killed or never launched.
          </>
        }
        action={
          <Button variant="secondary" size="sm" href="/">
            back home
          </Button>
        }
      />
    </div>
  );
};
