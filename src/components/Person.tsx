import type { JSX } from "react";
import "./Person.css";

/**
 * A neighbour's name with its trust level made explicit:
 * - verified account → "Mike ✓" (screen readers hear "Mike, verified account")
 * - seeded demo neighbour → "Olive Finch" + a "sim" badge
 * - guest (device-scoped name, no account) → "Mike (guest)"
 *
 * Anyone can TYPE "Mike" as a guest name; only an account can carry the ✓. That distinction is
 * what lets an organizer tell the real Mike from someone using his name.
 */
export function PersonName({
  handle,
  verified,
  isSeed = false,
  you = false,
}: {
  handle: string;
  verified: boolean;
  isSeed?: boolean;
  you?: boolean;
}): JSX.Element {
  return (
    <span className="person">
      <span className="person__name">{handle}</span>
      {verified ? (
        <span className="person__verified" title="Verified account">
          <span aria-hidden="true">✓</span>
          <span className="sr-only">, verified account</span>
        </span>
      ) : isSeed ? (
        <span className="badge badge--sim">sim</span>
      ) : (
        <span className="person__guest">(guest)</span>
      )}
      {you ? <span className="person__you">(you)</span> : null}
    </span>
  );
}
