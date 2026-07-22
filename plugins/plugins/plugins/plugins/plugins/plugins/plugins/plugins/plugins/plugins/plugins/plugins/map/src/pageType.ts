import type { QuartzPageTypePlugin, PageMatcher } from "@quartz-community/types";
import MapBody from "./components/MapBody";
import { defaultMapPageOptions, type MapPageOptions } from "./types";

// A regular vault note becomes the map page by carrying `map-page: true` in its
// frontmatter — it stays a real content note (listed in Explorer, slug/title
// managed from Obsidian), but renders through the full-viewport map frame.
export const MapPage: QuartzPageTypePlugin<MapPageOptions> = (userOpts?: MapPageOptions) => {
  const opts = { ...defaultMapPageOptions, ...userOpts };
  const Body = MapBody(opts);

  const matcher: PageMatcher = ({ fileData }) => {
    const fm = (fileData as { frontmatter?: Record<string, unknown> }).frontmatter;
    return fm?.[opts.frontmatterFlag] === true;
  };

  return {
    name: "MapPage",
    priority: 25, // above canvas-page (20); content-page stays the catch-all
    match: matcher,
    layout: "map",
    frame: "map",
    body: () => Body,
  };
};
