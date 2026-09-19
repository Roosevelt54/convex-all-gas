import LandingBackdrop from "./LandingBackdrop";
import "./Landing.css";

const REPO = "https://github.com/Roosevelt54/convex-all-gas";

/** The public front door. "#/" (and every in-app link) still goes straight to the live board. */
export default function Landing() {
  return (
    <div className="lp">
      <nav className="lp__nav" aria-label="Main">
        <a className="lp__brand" href="#top">
          <span className="wordmark__mark" aria-hidden="true" /> Crewcall
        </a>
        <div className="lp__links">
          <a href="#what">What it does</a>
          <a href="#how">How it works</a>
          <a href="#limits">Limitations</a>
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a className="lp__btn lp__btn--light lp__btn--sm" href="#/">Open Crewcall</a>
        </div>
      </nav>

      <header className="lp__hero" id="top">
        <LandingBackdrop />
        <h1>The shift everyone meant to sign up for is the one nobody did.</h1>
        <p className="lp__lede">
          Crewcall gives each neighbourhood its own live board of volunteer shifts. Organizers post,
          members claim a spot in one tap, and every screen updates the instant anyone moves.
        </p>
        <div className="lp__cta">
          <a className="lp__btn lp__btn--light" href="#/">Open the live board</a>
          <a className="lp__btn lp__btn--ghost" href={REPO} target="_blank" rel="noreferrer">
            View the code
          </a>
        </div>
      </header>

      <section className="lp__stats" aria-label="At a glance">
        <div><strong>0 ms</strong><span>of polling. Every board, feed and roster is a live Convex subscription.</span></div>
        <div><strong>1</strong><span>spot per person, even when two people tap the last one at the same moment.</span></div>
        <div><strong>1 link</strong><span>is all a member needs to join a private community. No account required.</span></div>
        <div><strong>0</strong><span>shifts visible to anyone outside your community. Checked on the server.</span></div>
      </section>

      <section className="lp__section" id="what">
        <p className="lp__eyebrow">What it does</p>
        <h2>Three jobs a group chat does badly.</h2>
        <div className="lp__grid3">
          <article className="lp__card">
            <span className="lp__num">01 — The board</span>
            <h3>Everyone sees the same spots</h3>
            <p>Spots left, who's coming and what's critical, live on every phone and on a wall display. No refreshing, no "is this still open?"</p>
          </article>
          <article className="lp__card">
            <span className="lp__num">02 — The queue</span>
            <h3>Full shifts keep a fair waitlist</h3>
            <p>When someone drops out, the next person in line is moved into their exact spot in the same transaction, and everyone watching sees it happen.</p>
          </article>
          <article className="lp__card">
            <span className="lp__num">03 — The space</span>
            <h3>Each community stays private</h3>
            <p>An organizer creates a community and shares its invite link. Only members see its shifts, its activity and who's online.</p>
          </article>
        </div>
      </section>

      <section className="lp__section" id="how">
        <p className="lp__eyebrow">How it works</p>
        <h2>From "we need hands" to a full roster.</h2>
        <ol className="lp__steps">
          <li><span>01</span><h3>Create your community</h3><p>Sign in with a username and password, name your community, and copy its invite link.</p></li>
          <li><span>02</span><h3>Post shifts</h3><p>Add a project, then shifts with a time, place and number of spots. Optionally unlock them at a set time.</p></li>
          <li><span>03</span><h3>Share the link</h3><p>Members open it, pick a name, and they're in. Their claims follow them if they make an account later.</p></li>
          <li><span>04</span><h3>Watch it fill</h3><p>Claims, drop-outs and promotions stream into every open screen within a second.</p></li>
        </ol>
      </section>

      <section className="lp__section" id="limits">
        <p className="lp__eyebrow">What it does not do</p>
        <h2>The parts that are honest about being unfinished.</h2>
        <div className="lp__grid3">
          <article className="lp__card"><h3>No push notifications</h3><p>"Notify me" alerts fire while Crewcall is open in a tab, not on a closed phone.</p></article>
          <article className="lp__card"><h3>The demo is simulated</h3><p>The public demo board has seeded neighbours who claim spots so there's always something moving. Private communities are all real people.</p></article>
          <article className="lp__card"><h3>Invite links don't expire</h3><p>Anyone holding the link can join. Organizers can't rotate or revoke it yet.</p></article>
        </div>
      </section>

      <footer className="lp__footer">
        <p>Built on Convex for the All Gas hackathon.</p>
        <a className="lp__btn lp__btn--light" href="#/">Open Crewcall</a>
      </footer>
    </div>
  );
}
