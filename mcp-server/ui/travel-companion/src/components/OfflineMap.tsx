import { bearingDegrees, geoBounds, haversineMeters } from "../../../../src/trip-clock.mjs";
import type { Tone } from "../../../shared/format";
import { distanceLabel } from "../format";
import type { Origin } from "../types";

/**
 * A map with no basemap.
 *
 * This is what the traveller gets when the radio is off, and it is the reason maps could be added
 * to this app at all: `docs/companion-pwa.md` rules out offline *tiles*, and a tile map with no
 * network is a grid of grey squares that says nothing. What is still true offline is where things
 * are relative to each other and to you, because the coordinates are already in IndexedDB. So this
 * draws exactly that — true relative positions, a real scale bar, and no coastline it cannot know.
 *
 * It ships in the shell rather than in the lazily loaded map chunk, because it has to be on the
 * phone before the connection is gone. That is why it is hand-drawn SVG with no dependency.
 *
 * North is up. It is never rotated to the direction of travel: there is no compass reading here,
 * and a map that silently guessed which way you were facing would be the kind of confident lie this
 * app is built to avoid.
 */

export interface MapPoint {
  id: string;
  label: string;
  latitude: number | null;
  longitude: number | null;
  /** The same five tones the rest of the product speaks in; drives the pin colour. */
  tone?: Tone;
  /** Position in the day, when the caller is drawing an ordered timeline rather than a set. */
  index?: number;
  /** Drawn hollow — a place that is done, skipped, or otherwise behind the traveller. */
  muted?: boolean;
  /**
   * The coordinates are an estimate rather than a surveyed fix, so the pin is drawn with a broken
   * edge. A dashed pin says "roughly here" without a sentence, which is the only honest way to draw
   * a point recalled from memory next to one that was measured.
   */
  approximate?: boolean;
}

const TONE_VAR: Record<Tone, string> = {
  muted: "var(--faint)",
  info: "var(--info)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  ok: "var(--ok)",
};

/** Metres per degree of latitude. Good enough for a drawing; `haversineMeters` does the numbers. */
const METRES_PER_DEGREE = 111_320;
/** Round numbers a person can hold in their head, for the scale bar. */
const SCALE_STEPS = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000];

const VIEW_WIDTH = 320;
const PADDING = 26;

const placed = (point: { latitude: number | null; longitude: number | null }) =>
  point.latitude !== null && point.longitude !== null;

/**
 * A single destination and a known origin is a direction, not a picture. A dial says "that way,
 * 600 m" — which is the whole of what a schematic can honestly tell you about one place.
 */
function Dial({ point, origin }: { point: MapPoint; origin: Origin }) {
  const metres = haversineMeters(origin, point);
  const bearing = bearingDegrees(origin, point) ?? 0;
  const radius = 42;
  const radians = ((bearing - 90) * Math.PI) / 180;
  const tip = { x: 60 + Math.cos(radians) * radius, y: 60 + Math.sin(radians) * radius };

  return <svg
    className="offline-map dial"
    viewBox="0 0 120 120"
    role="img"
    aria-label={`${point.label} is ${distanceLabel(metres) ?? "an unknown distance"} away, bearing ${Math.round(bearing)} degrees`}
  >
    <circle cx="60" cy="60" r={radius} fill="var(--surface-sunken)" stroke="var(--border)" />
    <text x="60" y="14" className="offline-map-compass" textAnchor="middle">N</text>
    <line x1="60" y1="60" x2={tip.x} y2={tip.y} stroke={TONE_VAR[point.tone ?? "info"]} strokeWidth="2.5" strokeLinecap="round" />
    <circle
      cx={tip.x} cy={tip.y} r="4.5"
      fill={point.approximate ? "var(--surface)" : TONE_VAR[point.tone ?? "info"]}
      stroke={TONE_VAR[point.tone ?? "info"]} strokeWidth="2"
      strokeDasharray={point.approximate ? "2.5 2" : undefined}
    />
    <circle cx="60" cy="60" r="3.5" fill="var(--text)" />
    <text x="60" y="112" className="offline-map-scale" textAnchor="middle">{distanceLabel(metres) ?? ""}</text>
  </svg>;
}

export function OfflineMap({ points, origin, height = 200 }: {
  points: MapPoint[];
  origin?: Origin | null;
  height?: number;
}) {
  const mappable = points.filter(placed);
  if (!mappable.length) return null;

  const distinct = new Set(mappable.map((point) => `${point.latitude},${point.longitude}`));
  if (distinct.size === 1 && origin) return <Dial point={mappable[0]} origin={origin} />;

  const bounds = geoBounds([...mappable, ...(origin ? [origin] : [])]);
  if (!bounds) return null;
  const { center } = bounds;
  const shrink = Math.cos((center.latitude * Math.PI) / 180);

  // Project into a flat space where one unit is one degree of latitude, squeezing longitude by the
  // latitude's cosine so the drawing keeps its shape. Over a city this is indistinguishable from
  // anything cleverer, and the scale bar below is computed from the real haversine anyway.
  const project = (point: { latitude: number; longitude: number }) => ({
    x: (point.longitude - center.longitude) * shrink,
    y: -(point.latitude - center.latitude),
  });

  const flat = mappable.map((point) => ({ point, at: project(point as { latitude: number; longitude: number }) }));
  const originAt = origin ? project(origin) : null;
  const spread = [...flat.map((entry) => entry.at), ...(originAt ? [originAt] : [])];
  const reachX = Math.max(...spread.map((at) => Math.abs(at.x)));
  const reachY = Math.max(...spread.map((at) => Math.abs(at.y)));

  // A uniform scale, so a centimetre means the same thing in both directions.
  const usableX = VIEW_WIDTH / 2 - PADDING;
  const usableY = height / 2 - PADDING;
  const scale = Math.min(
    reachX > 0 ? usableX / reachX : Infinity,
    reachY > 0 ? usableY / reachY : Infinity
  );
  // Everything in one spot: nothing to scale to, so pick something and let the pins overlap.
  const zoom = Number.isFinite(scale) ? scale : usableY;
  const toSvg = (at: { x: number; y: number }) => ({ x: VIEW_WIDTH / 2 + at.x * zoom, y: height / 2 + at.y * zoom });

  // The scale bar is measured, not assumed: a real distance across the drawing, divided by the
  // pixels it spans, gives the metres each pixel is worth.
  const metresPerUnit = METRES_PER_DEGREE / zoom;
  const target = (VIEW_WIDTH * 0.28) * metresPerUnit;
  const barMetres = SCALE_STEPS.find((step) => step >= target) ?? SCALE_STEPS[SCALE_STEPS.length - 1];
  const barWidth = barMetres / metresPerUnit;

  const labelled = flat.length <= 8;

  return <svg
    className="offline-map"
    viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
    role="img"
    aria-label={`Relative positions of ${flat.length} places${origin ? " and your last known position" : ""}, without a basemap`}
  >
    {originAt ? (() => {
      const at = toSvg(originAt);
      return <g>
        <circle cx={at.x} cy={at.y} r="11" className="offline-map-halo" />
        <circle cx={at.x} cy={at.y} r="4.5" fill="var(--text)" />
      </g>;
    })() : null}

    {flat.map(({ point, at }) => {
      const { x, y } = toSvg(at);
      const colour = TONE_VAR[point.tone ?? "info"];
      return <g key={point.id}>
        {originAt ? <line
          x1={toSvg(originAt).x} y1={toSvg(originAt).y} x2={x} y2={y}
          className="offline-map-thread"
        /> : null}
        <circle
          cx={x} cy={y} r={point.index ? 10 : 7}
          fill={point.muted ? "var(--surface)" : colour}
          stroke={colour} strokeWidth="2"
          strokeDasharray={point.approximate ? "3 2.5" : undefined}
        />
        {point.index ? <text x={x} y={y + 3.5} className="offline-map-index" textAnchor="middle" fill={point.muted ? colour : "var(--ink-text)"}>
          {point.index}
        </text> : null}
        {labelled ? <text
          // Pulled back from the edges: a pin can sit against the side of the box, and a centred
          // label on it would run off and be cut in half.
          x={Math.min(Math.max(x, 44), VIEW_WIDTH - 44)}
          y={y - (point.index ? 15 : 12)}
          className="offline-map-label"
          textAnchor="middle"
        >{point.label}</text> : null}
      </g>;
    })}

    <g transform={`translate(${PADDING - 12}, ${height - 12})`}>
      <line x1="0" y1="0" x2={barWidth} y2="0" className="offline-map-bar" />
      <line x1="0" y1="-3.5" x2="0" y2="3.5" className="offline-map-bar" />
      <line x1={barWidth} y1="-3.5" x2={barWidth} y2="3.5" className="offline-map-bar" />
      <text x={barWidth + 6} y="3.5" className="offline-map-scale">{distanceLabel(barMetres)}</text>
    </g>
    <text x={VIEW_WIDTH - 10} y="16" className="offline-map-compass" textAnchor="end">N ↑</text>
  </svg>;
}
