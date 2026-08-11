import type { ReactNode } from "react";

/**
 * Loading, empty, and gone-wrong, said the same way the dashboard says them.
 *
 * The distinction the dashboard draws is worth keeping on a phone: a view that is empty *and fine*
 * reads as a sentence, and a view that is empty because nothing has been started yet gets a dashed
 * box. On this app there is a third case the dashboard never has — empty because the cache has not
 * been filled yet — and that one says so plainly rather than pretending the trip has no places.
 */

export function Spinner({ label }: { label: string }) {
  return <span className="spinner"><i aria-hidden="true" />{label}</span>;
}

export function SkeletonList({ label }: { label: string }) {
  return <section className="container" aria-busy="true">
    <div className="container-head"><strong>{label}</strong><Spinner label="Loading" /></div>
    {[[62, 38], [48, 56], [70, 0]].map(([title, detail], index) => <div className="skeleton-row" key={index}>
      <div><div className="bar" style={{ width: `${title}%` }} />{detail ? <div className="bar soft" style={{ width: `${detail}%` }} /> : null}</div>
    </div>)}
  </section>;
}

export function NoteEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="note-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

export function BlankSlate({ title, detail, centred }: { title: string; detail: string; centred?: boolean }) {
  return <div className={`blank-slate${centred ? " centred" : ""}`}>
    <strong>{title}</strong><p>{detail}</p>
  </div>;
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warning" | "danger"; children: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}
