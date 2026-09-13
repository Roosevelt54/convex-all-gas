import { useCallback, useRef } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";

type ShiftRow = FunctionReturnType<typeof api.board.snapshot>["shifts"][number];

export type TimeWindow = "today" | "48h" | "week";

export const TIME_WINDOWS: Array<{ id: TimeWindow; label: string }> = [
  { id: "today", label: "Today" },
  { id: "48h", label: "Next 48h" },
  { id: "week", label: "This week" },
];

/**
 * "Where I'm needed most" ranking.
 *
 * THIS IS A DETERMINISTIC LOCAL SCORING FUNCTION over data already in the client.
 * No AI, no API key, no network call — it is plain arithmetic over the <= 60 snapshot
 * rows that are already on screen, so the same board always produces the same answer.
 *
 * Higher is more needed. A shift nobody can join scores -1 and is never picked.
 */
export function scoreNeed(
  shift: ShiftRow,
  now: number,
  selectedSkills: readonly string[],
): number {
  const spotsLeft = Math.max(0, shift.capacity - shift.filledCount);
  if (shift.status !== "open" || spotsLeft === 0) return -1;

  const hoursOut = Math.max(0, (shift.startsAt - now) / 3_600_000);
  const scarcity = 60 / (spotsLeft + 1); // fewer spots left => harder to fill
  const imminence = 48 / (hoursOut + 2); // sooner => less time left to fill it
  const skillMatch = selectedSkills.includes(shift.skillTag) ? 25 : 0;
  return scarcity + imminence + skillMatch;
}

export default function Filters(props: {
  timeWindow: TimeWindow;
  onTimeWindow: (w: TimeWindow) => void;
  skills: readonly string[];
  selectedSkills: readonly string[];
  onToggleSkill: (tag: string) => void;
  needsPeopleOnly: boolean;
  onNeedsPeopleOnly: (v: boolean) => void;
  onFindWhereNeeded: () => void;
  shownCount: number;
  totalCount: number;
}): JSX.Element {
  const {
    timeWindow,
    onTimeWindow,
    skills,
    selectedSkills,
    onToggleSkill,
    needsPeopleOnly,
    onNeedsPeopleOnly,
    onFindWhereNeeded,
    shownCount,
    totalCount,
  } = props;

  // A radiogroup is ONE tab stop with roving tabindex and arrow-key movement, not
  // three separate tab stops.
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onRadioKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = TIME_WINDOWS.length - 1;
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = index === last ? 0 : index + 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = index === 0 ? last : index - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = last;
      if (next === -1) return;
      e.preventDefault();
      onTimeWindow(TIME_WINDOWS[next].id);
      radioRefs.current[next]?.focus();
    },
    [onTimeWindow],
  );

  return (
    <nav className="card filters" aria-label="Filters">
      <h2 className="fieldset__legend">Filters</h2>

      <div className="fieldset">
        <p className="fieldset__legend" id="filters-window-legend">
          When
        </p>
        <div className="chips" role="radiogroup" aria-labelledby="filters-window-legend">
          {TIME_WINDOWS.map((w, i) => {
            const checked = timeWindow === w.id;
            return (
              <button
                key={w.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                ref={(el) => {
                  radioRefs.current[i] = el;
                }}
                className={`btn btn--sm ${checked ? "btn--primary" : "btn--secondary"}`}
                onClick={() => onTimeWindow(w.id)}
                onKeyDown={(e) => onRadioKey(e, i)}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      <fieldset className="fieldset">
        <legend className="fieldset__legend">Skills</legend>
        {skills.length === 0 ? (
          <p className="muted">No skill tags on the board yet.</p>
        ) : (
          <div className="chips">
            {skills.map((tag) => {
              const on = selectedSkills.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={on}
                  className="btn btn--sm btn--secondary"
                  onClick={() => onToggleSkill(tag)}
                >
                  {tag}
                  <span className="sr-only">{on ? " — filter on" : " — filter off"}</span>
                </button>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="fieldset">
        <div className="switch-row">
          <span id="filters-needs-label">Only shifts that still need people</span>
          <button
            type="button"
            role="switch"
            aria-checked={needsPeopleOnly}
            aria-labelledby="filters-needs-label"
            className="btn btn--sm btn--secondary"
            onClick={() => onNeedsPeopleOnly(!needsPeopleOnly)}
          >
            {needsPeopleOnly ? "On" : "Off"}
          </button>
        </div>
      </div>

      <div className="stack">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onFindWhereNeeded}
          aria-describedby="filters-needed-note"
        >
          Where I&rsquo;m needed most
        </button>
        <p className="muted" id="filters-needed-note">
          Ranked on this device from spots left, hours until start and your skill chips, then
          focus moves to that card. No model, no key, no network call.
        </p>
      </div>

      <p className="muted tnum">
        Showing {shownCount} of {totalCount} shifts.
      </p>
    </nav>
  );
}
