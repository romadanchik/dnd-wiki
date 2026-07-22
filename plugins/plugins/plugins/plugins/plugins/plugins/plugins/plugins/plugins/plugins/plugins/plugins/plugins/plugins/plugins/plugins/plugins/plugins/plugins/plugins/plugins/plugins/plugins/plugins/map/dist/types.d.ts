interface MapPageOptions {
    /** Where the baked tiles/manifest live, relative to the site root (no leading slash). */
    dataPath?: string;
    /** Frontmatter flag that turns a note into the map page. */
    frontmatterFlag?: string;
    /** How far past the native tile resolution the viewer may zoom in. */
    maxOverzoom?: number;
}
declare const defaultMapPageOptions: Required<MapPageOptions>;

export { type MapPageOptions, defaultMapPageOptions };
