import { getCommunityId } from "../community";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, FormEvent, JSX, KeyboardEvent, RefObject } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import Countdown from "./Countdown";
import { PersonName } from "./Person";
import { absoluteWindow, isoAttr, relativeStart, routeHref } from "../util";
import "./Organize.css";

type MyProjects = FunctionReturnType<typeof api.organize.myProjects>;
type MyProject = MyProjects[number];
type OrgShift = MyProject["shifts"][number];

type OrganizeProps = {
  deviceKey: string;
  now: number;
  announce: (msg: string) => void;
  onOpenAccount: () => void;
  onOpenShift: (shiftId: string) => void;
};

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW_FWD_MS = 7 * DAY;
const MAX_SHIFT_MS = 12 * HOUR;
const MIN_OPEN_LEAD_MS = MIN;
const MAX_PROJECTS = 10;
const SKILL_RE = /^[a-z-]{1,16}$/;
const SKILL_SUGGESTIONS = ["outdoors", "indoors", "repair", "build", "care", "trail"];

/* ------------------------------------------------------------------ helpers -- */

/** Server errors are ConvexError with data.message already written as human copy. */
function errorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return fallback;
}

/** Mirrors the server's whitespace normalisation so client limits match server limits. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map(clean)
    .filter((x) => x.length > 0);
}

function lengthError(value: string, label: string, min: number, max: number): string | undefined {
  if (value.length < min) {
    return min === 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`;
  }
  if (value.length > max) return `${label} can be at most ${max} characters.`;
  return undefined;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local calendar date for <input type="date">. */
function toDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local wall-clock time for <input type="time">. */
function toTimeInput(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** LOCAL date + time → epoch ms, or null when either part is missing/invalid. */
function fromLocal(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})/.exec(time);
  if (!dm || !tm) return null;
  const ts = new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    0,
    0,
  ).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Sat 9:00 AM" */
function formatDayClock(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fieldsNeedAttention(n: number): string {
  return n === 1 ? "1 field needs attention." : `${n} fields need attention.`;
}

function withoutKey<K extends string>(
  obj: Partial<Record<K, string>>,
  key: K,
): Partial<Record<K, string>> {
  const next = { ...obj };
  delete next[key];
  return next;
}

type A11yProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

/** Label + hint + error wiring for one control. The error is tied via aria-describedby. */
function Field(props: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: (a11y: A11yProps) => JSX.Element;
}): JSX.Element {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errId = props.error ? `${props.id}-err` : undefined;
  const describedBy = [errId, hintId].filter((x): x is string => Boolean(x)).join(" ");
  return (
    <div className="org-field">
      <label htmlFor={props.id} className="org-label">
        {props.label}
        {props.optional ? <span className="org-optional"> (optional)</span> : null}
      </label>
      {props.hint ? (
        <p id={hintId} className="org-hint">
          {props.hint}
        </p>
      ) : null}
      {props.children({
        id: props.id,
        "aria-describedby": describedBy.length > 0 ? describedBy : undefined,
        "aria-invalid": props.error ? true : undefined,
      })}
      {props.error ? (
        <p id={errId} className="org-error">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- root -- */

export default function Organize(props: OrganizeProps): JSX.Element {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return (
    <main className="org" aria-labelledby="org-title">
      <header className="org__intro">
        <h2 id="org-title" className="org__title">
          Organize shifts
        </h2>
        <p className="muted">
          Post a project, schedule its shifts, and see exactly who took each spot.
        </p>
      </header>
      {isLoading ? (
        <p className="notice" aria-busy="true">
          Checking your account…
        </p>
      ) : isAuthenticated ? (
        <OrganizerDesk {...props} />
      ) : (
        <SignedOut onOpenAccount={props.onOpenAccount} />
      )}
    </main>
  );
}

function SignedOut(props: { onOpenAccount: () => void }): JSX.Element {
  return (
    <section className="card org-gate" aria-labelledby="org-gate-title">
      <h3 id="org-gate-title" className="org-gate__title">
        Organizers need an account
      </h3>
      <p>
        Posting shifts needs a username so neighbours can trust who posted them — your name shows
        with a verified ✓.
      </p>
      <p className="muted">Browsing, claiming a spot and “Notify me” never need one.</p>
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={props.onOpenAccount}>
          Sign in or create an account
        </button>
        <a className="btn btn--secondary" href={routeHref("/")}>
          Back to board
        </a>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- organizer desk -- */

function OrganizerDesk(props: OrganizeProps): JSX.Element {
  const projects = useQuery(api.organize.myProjects, {});
  const me = useQuery(api.volunteers.me, { deviceKey: props.deviceKey });
  const [postProjectId, setPostProjectId] = useState<string>("");
  const postHeadingRef = useRef<HTMLHeadingElement>(null);
  const projectTitleRef = useRef<HTMLInputElement>(null);

  const goPostShift = useCallback((projectId: string) => {
    setPostProjectId(projectId);
    postHeadingRef.current?.focus();
  }, []);

  return (
    <>
      <p className="org__as">
        {me === undefined ? (
          <span className="muted">Loading your name…</span>
        ) : me === null ? null : (
          <>
            Posting as <PersonName handle={me.handle} verified={me.verified} />
            {me.username ? <span className="muted"> · username {me.username}</span> : null}
          </>
        )}
      </p>

      <div className="org__grid">
        <section className="org__projects stack" aria-labelledby="org-projects-title">
          <h3 id="org-projects-title" className="org__section-title">
            Your projects
          </h3>
          {projects === undefined ? (
            <p className="notice" aria-busy="true">
              Loading your projects…
            </p>
          ) : projects.length === 0 ? (
            <div className="card org-empty">
              <p>You have no projects yet. A project groups shifts under one organization.</p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => projectTitleRef.current?.focus()}
              >
                Start a project
              </button>
            </div>
          ) : (
            <ul className="org-project-list">
              {projects.map((project) => (
                <li key={project._id}>
                  <ProjectCard
                    project={project}
                    now={props.now}
                    announce={props.announce}
                    onOpenShift={props.onOpenShift}
                    onPostHere={goPostShift}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="org__forms stack">
          <NewProjectForm
            announce={props.announce}
            count={projects?.length ?? 0}
            titleRef={projectTitleRef}
            onCreated={goPostShift}
          />
          <PostShiftForm
            projects={projects}
            selected={postProjectId}
            onSelect={setPostProjectId}
            headingRef={postHeadingRef}
            now={props.now}
            announce={props.announce}
            onOpenShift={props.onOpenShift}
          />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ project card -- */

function ProjectCard(props: {
  project: MyProject;
  now: number;
  announce: (msg: string) => void;
  onOpenShift: (shiftId: string) => void;
  onPostHere: (projectId: string) => void;
}): JSX.Element {
  const { project } = props;
  const titleId = `org-project-${project._id}`;
  const style = { "--org-accent": `var(--accent-${project.accentIndex % 6})` } as CSSProperties;
  return (
    <article className="card org-project" style={style} aria-labelledby={titleId}>
      <header className="org-project__head">
        <div className="org-project__text">
          <h4 id={titleId} className="org-project__title">
            {project.title}
          </h4>
          <p className="muted">
            {project.orgName} · {project.locationLabel}
          </p>
          {project.summary ? <p>{project.summary}</p> : null}
          {project.tags.length > 0 ? (
            <ul className="row" aria-label="Tags">
              {project.tags.map((t) => (
                <li key={t} className="badge">
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => props.onPostHere(project._id)}
        >
          Post a shift here<span className="sr-only"> ({project.title})</span>
        </button>
      </header>

      {project.shifts.length === 0 ? (
        <p className="muted">No shifts in the next 7 days yet.</p>
      ) : (
        <ol className="org-shifts" aria-label={`Shifts for ${project.title}`}>
          {project.shifts.map((shift) => (
            <li key={shift._id}>
              <ShiftItem
                shift={shift}
                now={props.now}
                announce={props.announce}
                onOpenShift={props.onOpenShift}
              />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/* -------------------------------------------------------------- shift item -- */

function ShiftItem(props: {
  shift: OrgShift;
  now: number;
  announce: (msg: string) => void;
  onOpenShift: (shiftId: string) => void;
}): JSX.Element {
  const { shift } = props;
  const openNow = useMutation(api.organize.openNow);
  const cancelShift = useMutation(api.organize.cancelShift);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "open" | "cancel">(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const rosterId = `${uid}-roster`;
  const waitId = `${uid}-wait`;
  const panelId = `${uid}-confirm`;
  const panelTextId = `${uid}-confirm-text`;

  const scheduled = shift.status === "scheduled";
  const cancelled = shift.status === "cancelled";
  const full = shift.status === "open" && shift.filledCount >= shift.capacity;
  const statusLabel = cancelled ? "Cancelled" : scheduled ? "Scheduled" : full ? "Full" : "Open";
  const statusClass = cancelled
    ? "org-badge--cancelled"
    : scheduled
      ? "org-badge--scheduled"
      : full
        ? "badge--full"
        : "org-badge--open";

  useEffect(() => {
    if (confirming) confirmBtnRef.current?.focus();
  }, [confirming]);

  // Positions are 0-based on the server; organizers read "Spot 1".
  const byPosition = new Map(shift.roster.map((r) => [r.position, r]));
  const spotCount = Math.max(shift.capacity, ...shift.roster.map((r) => r.position + 1));
  const spots = Array.from({ length: spotCount }, (_, i) => ({ n: i + 1, who: byPosition.get(i) }));

  const doOpenNow = async () => {
    if (busy !== null) return;
    setBusy("open");
    setError(null);
    try {
      await openNow({ shiftId: shift._id });
      props.announce(`${shift.title} is open for claims now.`);
      headingRef.current?.focus();
    } catch (err) {
      const msg = errorMessage(err, "Could not open that shift. Try again.");
      setError(msg);
      props.announce(msg);
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async () => {
    if (busy !== null) return;
    setBusy("cancel");
    setError(null);
    try {
      await cancelShift({ shiftId: shift._id });
      setConfirming(false);
      props.announce(`Cancelled ${shift.title}.`);
      headingRef.current?.focus();
    } catch (err) {
      const msg = errorMessage(err, "Could not cancel that shift. Try again.");
      setError(msg);
      props.announce(msg);
    } finally {
      setBusy(null);
    }
  };

  const keep = () => {
    setConfirming(false);
    cancelBtnRef.current?.focus();
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      keep();
    }
  };

  return (
    <article
      className={`org-shift${cancelled ? " org-shift--cancelled" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="org-shift__head">
        <h5 id={titleId} ref={headingRef} tabIndex={-1} className="org-shift__title">
          {shift.title}
        </h5>
        <span className={`badge ${statusClass}`}>{statusLabel}</span>
      </div>

      <p className="org-shift__meta">
        <span>{shift.role}</span>
        <time dateTime={isoAttr(shift.startsAt)}>{absoluteWindow(shift.startsAt, shift.endsAt)}</time>
        <span>{relativeStart(shift.startsAt, shift.endsAt, props.now)}</span>
      </p>

      {scheduled && shift.opensAt !== null ? (
        <p className="org-shift__timer">
          <span className="badge org-badge--scheduled">
            <Countdown to={shift.opensAt} label="Opens in" />
          </span>
          <span>
            Opens <time dateTime={isoAttr(shift.opensAt)}>{formatDayClock(shift.opensAt)}</time>
          </span>
          <span className="tnum">
            {plural(shift.interestCount, "neighbour", "neighbours")} waiting
          </span>
        </p>
      ) : null}

      <p className="org-shift__fill tnum">
        <strong>
          {shift.filledCount} of {shift.capacity}
        </strong>{" "}
        filled
        {shift.waitlistCount > 0 ? ` · ${shift.waitlistCount} on the waitlist` : ""}
      </p>

      <div className="org-roster">
        <h6 id={rosterId} className="org-roster__title">
          Who took each spot
        </h6>
        <ol className="roster" aria-labelledby={rosterId}>
          {spots.map(({ n, who }) => (
            <li key={n} className={`roster__row${who ? "" : " roster__row--open"}`}>
              <span className="org-spot__n tnum">Spot {n}</span>
              <span aria-hidden="true">—</span>
              {who ? <PersonName handle={who.handle} verified={who.verified} /> : <span>open</span>}
            </li>
          ))}
        </ol>
        {shift.waitlist.length > 0 ? (
          <>
            <h6 id={waitId} className="org-roster__title">
              Waitlist
            </h6>
            <ol className="roster" aria-labelledby={waitId}>
              {shift.waitlist.map((w) => (
                <li key={w.rank} className="roster__row">
                  <span className="org-spot__n tnum">#{w.rank}</span>
                  <span aria-hidden="true">—</span>
                  <PersonName handle={w.handle} verified={w.verified} />
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>

      <div className="row org-shift__actions">
        {scheduled ? (
          <button
            type="button"
            className="btn btn--primary"
            aria-disabled={busy !== null ? true : undefined}
            onClick={doOpenNow}
          >
            {busy === "open" ? "Opening…" : "Open now"}
            <span className="sr-only">: {shift.title}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => props.onOpenShift(shift._id)}
        >
          View on board<span className="sr-only">: {shift.title}</span>
        </button>
        {cancelled ? null : (
          <button
            ref={cancelBtnRef}
            type="button"
            className="btn btn--danger"
            aria-expanded={confirming}
            aria-controls={confirming ? panelId : undefined}
            onClick={() => setConfirming((c) => !c)}
          >
            Cancel shift<span className="sr-only">: {shift.title}</span>
          </button>
        )}
      </div>

      {confirming && !cancelled ? (
        <div
          id={panelId}
          className="notice notice--warn"
          role="group"
          aria-labelledby={panelTextId}
          onKeyDown={onPanelKey}
        >
          <p id={panelTextId}>
            Cancel “{shift.title}”?{" "}
            {shift.filledCount > 0
              ? `${plural(shift.filledCount, "person", "people")} who claimed will see it as cancelled.`
              : "Nobody has claimed it yet."}{" "}
            This can’t be undone.
          </p>
          <div className="row">
            <button
              ref={confirmBtnRef}
              type="button"
              className="btn btn--danger"
              aria-disabled={busy !== null ? true : undefined}
              onClick={doCancel}
            >
              {busy === "cancel" ? "Cancelling…" : "Yes, cancel shift"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={keep}>
              Keep shift
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="org-error">{error}</p> : null}
    </article>
  );
}

/* --------------------------------------------------------- new project form -- */

type ProjectField = "title" | "orgName" | "locationLabel" | "summary" | "tags";
const PROJECT_FIELDS: ProjectField[] = ["title", "orgName", "locationLabel", "summary", "tags"];
type ProjectDraft = Record<ProjectField, string>;
const EMPTY_PROJECT: ProjectDraft = {
  title: "",
  orgName: "",
  locationLabel: "",
  summary: "",
  tags: "",
};

type ProjectInput = {
  title: string;
  orgName: string;
  locationLabel: string;
  summary: string;
  tags: string[];
};

function validateProject(d: ProjectDraft): {
  errors: Partial<Record<ProjectField, string>>;
  value: ProjectInput | null;
} {
  const title = clean(d.title);
  const orgName = clean(d.orgName);
  const locationLabel = clean(d.locationLabel);
  const summary = clean(d.summary);
  const tags = splitList(d.tags).map((t) => t.toLowerCase());
  const errors: Partial<Record<ProjectField, string>> = {};
  const eTitle = lengthError(title, "Project title", 3, 60);
  if (eTitle) errors.title = eTitle;
  const eOrg = lengthError(orgName, "Organization", 1, 60);
  if (eOrg) errors.orgName = eOrg;
  const eLoc = lengthError(locationLabel, "Location", 1, 80);
  if (eLoc) errors.locationLabel = eLoc;
  if (summary.length > 280) errors.summary = "Summary can be at most 280 characters.";
  if (tags.length > 5) errors.tags = "Use at most 5 tags.";
  else if (tags.some((t) => t.length > 20)) errors.tags = "Each tag can be at most 20 characters.";
  const ok = Object.keys(errors).length === 0;
  return { errors, value: ok ? { title, orgName, locationLabel, summary, tags } : null };
}

function NewProjectForm(props: {
  announce: (msg: string) => void;
  count: number;
  titleRef: RefObject<HTMLInputElement | null>;
  onCreated: (projectId: string) => void;
}): JSX.Element {
  const create = useMutation(api.organize.createProject);
  const uid = useId();
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_PROJECT);
  const [errors, setErrors] = useState<Partial<Record<ProjectField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<Partial<Record<ProjectField, HTMLInputElement | HTMLTextAreaElement | null>>>(
    {},
  );
  const headingId = `${uid}-heading`;
  const formErrId = `${uid}-form-err`;
  const limitId = `${uid}-limit`;
  const id = (f: ProjectField) => `${uid}-${f}`;
  const atLimit = props.count >= MAX_PROJECTS;

  const set = (f: ProjectField, value: string) => {
    setDraft((d) => ({ ...d, [f]: value }));
    if (errors[f]) setErrors((e) => withoutKey(e, f));
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (atLimit) {
      props.announce(`You already organize ${MAX_PROJECTS} projects, which is the limit.`);
      return;
    }
    setFormError(null);
    const { errors: found, value } = validateProject(draft);
    setErrors(found);
    const invalid = PROJECT_FIELDS.filter((f) => found[f]);
    if (invalid.length > 0 || value === null) {
      if (invalid.length > 0) refs.current[invalid[0]]?.focus();
      props.announce(fieldsNeedAttention(Math.max(1, invalid.length)));
      return;
    }
    setBusy(true);
    try {
      // Posted into the community you're currently in (the public demo when none is picked).
      const communityId = getCommunityId() as Id<"communities"> | undefined;
      const projectId = await create(communityId ? { ...value, communityId } : value);
      setDraft(EMPTY_PROJECT);
      setErrors({});
      props.announce(`Created project ${value.title}. Next, post its first shift.`);
      props.onCreated(projectId);
    } catch (err) {
      const msg = errorMessage(err, "Could not create the project. Try again.");
      setFormError(msg);
      props.announce(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card org-form" aria-labelledby={headingId}>
      <h3 id={headingId} className="org__section-title">
        New project
      </h3>
      <form
        className="stack"
        noValidate
        onSubmit={onSubmit}
        aria-labelledby={headingId}
        aria-describedby={formError ? formErrId : undefined}
      >
        <Field id={id("title")} label="Project title" hint="3–60 characters." error={errors.title}>
          {(a11y) => (
            <input
              {...a11y}
              ref={(el) => {
                refs.current.title = el;
                props.titleRef.current = el;
              }}
              className="org-input"
              type="text"
              autoComplete="off"
              aria-required="true"
              maxLength={60}
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
            />
          )}
        </Field>
        <Field id={id("orgName")} label="Organization" error={errors.orgName}>
          {(a11y) => (
            <input
              {...a11y}
              ref={(el) => {
                refs.current.orgName = el;
              }}
              className="org-input"
              type="text"
              autoComplete="organization"
              aria-required="true"
              maxLength={60}
              value={draft.orgName}
              onChange={(e) => set("orgName", e.target.value)}
            />
          )}
        </Field>
        <Field
          id={id("locationLabel")}
          label="Location"
          hint="Where volunteers go, e.g. Riverside Park."
          error={errors.locationLabel}
        >
          {(a11y) => (
            <input
              {...a11y}
              ref={(el) => {
                refs.current.locationLabel = el;
              }}
              className="org-input"
              type="text"
              autoComplete="off"
              aria-required="true"
              maxLength={80}
              value={draft.locationLabel}
              onChange={(e) => set("locationLabel", e.target.value)}
            />
          )}
        </Field>
        <Field
          id={id("summary")}
          label="Summary"
          optional
          hint={`Up to 280 characters (${draft.summary.length} used).`}
          error={errors.summary}
        >
          {(a11y) => (
            <textarea
              {...a11y}
              ref={(el) => {
                refs.current.summary = el;
              }}
              className="org-input org-textarea"
              rows={3}
              maxLength={280}
              value={draft.summary}
              onChange={(e) => set("summary", e.target.value)}
            />
          )}
        </Field>
        <Field
          id={id("tags")}
          label="Tags"
          optional
          hint="Up to 5, separated by commas — e.g. outdoors, family-friendly."
          error={errors.tags}
        >
          {(a11y) => (
            <input
              {...a11y}
              ref={(el) => {
                refs.current.tags = el;
              }}
              className="org-input"
              type="text"
              autoComplete="off"
              value={draft.tags}
              onChange={(e) => set("tags", e.target.value)}
            />
          )}
        </Field>

        {formError ? (
          <p id={formErrId} className="org-error">
            {formError}
          </p>
        ) : null}
        {atLimit ? (
          <p id={limitId} className="org-hint">
            You organize {MAX_PROJECTS} projects, which is the limit. Post new shifts to an
            existing project instead.
          </p>
        ) : null}

        <div className="row">
          <button
            type="submit"
            className="btn btn--primary"
            aria-disabled={busy || atLimit ? true : undefined}
            aria-describedby={atLimit ? limitId : undefined}
          >
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------------------------------------------------------- post shift form -- */

type ShiftField =
  | "title"
  | "role"
  | "date"
  | "start"
  | "end"
  | "capacity"
  | "meetPoint"
  | "bring"
  | "skillTag"
  | "opens";
const SHIFT_FIELDS: ShiftField[] = [
  "title",
  "role",
  "date",
  "start",
  "end",
  "capacity",
  "meetPoint",
  "bring",
  "skillTag",
  "opens",
];

type ShiftDraft = {
  title: string;
  role: string;
  date: string;
  start: string;
  end: string;
  capacity: string;
  meetPoint: string;
  bring: string;
  skillTag: string;
  later: boolean;
  openDate: string;
  openTime: string;
};

type ShiftTextKey = Exclude<keyof ShiftDraft, "later">;

function freshShiftDraft(now: number): ShiftDraft {
  return {
    title: "",
    role: "Volunteer",
    date: toDateInput(now + DAY),
    start: "09:00",
    end: "11:00",
    capacity: "4",
    meetPoint: "",
    bring: "",
    skillTag: "outdoors",
    later: false,
    openDate: toDateInput(now),
    openTime: "",
  };
}

type ShiftInput = {
  title: string;
  role: string;
  startsAt: number;
  endsAt: number;
  capacity: number;
  meetPoint: string;
  bring: string[];
  skillTag: string;
  opensAt?: number;
};

function validateShift(
  d: ShiftDraft,
  now: number,
): { errors: Partial<Record<ShiftField, string>>; value: ShiftInput | null } {
  const errors: Partial<Record<ShiftField, string>> = {};
  const title = clean(d.title);
  const role = clean(d.role);
  const meetPoint = clean(d.meetPoint);
  const bring = splitList(d.bring);
  const skillTag = d.skillTag.trim().toLowerCase();

  const eTitle = lengthError(title, "Shift title", 3, 60);
  if (eTitle) errors.title = eTitle;
  const eRole = lengthError(role, "Role", 1, 30);
  if (eRole) errors.role = eRole;
  const eMeet = lengthError(meetPoint, "Meet point", 1, 120);
  if (eMeet) errors.meetPoint = eMeet;
  if (bring.length > 8) errors.bring = "List at most 8 things to bring.";
  else if (bring.some((b) => b.length > 40)) {
    errors.bring = "Each item can be at most 40 characters.";
  }
  if (!SKILL_RE.test(skillTag)) {
    errors.skillTag = "Use 1–16 lowercase letters or dashes, no spaces (e.g. outdoors).";
  }

  const capText = d.capacity.trim();
  const capacity = /^\d+$/.test(capText) ? Number(capText) : NaN;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 24) {
    errors.capacity = "Spots must be a whole number from 1 to 24.";
  }

  const startsAt = fromLocal(d.date, d.start);
  const endsAt = fromLocal(d.date, d.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.date = "Pick a date.";
  else if (startsAt === null) errors.start = "Pick a start time.";
  else if (startsAt < now) errors.start = "That start time has already passed.";
  else if (startsAt > now + WINDOW_FWD_MS) {
    errors.date = "Shifts must start within the next 7 days.";
  }

  if (!errors.date) {
    if (endsAt === null) errors.end = "Pick an end time.";
    else if (startsAt !== null && endsAt <= startsAt) {
      errors.end = "End time must be after the start time.";
    } else if (startsAt !== null && endsAt - startsAt > MAX_SHIFT_MS) {
      errors.end = "Shifts can be at most 12 hours long.";
    }
  }

  let opensAt: number | undefined;
  if (d.later) {
    const t = fromLocal(d.openDate, d.openTime);
    if (t === null) errors.opens = "Pick the date and time claims open.";
    else if (t < now + MIN_OPEN_LEAD_MS) {
      errors.opens = "Claims must open at least 1 minute from now.";
    } else if (startsAt !== null && t >= startsAt) {
      errors.opens = "Claims must open before the shift starts.";
    } else opensAt = t;
  }

  if (Object.keys(errors).length > 0 || startsAt === null || endsAt === null) {
    return { errors, value: null };
  }
  return {
    errors,
    value: {
      title,
      role,
      startsAt,
      endsAt,
      capacity,
      meetPoint,
      bring,
      skillTag,
      ...(opensAt === undefined ? {} : { opensAt }),
    },
  };
}

function PostShiftForm(props: {
  projects: MyProjects | undefined;
  selected: string;
  onSelect: (projectId: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  now: number;
  announce: (msg: string) => void;
  onOpenShift: (shiftId: string) => void;
}): JSX.Element {
  const create = useMutation(api.organize.createShift);
  const uid = useId();
  const [draft, setDraft] = useState<ShiftDraft>(() => freshShiftDraft(Date.now()));
  const [errors, setErrors] = useState<Partial<Record<ShiftField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<{ id: string; title: string } | null>(null);
  const refs = useRef<Partial<Record<ShiftField, HTMLInputElement | null>>>({});

  const headingId = `${uid}-heading`;
  const formErrId = `${uid}-form-err`;
  const laterId = `${uid}-later`;
  const laterHintId = `${uid}-later-hint`;
  const demoHintId = `${uid}-demo-hint`;
  const opensGroupId = `${uid}-opens`;
  const opensLabelId = `${uid}-opens-label`;
  const opensErrId = `${uid}-opens-err`;
  const projectSelectId = `${uid}-project`;
  const skillListId = `${uid}-skills`;
  const id = (f: string) => `${uid}-${f}`;

  const projects = props.projects;
  const selectedProject =
    projects?.find((p) => p._id === props.selected) ?? projects?.[0] ?? undefined;

  const clearError = (f: ShiftField) => {
    if (errors[f]) setErrors((e) => withoutKey(e, f));
  };

  const set = (k: ShiftTextKey, f: ShiftField, value: string) => {
    setDraft((d) => ({ ...d, [k]: value }));
    clearError(f);
  };

  const toggleLater = (checked: boolean) => {
    setDraft((d) => {
      if (!checked || d.openTime !== "") return { ...d, later: checked };
      // First reveal: suggest ten minutes from now, rounded up to the next 5 minutes.
      const t = Math.ceil((Date.now() + 10 * MIN) / (5 * MIN)) * (5 * MIN);
      return { ...d, later: true, openDate: toDateInput(t), openTime: toTimeInput(t) };
    });
    clearError("opens");
  };

  const opensInTwoMinutes = () => {
    // Round UP to the whole minute: the time input has minute precision, and rounding down could
    // drop under the server's 1-minute minimum lead by the time the form is submitted.
    const t = Math.ceil((Date.now() + 2 * MIN) / MIN) * MIN;
    setDraft((d) => ({ ...d, later: true, openDate: toDateInput(t), openTime: toTimeInput(t) }));
    clearError("opens");
    props.announce(`Claims will open at ${formatClock(t)}.`);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !selectedProject) return;
    setFormError(null);
    const { errors: found, value } = validateShift(draft, Date.now());
    setErrors(found);
    const invalid = SHIFT_FIELDS.filter((f) => found[f]);
    if (invalid.length > 0 || value === null) {
      if (invalid.length > 0) refs.current[invalid[0]]?.focus();
      props.announce(fieldsNeedAttention(Math.max(1, invalid.length)));
      return;
    }
    setBusy(true);
    try {
      const shiftId = await create({
        projectId: selectedProject._id as Id<"projects">,
        ...value,
      });
      setPosted({ id: shiftId, title: value.title });
      setDraft(freshShiftDraft(Date.now()));
      setErrors({});
      props.announce(
        value.opensAt === undefined
          ? `Posted ${value.title} to ${selectedProject.title}. It is open for claims now.`
          : `Posted ${value.title} to ${selectedProject.title}. Claims open ${formatDayClock(
              value.opensAt,
            )}; neighbours can tap Notify me until then.`,
      );
      refs.current.title?.focus();
    } catch (err) {
      const msg = errorMessage(err, "Could not post the shift. Try again.");
      setFormError(msg);
      props.announce(msg);
    } finally {
      setBusy(false);
    }
  };

  const minDate = toDateInput(props.now);
  const maxDate = toDateInput(props.now + WINDOW_FWD_MS);
  const opensPreview = draft.later ? fromLocal(draft.openDate, draft.openTime) : null;
  const opensDescribedBy = [errors.opens ? opensErrId : null, laterHintId]
    .filter((x): x is string => x !== null)
    .join(" ");

  return (
    <section className="card org-form" aria-labelledby={headingId}>
      <h3 id={headingId} ref={props.headingRef} tabIndex={-1} className="org__section-title">
        Post a shift
      </h3>

      {projects === undefined ? (
        <p className="notice" aria-busy="true">
          Loading your projects…
        </p>
      ) : !selectedProject ? (
        <p className="notice">Create a project first — every shift belongs to a project.</p>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={onSubmit}
          aria-labelledby={headingId}
          aria-describedby={formError ? formErrId : undefined}
        >
          {posted ? (
            <div className="notice notice--good">
              <p>Posted “{posted.title}”. It is live on the board.</p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => props.onOpenShift(posted.id)}
                >
                  View on board<span className="sr-only">: {posted.title}</span>
                </button>
              </div>
            </div>
          ) : null}

          <div className="org-field">
            <label htmlFor={projectSelectId} className="org-label">
              Project
            </label>
            <select
              id={projectSelectId}
              className="org-input"
              value={selectedProject._id}
              onChange={(e) => props.onSelect(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>

          <Field id={id("title")} label="Shift title" hint="3–60 characters." error={errors.title}>
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.title = el;
                }}
                className="org-input"
                type="text"
                autoComplete="off"
                aria-required="true"
                maxLength={60}
                value={draft.title}
                onChange={(e) => set("title", "title", e.target.value)}
              />
            )}
          </Field>

          <Field id={id("role")} label="Role" hint="e.g. Litter picker, Driver." error={errors.role}>
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.role = el;
                }}
                className="org-input"
                type="text"
                autoComplete="off"
                aria-required="true"
                maxLength={30}
                value={draft.role}
                onChange={(e) => set("role", "role", e.target.value)}
              />
            )}
          </Field>

          <fieldset className="org-fieldset">
            <legend className="org-legend">When</legend>
            <p className="org-hint">
              Starts within the next 7 days; ends the same day, up to 12 hours later. Times are
              your local time.
            </p>
            <div className="org-when">
              <Field id={id("date")} label="Date" error={errors.date}>
                {(a11y) => (
                  <input
                    {...a11y}
                    ref={(el) => {
                      refs.current.date = el;
                    }}
                    className="org-input"
                    type="date"
                    aria-required="true"
                    min={minDate}
                    max={maxDate}
                    value={draft.date}
                    onChange={(e) => set("date", "date", e.target.value)}
                  />
                )}
              </Field>
              <Field id={id("start")} label="Start time" error={errors.start}>
                {(a11y) => (
                  <input
                    {...a11y}
                    ref={(el) => {
                      refs.current.start = el;
                    }}
                    className="org-input"
                    type="time"
                    aria-required="true"
                    value={draft.start}
                    onChange={(e) => set("start", "start", e.target.value)}
                  />
                )}
              </Field>
              <Field id={id("end")} label="End time" error={errors.end}>
                {(a11y) => (
                  <input
                    {...a11y}
                    ref={(el) => {
                      refs.current.end = el;
                    }}
                    className="org-input"
                    type="time"
                    aria-required="true"
                    value={draft.end}
                    onChange={(e) => set("end", "end", e.target.value)}
                  />
                )}
              </Field>
            </div>
          </fieldset>

          <Field
            id={id("capacity")}
            label="Spots"
            hint="How many volunteers, 1–24."
            error={errors.capacity}
          >
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.capacity = el;
                }}
                className="org-input org-input--short"
                type="number"
                inputMode="numeric"
                min={1}
                max={24}
                step={1}
                aria-required="true"
                value={draft.capacity}
                onChange={(e) => set("capacity", "capacity", e.target.value)}
              />
            )}
          </Field>

          <Field
            id={id("meetPoint")}
            label="Meet point"
            hint="Where people find you, e.g. North gate by the café."
            error={errors.meetPoint}
          >
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.meetPoint = el;
                }}
                className="org-input"
                type="text"
                autoComplete="off"
                aria-required="true"
                maxLength={120}
                value={draft.meetPoint}
                onChange={(e) => set("meetPoint", "meetPoint", e.target.value)}
              />
            )}
          </Field>

          <Field
            id={id("bring")}
            label="What to bring"
            optional
            hint="Up to 8 items, separated by commas — e.g. gloves, water."
            error={errors.bring}
          >
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.bring = el;
                }}
                className="org-input"
                type="text"
                autoComplete="off"
                value={draft.bring}
                onChange={(e) => set("bring", "bring", e.target.value)}
              />
            )}
          </Field>

          <Field
            id={id("skillTag")}
            label="Skill tag"
            hint="One word, lowercase letters or dashes — e.g. outdoors, repair."
            error={errors.skillTag}
          >
            {(a11y) => (
              <input
                {...a11y}
                ref={(el) => {
                  refs.current.skillTag = el;
                }}
                className="org-input org-input--short"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-required="true"
                maxLength={16}
                list={skillListId}
                value={draft.skillTag}
                onChange={(e) => set("skillTag", "skillTag", e.target.value)}
              />
            )}
          </Field>
          <datalist id={skillListId}>
            {SKILL_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          <fieldset className="org-fieldset">
            <legend className="org-legend">Claims</legend>
            <div className="org-check">
              <input
                id={laterId}
                type="checkbox"
                checked={draft.later}
                aria-describedby={laterHintId}
                aria-controls={draft.later ? opensGroupId : undefined}
                onChange={(e) => toggleLater(e.target.checked)}
              />
              <label htmlFor={laterId}>Open claims later</label>
            </div>
            <p id={laterHintId} className="org-hint">
              Neighbours see a countdown and can tap Notify me; the shift unlocks for everyone at
              exactly this time.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn--secondary"
                aria-describedby={demoHintId}
                onClick={opensInTwoMinutes}
              >
                Opens in 2 minutes
              </button>
              <span id={demoHintId} className="org-hint">
                Fills in an opening time — handy for a live demo.
              </span>
            </div>

            {draft.later ? (
              <div id={opensGroupId} className="stack" role="group" aria-labelledby={opensLabelId}>
                <p id={opensLabelId} className="org-label">
                  Claims open at
                </p>
                <div className="org-when">
                  <div className="org-field">
                    <label htmlFor={id("openDate")} className="org-label">
                      Opening date
                    </label>
                    <input
                      id={id("openDate")}
                      ref={(el) => {
                        refs.current.opens = el;
                      }}
                      className="org-input"
                      type="date"
                      min={minDate}
                      max={draft.date || maxDate}
                      aria-invalid={errors.opens ? true : undefined}
                      aria-describedby={opensDescribedBy}
                      value={draft.openDate}
                      onChange={(e) => set("openDate", "opens", e.target.value)}
                    />
                  </div>
                  <div className="org-field">
                    <label htmlFor={id("openTime")} className="org-label">
                      Opening time
                    </label>
                    <input
                      id={id("openTime")}
                      className="org-input"
                      type="time"
                      aria-invalid={errors.opens ? true : undefined}
                      aria-describedby={opensDescribedBy}
                      value={draft.openTime}
                      onChange={(e) => set("openTime", "opens", e.target.value)}
                    />
                  </div>
                </div>
                {errors.opens ? (
                  <p id={opensErrId} className="org-error">
                    {errors.opens}
                  </p>
                ) : null}
                {opensPreview !== null && opensPreview > props.now ? (
                  <p className="org-hint">
                    Neighbours will see:{" "}
                    <span className="badge org-badge--scheduled">
                      <Countdown to={opensPreview} label="Opens in" />
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>

          {formError ? (
            <p id={formErrId} className="org-error">
              {formError}
            </p>
          ) : null}

          <div className="row">
            <button
              type="submit"
              className="btn btn--primary"
              aria-disabled={busy ? true : undefined}
            >
              {busy ? "Posting…" : draft.later ? "Post scheduled shift" : "Post shift"}
            </button>
            <span className="org-hint">to {selectedProject.title}</span>
          </div>
        </form>
      )}
    </section>
  );
}
