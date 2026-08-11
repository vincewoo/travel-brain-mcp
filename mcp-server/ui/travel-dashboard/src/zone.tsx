import React, { createContext, useContext } from "react";
import { browserZone } from "../../shared/format";

/**
 * The zone every instant in the dashboard is rendered in. It is the trip's own zone, so an
 * itinerary reads in the time of the place it happens in; it only falls back to the reader's
 * zone when the trip has none. Nothing outside this provider should reach for a zone itself.
 */
const ZoneContext = createContext<string>(browserZone());

export const ZoneProvider = ({ zone, children }: { zone: string; children: React.ReactNode }) =>
  <ZoneContext.Provider value={zone}>{children}</ZoneContext.Provider>;

export const useZone = () => useContext(ZoneContext);
