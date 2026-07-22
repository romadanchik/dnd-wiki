export interface MapPageOptions {
  /** Where the baked tiles/manifest live, relative to the site root (no leading slash). */
  dataPath?: string;
  /** Frontmatter flag that turns a note into the map page. */
  frontmatterFlag?: string;
  /** How far past the native tile resolution the viewer may zoom in. */
  maxOverzoom?: number;
}

export const defaultMapPageOptions: Required<MapPageOptions> = {
  dataPath: "static/map",
  frontmatterFlag: "map-page",
  maxOverzoom: 4,
};
