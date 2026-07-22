import { QuartzPageTypePlugin } from '@quartz-community/types';
import { MapPageOptions } from './types.js';
export { MapBody } from './components/index.js';
export { MapFrame } from './frames/index.js';

declare const MapPage: QuartzPageTypePlugin<MapPageOptions>;

export { MapPage, MapPageOptions };
