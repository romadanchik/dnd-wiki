import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import { defaultMapPageOptions, type MapPageOptions } from "../types";
import style from "./styles/map.scss";
// @ts-expect-error - inline script imported as string by esbuild loader
import script from "./scripts/map.inline.ts";

export default ((userOpts?: MapPageOptions) => {
  const opts = { ...defaultMapPageOptions, ...userOpts };

  const MapBody: QuartzComponent = (_props: QuartzComponentProps) => {
    const cfg = { dataPath: opts.dataPath, maxOverzoom: opts.maxOverzoom };
    return (
      <div class="map-viewer" data-cfg={JSON.stringify(cfg)}>
        <canvas class="map-canvas" />
        <div class="map-loading">Загрузка карты…</div>
        <div class="map-error" hidden>
          Не удалось загрузить карту
        </div>
        <div class="map-zoom-hud" aria-hidden="true"></div>
      </div>
    );
  };

  MapBody.css = style;
  MapBody.afterDOMLoaded = script;

  return MapBody;
}) satisfies QuartzComponentConstructor<MapPageOptions | undefined>;
