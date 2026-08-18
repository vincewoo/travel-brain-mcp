/**
 * Types for the capture queue's rules. The implementation is plain JavaScript so `node --test` can
 * exercise it without a DOM — the conflict rules are the part of this app most worth testing, and
 * the least visible when they are wrong.
 */

import type { ItineraryItem, JournalEntry, Memory, Place, Snapshot, Visit } from "./types";

export type OutboxKind = "new_place" | "itinerary_status" | "place_visit" | "journal_note" | "preference";

export interface ItineraryStatusPayload {
  trip_id: string;
  itinerary_item_id: string;
  /** What the row is being recorded as; the plan's own timing is never touched. */
  status: "completed" | "skipped";
  actual_start?: string;
  actual_end?: string;
  /** Carried so needs-attention can name the item even after it has left the plan. */
  title: string;
}

export interface JournalNotePayload {
  trip_id: string;
  raw_note: string;
  captured_at: string;
  reaction?: string;
  itinerary_item_id?: string;
  place_id?: string;
  latitude?: number;
  longitude?: number;
}

export interface PlaceVisitPayload {
  trip_id: string;
  place_id: string;
  itinerary_item_id?: string;
  arrived_at?: string;
  departed_at?: string;
  rating?: number;
  would_return?: boolean;
  recommendation?: string;
  notes?: string;
  /** For the needs-attention list, which has to read after the place has gone. */
  place_name?: string;
}

export interface NewPlacePayload {
  trip_id: string;
  /** The `pending:` id this place carries in the cache until `add_place` answers with a real one. */
  local_id: string;
  name: string;
  category?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coordinate_source?: "provided" | "estimated" | "geocoded";
  trip_status?: "shortlist" | "planned" | "visited" | "rejected";
}

export interface PreferencePayload {
  trip_id: string;
  content: string;
  memory_type?: string;
}

export type OutboxPayload =
  | ItineraryStatusPayload
  | JournalNotePayload
  | PlaceVisitPayload
  | NewPlacePayload
  | PreferencePayload;

export interface OutboxEntry<P = any> {
  op_id: string;
  kind: OutboxKind;
  payload: P;
  created_at: string;
  attempts: number;
  last_error: string | null;
  state: "queued" | "attention";
  attention_reason: string | null;
}

export interface ToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export type Resolution =
  | { action: "send"; request: ToolRequest; reason?: undefined }
  | { action: "hold"; reason: string }
  | { action: "attention"; reason: string };

export interface OutboxSummary {
  queued: number;
  failing: number;
  attention: number;
}

export interface ToolResult {
  journal_entry?: JournalEntry;
  visit?: Visit;
  memory?: Memory;
  place?: Place;
  itinerary_item?: ItineraryItem;
}

export declare const MAX_ATTEMPTS: number;
export declare const PENDING_PREFIX: string;
export declare const OUTBOX_KINDS: OutboxKind[];
export declare const ATTENTION_REASONS: Record<string, string>;

export declare function isPendingId(id: unknown): boolean;
export declare function pendingId(): string;
export declare function queueOperation<P extends OutboxPayload>(kind: OutboxKind, payload: P, at?: Date): OutboxEntry<P>;
export declare function sortQueue(entries: OutboxEntry[]): OutboxEntry[];
export declare function isQueued(entry: OutboxEntry): boolean;
export declare function needsAttention(entry: OutboxEntry): boolean;
export declare function outboxSummary(entries: OutboxEntry[]): OutboxSummary;
export declare function resolveOperation(
  entry: OutboxEntry,
  context?: { snapshot?: Snapshot | null; idMap?: Map<string, string>; pending?: Set<string> }
): Resolution;
export declare function toolRequest(entry: OutboxEntry, payload?: Record<string, unknown>): ToolRequest;
export declare function applyOperation(snapshot: Snapshot, entry: OutboxEntry): Snapshot;
export declare function applyResult(
  snapshot: Snapshot,
  entry: OutboxEntry,
  result: ToolResult | null
): { snapshot: Snapshot; mapping: [string, string] | null };
export declare function recordFailure(entry: OutboxEntry, error: unknown, limit?: number): OutboxEntry;
export declare function flagForAttention(entry: OutboxEntry, reason: string): OutboxEntry;
export declare function pendingPlaceIds(entries: OutboxEntry[]): Set<string>;
export declare function attentionMessage(entry: OutboxEntry): string;
