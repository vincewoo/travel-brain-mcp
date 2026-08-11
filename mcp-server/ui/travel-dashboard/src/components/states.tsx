import React, { type ReactNode } from "react";

export function Spinner({ label }: { label: string }) {
  return <span className="spinner"><i aria-hidden="true" />{label}</span>;
}

/** Loading a view keeps the container and its header so nothing jumps when the data lands. */
export function SkeletonList({ label }: { label: string }) {
  return <section className="container" aria-busy="true">
    <div className="container-head"><strong>{label}</strong><Spinner label="Loading" /></div>
    {[[62, 38], [48, 56], [70, 0]].map(([title, detail], index) => <div className="skeleton-row" key={index}>
      <div className="bar" />
      <div><div className="bar" style={{ width: `${title}%` }} />{detail ? <div className="bar soft" style={{ width: `${detail}%` }} /> : null}</div>
    </div>)}
  </section>;
}

/** Empty and fine: a normal condition reads as a sentence, never as a dashed box. */
export function NoteEmpty({ title, detail, action }: { title: string; detail: string; action?: { label: string; onPick: () => void } }) {
  return <div className="note-empty">
    <strong>{title}</strong><span>{detail}</span>
    {action ? <button type="button" className="link-button" onClick={action.onPick}>{action.label}</button> : null}
  </div>;
}

/** Empty because nothing has been started yet: dashed, and it earns a real button. */
export function BlankSlate({ title, detail, action, centred }: {
  title: string; detail: string; centred?: boolean;
  action?: { label: string; onPick: () => void; primary?: boolean };
}) {
  return <div className={`blank-slate${centred ? " centred" : ""}`}>
    <strong>{title}</strong><p>{detail}</p>
    {action ? <button type="button" className={`button${action.primary ? " primary" : ""}`} onClick={action.onPick}>{action.label}</button> : null}
  </div>;
}

export function ViewMessage({ title, detail, detailBlock, children }: {
  title: string; detail: string; detailBlock?: string | null; children?: ReactNode;
}) {
  return <div className="view-message">
    <strong>{title}</strong><p>{detail}</p>
    {detailBlock ? <p className="mono">{detailBlock}</p> : null}
    {children ? <div className="button-row">{children}</div> : null}
  </div>;
}

export interface ToastState {
  kind: "success" | "error";
  title: string;
  detail: string;
  action?: { label: string; onPick: () => void };
}

export function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  return <div className={`toast${toast.kind === "error" ? " error" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>
    <b>{toast.title}</b><span>{toast.detail}</span>
    {toast.action ? <button
      type="button"
      className={`link-button${toast.kind === "error" ? " danger" : ""}`}
      onClick={() => { toast.action?.onPick(); onDismiss(); }}
    >{toast.action.label}</button> : null}
  </div>;
}

/** A tool call is in flight; the view stays usable and only the acting row disables. */
export function WorkingPill({ label }: { label: string }) {
  return <div className="working-pill" role="status"><Spinner label={label} /></div>;
}
