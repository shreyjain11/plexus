import { useEffect, useState } from "react";

/** Tracks the user's prefers-reduced-motion setting, reactively. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
