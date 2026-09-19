import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { inviteLink, setCommunityId, useCommunityId, useScopeArgs } from "../community";
import type { Route } from "../util";

function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { message?: unknown } } | null)?.data;
  return typeof data?.message === "string" ? data.message : fallback;
}

/**
 * Which community's space you're in, the switcher between them, invite-link handling, and — for
 * organizers — creating a community and copying its invite link.
 */
export default function CommunityBar(props: {
  deviceKey: string;
  route: Route;
  navigate: (to: string) => void;
  identityReady: boolean;
}) {
  const { deviceKey, route, navigate, identityReady } = props;
  const communityId = useCommunityId();
  const scopeArgs = useScopeArgs();
  const { isAuthenticated } = useConvexAuth();
  const mine = useQuery(api.communities.mine, { deviceKey });
  const current = useQuery(api.communities.get, scopeArgs);
  const join = useMutation(api.communities.join);
  const create = useMutation(api.communities.create);

  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const joinedRef = useRef<string | null>(null);

  // #/c/<id>: a direct link to a community's board.
  useEffect(() => {
    if (route.name !== "community") return;
    setCommunityId(route.communityId);
    navigate("/");
  }, [route, navigate]);

  // #/join/<code>: the invite link. Works for guests; waits for the identity upsert.
  useEffect(() => {
    if (route.name !== "join" || !identityReady) return;
    if (joinedRef.current === route.code) return;
    joinedRef.current = route.code;
    join({ deviceKey, joinCode: route.code })
      .then((res) => {
        setCommunityId(res.communityId);
        setStatus(`You joined ${res.name}. Pick a shift below.`);
        navigate("/");
      })
      .catch((err) => {
        setStatus(errorMessage(err, "That invite link didn't work."));
        navigate("/");
      });
  }, [route, identityReady, join, deviceKey, navigate]);

  // A stale remembered id (deleted community) falls back to the demo.
  useEffect(() => {
    if (communityId && current === null) setCommunityId(undefined);
  }, [communityId, current]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await create({ name, description: "" });
      setCommunityId(res.communityId);
      setCreating(false);
      setName("");
      setStatus("Community created. Copy the invite link and share it with your members.");
    } catch (err) {
      setStatus(errorMessage(err, "Could not create the community."));
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this invite link:", inviteLink(code));
    }
  };

  return (
    <section className="community-bar" aria-label="Community">
      <div className="community-bar__inner">
        <label className="community-bar__pick">
          <span className="muted">Community</span>
          <select
            value={current?._id ?? ""}
            onChange={(e) => {
              const picked = mine?.find((c) => c._id === e.target.value);
              setCommunityId(picked && !picked.isPublic ? picked._id : undefined);
            }}
          >
            {(mine ?? []).map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
                {c.isOrganizer ? " (yours)" : ""}
              </option>
            ))}
            {current && !mine?.some((c) => c._id === current._id) ? (
              <option value={current._id}>{current.name}</option>
            ) : null}
          </select>
        </label>

        {current?.isOrganizer && current.joinCode ? (
          <span className="row">
            <code className="community-bar__link">{inviteLink(current.joinCode)}</code>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void copy(current.joinCode!)}
            >
              {copied ? "Copied" : "Copy invite link"}
            </button>
            <span className="muted">
              {current.memberCount} {current.memberCount === 1 ? "member" : "members"}
            </span>
          </span>
        ) : null}

        {isAuthenticated ? (
          creating ? (
            <form className="row" onSubmit={onCreate}>
              <label className="sr-only" htmlFor="new-community-name">
                Community name
              </label>
              <input
                id="new-community-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Elm Street Mutual Aid"
                minLength={3}
                maxLength={60}
                required
              />
              <button type="submit" className="btn btn--primary btn--sm">
                Create
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(true)}>
              New community
            </button>
          )
        ) : null}
      </div>

      {current && !current.canView ? (
        <p className="community-bar__note" role="status">
          {current.name} is a private community. Ask its organizer for the invite link to see and join
          its shifts.
        </p>
      ) : null}
      {status ? (
        <p className="community-bar__note" role="status">
          {status}{" "}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStatus(null)}>
            Dismiss
          </button>
        </p>
      ) : null}
    </section>
  );
}
