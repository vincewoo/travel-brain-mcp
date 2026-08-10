# Memory model

## Semantic memory

A memory has:

- `memory_type`: preference, constraint, tendency, lesson, identity_note, other
- `scope`: global or trip-specific via optional `trip_id`
- `content`: retrieval-friendly statement
- `confidence`: 0..1
- `status`: candidate, confirmed, rejected, superseded
- `provenance`: explicit, inferred, imported
- evidence links

### Promotion policy

- Explicit user instruction such as “I prefer neighborhood restaurants” may become `confirmed` immediately.
- A pattern inferred from behavior should be written as `candidate` until confirmed or strongly evidenced.
- Journal sentiment alone should not silently become a durable global preference.

## Research memory

Research findings carry:

- topic
- finding
- optional summary
- volatility: static, semi_volatile, volatile
- `valid_as_of`
- optional `expires_at`
- confidence
- source records

### Refresh guidance

- Static: geography, historical context — reuse unless contradicted.
- Semi-volatile: typical price, reputation, reservation difficulty — refresh when old or decision-critical.
- Volatile: opening hours, closures, availability, transit disruptions — refresh near decision time.

## Journal memory

Journal raw notes are immutable user-authored evidence unless the user edits them. Generated summaries are derivative and stored separately.

## Retrieval

v0.1 uses simple textual retrieval and metadata filtering. Embedding fields are present but nullable. A later worker can populate them and add hybrid vector + lexical retrieval without changing the canonical records.
