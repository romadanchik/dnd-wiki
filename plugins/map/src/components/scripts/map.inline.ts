// Canvas-2D viewer for the pre-baked map: slippy tiles (terrain+roads baked by
// map-editor) under a vector overlay (marker sprites + labels drawn from
// vectors.json, so text stays crisp at any zoom and markers can become
// clickable later — see hitList). Camera / sprite / label math is ported from
// map-editor (view/camera.js, vec/markers.js, vec/labels.js).

interface LevelInfo {
  scale: number;
  cols: number;
  rows: number;
  tiles: string[];
}

interface MapManifest {
  version: string;
  format: string;
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  nativeScale: number;
  world: { bbox: [number, number, number, number]; originX: number; originY: number };
  background: { waterColor: number[]; waterTilePx: number };
  levels: Record<string, LevelInfo>;
  assets: {
    vectors: string;
    atlas: string;
    atlasImage: string;
    water: string | null;
    font: string | null;
  };
}

interface SpriteMeta {
  uv: [number, number, number, number];
  pw: number;
  ph: number;
  radius: number;
  offset_y: number;
}

interface MarkerV {
  x: number;
  y: number;
  type: string;
  tex: string;
  radius: number;
  scale: [number, number];
  rot: number;
  tint: number[] | null;
  link: string | null;
}

interface LabelV {
  x: number;
  y: number;
  text: string;
  size: number;
  color: number[] | null;
  outline: number[] | null;
  align: number;
  rot: number;
  path: number | null;
  pathOffset: number;
  pathFlip: boolean;
}

interface VectorsFile {
  markers: MarkerV[];
  labels: LabelV[];
  paths: { id: number; pts: [number, number][] }[];
}

const DEG = Math.PI / 180;
const TILE_CACHE_MAX = 300;
const LINE_EM = 0.925; // ≈ (ascent+descent)/font_size * 0.8, matches the editor's spacing
const OUTLINE_EM = 0.12; // stroke width per font px (visual match for the SDF outline)
const FILL_DEFAULT = [0.16, 0.13, 0.13];
const OUTLINE_DEFAULT = [1.0, 0.92, 0.69];
const FONT_STACK = '"MapLabelFont", Georgia, "Times New Roman", serif';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const css3 = (c: number[]) =>
  `rgb(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)})`;
const col3 = (c: number[] | null | undefined, d: number[]) =>
  c && c.length >= 3 ? [c[0]!, c[1]!, c[2]!] : d;

// Camera in CSS px — straight port of map-editor view/camera.js.
class Camera {
  camX = 0;
  camY = 0;
  scale = 1;
  vw = 1;
  vh = 1;

  setViewport(w: number, h: number) {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
  }
  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.scale + this.camX, (sy - this.vh / 2) / this.scale + this.camY];
  }
  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.camX) * this.scale + this.vw / 2, (wy - this.camY) * this.scale + this.vh / 2];
  }
  zoomAt(sx: number, sy: number, f: number, min: number, max: number) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.scale = clamp(this.scale * f, min, max);
    this.camX = wx - (sx - this.vw / 2) / this.scale;
    this.camY = wy - (sy - this.vh / 2) / this.scale;
  }
  panByScreen(dx: number, dy: number) {
    this.camX -= dx / this.scale;
    this.camY -= dy / this.scale;
  }
  worldBounds(): [number, number, number, number] {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.vw, this.vh);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
}

interface TileEntry {
  state: "loading" | "ready" | "absent";
  bmp: ImageBitmap | null;
  used: number;
}

interface FlatLayout {
  kind: "flat";
  L: LabelV;
  lines: { text: string; width: number }[]; // widths in world px
  bbox: [number, number, number, number];
}

interface PathLayout {
  kind: "path";
  L: LabelV;
  chars: { ch: string; advW: number }[];
  widthW: number;
  curve: [number, number][];
  D: number[];
  total: number;
  bbox: [number, number, number, number];
}

type LabelLayout = FlatLayout | PathLayout;

class MapController {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  hud: HTMLElement | null;
  cam = new Camera();
  abort = new AbortController();
  man: MapManifest | null = null;
  vectors: VectorsFile | null = null;
  atlasMeta: { w: number; h: number; sprites: Record<string, SpriteMeta> } | null = null;
  atlasBmp: ImageBitmap | null = null;
  waterPattern: CanvasPattern | null = null;
  waterSize = 0;
  base = "";
  ver = "";
  minScale = 0.001;
  maxScale = 8;
  dirty = true;
  raf = 0;
  frameNo = 0;
  destroyed = false;
  tiles = new Map<string, TileEntry>();
  present: Map<number, Set<string>> = new Map();
  tintCache = new Map<string, HTMLCanvasElement>();
  markerOrder: MarkerV[] = [];
  labelLayouts: LabelLayout[] = [];
  hitList: { x: number; y: number; hw: number; hh: number; rot: number; marker: MarkerV }[] = [];
  pointers = new Map<number, { x: number; y: number }>();
  pinchDist = 0;
  resizeObs: ResizeObserver | null = null;
  fitted = false;

  constructor(root: HTMLElement, cfg: { dataPath: string; maxOverzoom: number }) {
    this.root = root;
    this.canvas = root.querySelector(".map-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.hud = root.querySelector(".map-zoom-hud");
    this.base = "/" + cfg.dataPath.replace(/^\/+|\/+$/g, "") + "/";
    this.maxOverzoomOpt = cfg.maxOverzoom || 4;
  }
  maxOverzoomOpt = 4;

  async start() {
    const sig = this.abort.signal;
    const man = (await (
      await fetch(this.base + "map.json", { cache: "no-cache", signal: sig })
    ).json()) as MapManifest;
    this.man = man;
    this.ver = encodeURIComponent(man.version || "");
    for (const [z, L] of Object.entries(man.levels)) this.present.set(+z, new Set(L.tiles));

    const v = "?v=" + this.ver;
    const jobs: Promise<unknown>[] = [];
    jobs.push(
      fetch(this.base + man.assets.vectors + v, { signal: sig })
        .then((r) => r.json())
        .then((j) => (this.vectors = j as VectorsFile)),
    );
    jobs.push(
      fetch(this.base + man.assets.atlas + v, { signal: sig })
        .then((r) => r.json())
        .then((j) => (this.atlasMeta = j as typeof this.atlasMeta)),
    );
    jobs.push(
      fetch(this.base + man.assets.atlasImage + v, { signal: sig })
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b))
        .then((bmp) => (this.atlasBmp = bmp)),
    );
    if (man.assets.water) {
      jobs.push(
        fetch(this.base + man.assets.water + v, { signal: sig })
          .then((r) => r.blob())
          .then((b) => createImageBitmap(b))
          .then((bmp) => this.buildWaterPattern(bmp))
          .catch(() => undefined),
      );
    }
    if (man.assets.font && typeof FontFace !== "undefined") {
      const ff = new FontFace("MapLabelFont", `url("${this.base}${man.assets.font}${v}")`);
      jobs.push(
        ff
          .load()
          .then((f) => (document.fonts as unknown as { add(f: FontFace): void }).add(f))
          .catch(() => undefined),
      );
    }
    await Promise.all(jobs);
    if (this.destroyed) return;

    this.prepareVectors();
    this.setupInput();
    this.setupResize();
    this.fitView();
    (this.root.querySelector(".map-loading") as HTMLElement | null)?.setAttribute("hidden", "");
    this.requestRender();
  }

  showError(err: unknown) {
    console.error("map viewer failed", err);
    (this.root.querySelector(".map-loading") as HTMLElement | null)?.setAttribute("hidden", "");
    (this.root.querySelector(".map-error") as HTMLElement | null)?.removeAttribute("hidden");
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    for (const e of this.tiles.values()) e.bmp?.close();
    this.tiles.clear();
    this.atlasBmp?.close();
    this.root.dataset.initialized = "false";
  }

  // ---- assets ----
  buildWaterPattern(bmp: ImageBitmap) {
    const man = this.man!;
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const cx = c.getContext("2d")!;
    cx.drawImage(bmp, 0, 0);
    cx.globalCompositeOperation = "multiply";
    cx.fillStyle = css3(man.background.waterColor || [0.85, 0.92, 1.0]);
    cx.fillRect(0, 0, c.width, c.height);
    cx.globalCompositeOperation = "destination-in";
    cx.drawImage(bmp, 0, 0);
    this.waterSize = bmp.width;
    this.waterPattern = this.ctx.createPattern(c, "repeat");
    bmp.close();
  }

  // Tinted sprite bitmap for mountains (colour of the terrain at their foot,
  // baked at export time): sprite * tint, alpha preserved. Cached per tex+tint.
  tintedSprite(meta: SpriteMeta, tint: number[]): HTMLCanvasElement | null {
    if (!this.atlasBmp || !this.atlasMeta) return null;
    const q = (x: number) => Math.round(clamp(x, 0, 1) * 15);
    const key = meta.uv.join(",") + "|" + q(tint[0]!) + "," + q(tint[1]!) + "," + q(tint[2]!);
    let c = this.tintCache.get(key);
    if (c) return c;
    const [sx, sy] = this.atlasSrc(meta);
    c = document.createElement("canvas");
    c.width = meta.pw;
    c.height = meta.ph;
    const cx = c.getContext("2d")!;
    cx.drawImage(this.atlasBmp, sx, sy, meta.pw, meta.ph, 0, 0, meta.pw, meta.ph);
    cx.globalCompositeOperation = "multiply";
    cx.fillStyle = css3(tint);
    cx.fillRect(0, 0, meta.pw, meta.ph);
    cx.globalCompositeOperation = "destination-in";
    cx.drawImage(this.atlasBmp, sx, sy, meta.pw, meta.ph, 0, 0, meta.pw, meta.ph);
    if (this.tintCache.size > 512) this.tintCache.clear();
    this.tintCache.set(key, c);
    return c;
  }

  atlasSrc(meta: SpriteMeta): [number, number] {
    const m = this.atlasMeta!;
    return [Math.round(meta.uv[0] * m.w - 0.5), Math.round(meta.uv[1] * m.h - 0.5)];
  }

  // ---- overlay preparation (layouts measured once, in world px) ----
  prepareVectors() {
    const vec = this.vectors;
    if (!vec) return;
    this.markerOrder = (vec.markers || [])
      .filter((m) => this.atlasMeta?.sprites?.[m.tex])
      .slice()
      .sort((a, b) => a.y - b.y);

    const pathById = new Map<number, [number, number][]>();
    for (const p of vec.paths || []) pathById.set(p.id, p.pts);

    const meas = document.createElement("canvas").getContext("2d")!;
    this.labelLayouts = [];
    for (const L of vec.labels || []) {
      const size = Math.max(8, +L.size || 24);
      meas.font = `${size}px ${FONT_STACK}`;
      if (L.path != null && pathById.has(L.path)) {
        const raw = pathById.get(L.path)!;
        if (raw.length < 2) continue;
        const txt = (L.text || "").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        // orientation: keep text readable (same heuristic as the editor)
        let curve = raw;
        const n = raw.length;
        const sdx = raw[n - 1]![0] - raw[0]![0];
        const sdy = raw[n - 1]![1] - raw[0]![1];
        const autoFlip = Math.abs(sdx) >= Math.abs(sdy) ? sdx < 0 : sdy > 0;
        if (autoFlip !== !!L.pathFlip) curve = raw.slice().reverse();
        const D = [0];
        for (let i = 1; i < curve.length; i++)
          D.push(
            D[i - 1]! + Math.hypot(curve[i]![0] - curve[i - 1]![0], curve[i]![1] - curve[i - 1]![1]),
          );
        const total = D[D.length - 1]!;
        if (total <= 0) continue;
        const chars = Array.from(txt).map((ch) => ({ ch, advW: meas.measureText(ch).width }));
        const widthW = chars.reduce((a, c) => a + c.advW, 0);
        let bx0 = Infinity,
          by0 = Infinity,
          bx1 = -Infinity,
          by1 = -Infinity;
        for (const p of curve) {
          bx0 = Math.min(bx0, p[0]);
          by0 = Math.min(by0, p[1]);
          bx1 = Math.max(bx1, p[0]);
          by1 = Math.max(by1, p[1]);
        }
        const m = size * 2 + Math.abs(+L.pathOffset || 0);
        this.labelLayouts.push({
          kind: "path",
          L,
          chars,
          widthW,
          curve,
          D,
          total,
          bbox: [bx0 - m, by0 - m, bx1 + m, by1 + m],
        });
      } else {
        const lines = (L.text || "")
          .split("\n")
          .map((t) => ({ text: t, width: meas.measureText(t).width }));
        if (!lines.some((l) => l.text.trim())) continue;
        const wmax = Math.max(...lines.map((l) => l.width));
        const h = lines.length * size * LINE_EM;
        const m = Math.hypot(wmax, h); // rotation-safe margin
        this.labelLayouts.push({
          kind: "flat",
          L,
          lines,
          bbox: [L.x - m, L.y - m, L.x + m, L.y + m],
        });
      }
    }
  }

  // ---- view ----
  fitView() {
    const man = this.man!;
    const [x0, y0, x1, y1] = man.world.bbox;
    const w = x1 - x0,
      h = y1 - y0;
    const fit = Math.min(this.cam.vw / w, this.cam.vh / h) * 0.9;
    this.minScale = fit * 0.9;
    this.maxScale = man.nativeScale * this.maxOverzoomOpt;
    this.cam.camX = (x0 + x1) / 2;
    this.cam.camY = (y0 + y1) / 2;
    this.cam.scale = clamp(fit, this.minScale, this.maxScale);
    this.fitted = true;
  }

  clampPan() {
    const man = this.man!;
    const [x0, y0, x1, y1] = man.world.bbox;
    const mx = (x1 - x0) * 0.25,
      my = (y1 - y0) * 0.25;
    this.cam.camX = clamp(this.cam.camX, x0 - mx, x1 + mx);
    this.cam.camY = clamp(this.cam.camY, y0 - my, y1 + my);
  }

  setupResize() {
    const apply = () => {
      const r = this.root.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.cam.setViewport(w, h);
      if (!this.fitted && this.man) this.fitView();
      else if (this.man) {
        const [bx0, by0, bx1, by1] = this.man.world.bbox;
        this.minScale =
          Math.min(this.cam.vw / (bx1 - bx0), this.cam.vh / (by1 - by0)) * 0.81;
      }
      this.requestRender();
    };
    apply();
    this.resizeObs = new ResizeObserver(apply);
    this.resizeObs.observe(this.root);
  }

  setupInput() {
    const sig = this.abort.signal;
    const cv = this.canvas;
    const pos = (e: PointerEvent | WheelEvent | MouseEvent): [number, number] => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    cv.addEventListener(
      "pointerdown",
      (e) => {
        cv.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        }
      },
      { signal: sig },
    );
    cv.addEventListener(
      "pointermove",
      (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        if (this.pointers.size === 1) {
          this.cam.panByScreen(e.clientX - p.x, e.clientY - p.y);
          this.clampPan();
          this.requestRender();
        }
        p.x = e.clientX;
        p.y = e.clientY;
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          if (this.pinchDist > 0 && d > 0) {
            const r = cv.getBoundingClientRect();
            const cx = (a!.x + b!.x) / 2 - r.left;
            const cy = (a!.y + b!.y) / 2 - r.top;
            this.cam.zoomAt(cx, cy, d / this.pinchDist, this.minScale, this.maxScale);
            this.clampPan();
            this.requestRender();
          }
          this.pinchDist = d;
        }
      },
      { signal: sig },
    );
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinchDist = 0;
    };
    cv.addEventListener("pointerup", up, { signal: sig });
    cv.addEventListener("pointercancel", up, { signal: sig });

    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [sx, sy] = pos(e);
        this.cam.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0012), this.minScale, this.maxScale);
        this.clampPan();
        this.requestRender();
      },
      { passive: false, signal: sig },
    );
    cv.addEventListener(
      "dblclick",
      (e) => {
        const [sx, sy] = pos(e);
        this.cam.zoomAt(sx, sy, 2, this.minScale, this.maxScale);
        this.clampPan();
        this.requestRender();
      },
      { signal: sig },
    );
  }

  // ---- tiles ----
  tileKey(z: number, x: number, y: number) {
    return z + "/" + x + "_" + y;
  }

  getTile(z: number, x: number, y: number): TileEntry {
    const key = this.tileKey(z, x, y);
    let e = this.tiles.get(key);
    if (e) {
      e.used = this.frameNo;
      return e;
    }
    e = { state: "loading", bmp: null, used: this.frameNo };
    this.tiles.set(key, e);
    const man = this.man!;
    const url = `${this.base}tiles/${z}/${x}_${y}.${man.format}?v=${this.ver}`;
    fetch(url, { signal: this.abort.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("" + r.status))))
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        if (this.tiles.get(key) !== e || this.destroyed) {
          bmp.close();
          return;
        }
        e!.bmp = bmp;
        e!.state = "ready";
        this.requestRender();
      })
      .catch(() => {
        if (this.tiles.get(key) === e) e!.state = "absent";
      });
    this.evictTiles();
    return e;
  }

  evictTiles() {
    if (this.tiles.size <= TILE_CACHE_MAX) return;
    const cand = [...this.tiles.entries()]
      .filter(([, e]) => e.used !== this.frameNo)
      .sort((a, b) => a[1].used - b[1].used);
    let over = this.tiles.size - TILE_CACHE_MAX;
    for (const [k, e] of cand) {
      if (over <= 0) break;
      e.bmp?.close();
      this.tiles.delete(k);
      over--;
    }
  }

  // ---- render ----
  requestRender() {
    this.dirty = true;
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.dirty && !this.destroyed) {
          this.dirty = false;
          this.render();
        }
      });
    }
  }

  render() {
    const man = this.man;
    if (!man) return;
    this.frameNo++;
    const ctx = this.ctx;
    const cam = this.cam;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // 1) ocean everywhere (matches the baked tiles' water: texture * waterColor)
    if (this.waterPattern && this.waterSize > 0) {
      const [ox, oy] = cam.worldToScreen(0, 0);
      const k = (cam.scale * man.background.waterTilePx) / this.waterSize;
      this.waterPattern.setTransform(new DOMMatrix().translate(ox, oy).scale(k));
      ctx.fillStyle = this.waterPattern;
    } else {
      ctx.fillStyle = css3(man.background.waterColor || [0.85, 0.92, 1.0]);
    }
    ctx.fillRect(0, 0, cam.vw, cam.vh);

    // 2) tiles of the level whose scale is >= camera scale (downscale, never blur up
    //    except past native where overzoom is intended)
    const rel = Math.log2(cam.scale / man.nativeScale);
    const z = clamp(man.maxZoom + Math.ceil(rel - 0.001), man.minZoom, man.maxZoom);
    this.drawTiles(z);

    // 3) markers + labels (vector overlay)
    this.drawMarkers();
    this.drawLabels();

    if (this.hud) this.hud.textContent = Math.round((cam.scale / man.nativeScale) * 100) + "%";
  }

  drawTiles(z: number) {
    const man = this.man!;
    const cam = this.cam;
    const ctx = this.ctx;
    const L = man.levels[String(z)];
    if (!L) return;
    const T = man.tileSize;
    const Tw = T / L.scale; // world px per tile
    const ox = man.world.originX,
      oy = man.world.originY;
    const b = cam.worldBounds();
    const tx0 = clamp(Math.floor((b[0] - ox) / Tw), 0, L.cols - 1);
    const ty0 = clamp(Math.floor((b[1] - oy) / Tw), 0, L.rows - 1);
    const tx1 = clamp(Math.floor((b[2] - ox) / Tw), 0, L.cols - 1);
    const ty1 = clamp(Math.floor((b[3] - oy) / Tw), 0, L.rows - 1);
    const present = this.present.get(z);
    if (!present) return;

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!present.has(tx + "_" + ty)) continue; // pure ocean — background already there
        const wx0 = ox + tx * Tw,
          wy0 = oy + ty * Tw;
        const [sxA, syA] = cam.worldToScreen(wx0, wy0);
        const [sxB, syB] = cam.worldToScreen(wx0 + Tw, wy0 + Tw);
        const dx = Math.round(sxA),
          dy = Math.round(syA);
        const dw = Math.round(sxB) - dx,
          dh = Math.round(syB) - dy;

        const e = this.getTile(z, tx, ty);
        if (e.state === "ready" && e.bmp) {
          ctx.drawImage(e.bmp, dx, dy, dw, dh);
          continue;
        }
        // fallback: nearest loaded ancestor's sub-rect (classic slippy behaviour)
        for (let d = 1; d <= z - man.minZoom; d++) {
          const pz = z - d;
          const ptx = tx >> d,
            pty = ty >> d;
          if (!this.present.get(pz)?.has(ptx + "_" + pty)) break; // ancestors of ocean are ocean
          const pe = d <= 2 ? this.getTile(pz, ptx, pty) : this.tiles.get(this.tileKey(pz, ptx, pty));
          if (pe && pe.state === "ready" && pe.bmp) {
            const sub = T / (1 << d);
            const sx = (tx - (ptx << d)) * sub;
            const sy = (ty - (pty << d)) * sub;
            ctx.drawImage(pe.bmp, sx, sy, sub, sub, dx, dy, dw, dh);
            break;
          }
        }
      }
    }
    this.evictTiles();
  }

  drawMarkers() {
    const cam = this.cam;
    const ctx = this.ctx;
    const meta = this.atlasMeta;
    if (!meta || !this.atlasBmp) return;
    this.hitList = [];
    const b = cam.worldBounds();
    for (const s of this.markerOrder) {
      const sm = meta.sprites[s.tex]!;
      // sizing math from vec/markers.js emitSprite
      const scx = s.scale?.[0] ?? 1,
        scy = s.scale?.[1] ?? 1;
      const symR = s.radius || 32;
      const setR = sm.radius || symR;
      const k = setR ? symR / setR : 1;
      const dw = sm.pw * k * scx,
        dh = sm.ph * k * scy;
      const margin = Math.max(dw, dh);
      if (s.x + margin < b[0] || s.x - margin > b[2] || s.y + margin < b[1] || s.y - margin > b[3])
        continue;
      const offX = -dw / 2;
      const offY = -dh / 2 + (sm.offset_y || 0) * k * scy;
      const [px, py] = cam.worldToScreen(s.x, s.y);

      let src: CanvasImageSource = this.atlasBmp;
      let sx = 0,
        sy = 0;
      if (s.type === "mountain" && s.tint) {
        const tinted = this.tintedSprite(sm, s.tint);
        if (tinted) src = tinted;
        else [sx, sy] = this.atlasSrc(sm);
      } else {
        [sx, sy] = this.atlasSrc(sm);
      }

      ctx.save();
      ctx.translate(px, py);
      if (s.rot) ctx.rotate(s.rot * DEG);
      ctx.scale(cam.scale, cam.scale);
      if (src === this.atlasBmp) {
        ctx.drawImage(this.atlasBmp, sx, sy, sm.pw, sm.ph, offX, offY, dw, dh);
      } else {
        ctx.drawImage(src, 0, 0, sm.pw, sm.ph, offX, offY, dw, dh);
      }
      ctx.restore();

      // screen-space hit rect — the seam for future clickable POI links (marker.link)
      this.hitList.push({
        x: px,
        y: py + (offY + dh / 2) * cam.scale,
        hw: (dw / 2) * cam.scale,
        hh: (dh / 2) * cam.scale,
        rot: (s.rot || 0) * DEG,
        marker: s,
      });
    }
  }

  drawLabels() {
    const cam = this.cam;
    const ctx = this.ctx;
    const b = cam.worldBounds();
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (const lay of this.labelLayouts) {
      if (lay.bbox[2] < b[0] || lay.bbox[0] > b[2] || lay.bbox[3] < b[1] || lay.bbox[1] > b[3])
        continue;
      const L = lay.L;
      const size = Math.max(8, +L.size || 24);
      const fontPx = size * cam.scale;
      if (fontPx < 4) continue; // unreadable at this zoom — declutter
      ctx.font = `${fontPx}px ${FONT_STACK}`;
      ctx.fillStyle = css3(col3(L.color, FILL_DEFAULT));
      ctx.strokeStyle = css3(col3(L.outline, OUTLINE_DEFAULT));
      ctx.lineWidth = Math.max(1, fontPx * OUTLINE_EM);
      if (lay.kind === "flat") this.drawFlatLabel(lay, size);
      else this.drawPathLabel(lay, size);
    }
  }

  drawFlatLabel(lay: FlatLayout, size: number) {
    const cam = this.cam;
    const ctx = this.ctx;
    const L = lay.L;
    const lhW = size * LINE_EM; // world px between lines
    const n = lay.lines.length;
    const align = L.align == null ? 1 : L.align;
    const [ax, ay] = cam.worldToScreen(L.x, L.y);
    ctx.save();
    ctx.translate(ax, ay);
    if (L.rot) ctx.rotate(L.rot * DEG);
    ctx.textAlign = "left";
    for (let k = 0; k < n; k++) {
      const line = lay.lines[k]!;
      if (!line.text.trim()) continue;
      const startW = align === 0 ? 0 : align === 2 ? -line.width : -line.width / 2;
      const cyW = -lhW * (n / 2) + (k + 0.5) * lhW;
      const x = startW * cam.scale;
      const y = cyW * cam.scale;
      ctx.strokeText(line.text, x, y);
      ctx.fillText(line.text, x, y);
    }
    ctx.restore();
  }

  drawPathLabel(lay: PathLayout, size: number) {
    const cam = this.cam;
    const ctx = this.ctx;
    const L = lay.L;
    const perpScr = -(+L.pathOffset || 0) * cam.scale; // +offset lifts text off the line
    let s = lay.total / 2 - lay.widthW / 2;
    const sample = this.pathSampler(lay.curve, lay.D, lay.total);
    ctx.textAlign = "center";
    for (const { ch, advW } of lay.chars) {
      if (ch !== " ") {
        const [wx, wy, tx, ty] = sample(s + advW / 2);
        const [px, py] = cam.worldToScreen(wx, wy);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.atan2(ty, tx));
        ctx.strokeText(ch, 0, perpScr);
        ctx.fillText(ch, 0, perpScr);
        ctx.restore();
      }
      s += advW;
    }
  }

  // Resumable arc-length sampler — port of vec/labels.js _sampler.
  pathSampler(curve: [number, number][], D: number[], total: number) {
    const n = curve.length;
    let cur = 1;
    return (q: number): [number, number, number, number] => {
      if (q <= 0) {
        const dx = curve[1]![0] - curve[0]![0],
          dy = curve[1]![1] - curve[0]![1],
          l = Math.hypot(dx, dy) || 1;
        return [curve[0]![0] + (dx / l) * q, curve[0]![1] + (dy / l) * q, dx / l, dy / l];
      }
      if (q >= total) {
        const dx = curve[n - 1]![0] - curve[n - 2]![0],
          dy = curve[n - 1]![1] - curve[n - 2]![1],
          l = Math.hypot(dx, dy) || 1;
        return [
          curve[n - 1]![0] + (dx / l) * (q - total),
          curve[n - 1]![1] + (dy / l) * (q - total),
          dx / l,
          dy / l,
        ];
      }
      while (cur < n - 1 && D[cur]! < q) cur++;
      while (cur > 1 && D[cur - 1]! > q) cur--;
      const a = curve[cur - 1]!,
        c = curve[cur]!;
      const seg = D[cur]! - D[cur - 1]! || 1,
        t = (q - D[cur - 1]!) / seg;
      const dx = c[0] - a[0],
        dy = c[1] - a[1],
        l = Math.hypot(dx, dy) || 1;
      return [a[0] + dx * t, a[1] + dy * t, dx / l, dy / l];
    };
  }
}

// ---- lifecycle (SPA-safe: single controller, torn down on nav) ----
let active: MapController | null = null;

function initMap() {
  const root = document.querySelector(".map-viewer") as HTMLElement | null;
  if (!root) {
    if (active) {
      active.destroy();
      active = null;
    }
    return;
  }
  if (root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  if (active) active.destroy();

  let cfg: { dataPath: string; maxOverzoom: number };
  try {
    cfg = JSON.parse(root.dataset.cfg || "{}");
  } catch {
    cfg = { dataPath: "static/map", maxOverzoom: 4 };
  }
  const controller = new MapController(root, {
    dataPath: cfg.dataPath || "static/map",
    maxOverzoom: cfg.maxOverzoom || 4,
  });
  active = controller;
  controller.start().catch((err) => {
    if (!controller.destroyed) controller.showError(err);
  });

  // sidebar toggle (Explorer/search/darkmode live behind it on this page)
  const page = document.querySelector('.page[data-frame="map"]');
  const toggle = document.querySelector(".map-sidebar-toggle");
  if (page && toggle) {
    const onToggle = () => page.classList.toggle("map-sidebar-open");
    toggle.addEventListener("click", onToggle, { signal: controller.abort.signal });
  }

  if (typeof window !== "undefined" && window.addCleanup) {
    window.addCleanup(() => {
      if (active === controller) active = null;
      controller.destroy();
    });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("nav", initMap);
  document.addEventListener("render", initMap);
  initMap();
}
