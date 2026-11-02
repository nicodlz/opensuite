import { useEffect, useState } from "react";

/** Width below which the sidebar becomes a drawer; matches shell.css. */
export const drawerQuery = "(max-width: 900px)";

/**
 * A phone, held either way: narrow, or short in landscape. Full-screen
 * windows replace floating ones there; matches the CSS of each product.
 */
export const phoneQuery = "(max-width: 700px), (max-height: 500px)";

/** Whether `query` matches, kept up to date as the window changes. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
