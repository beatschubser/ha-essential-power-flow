/*
 * Essential Power Flow for Home Assistant
 *
 * Shows the current power flow between solar, battery, grid and home as a
 * Sankey diagram, with optional devices (in a list or as own nodes), a battery
 * badge and a yield bar. Configured in the visual editor or in YAML.
 *
 * Structure of this file
 *   1. Constants: defaults, fixed values, typography, geometry, translations
 *   2. Pure helpers: escaping, flow allocation, bezier sampling
 *   3. The card element
 *      - lifecycle (config, hass, connect/disconnect)
 *      - reading states into a model
 *      - building the scene (nodes, flows, list, badge, yield bar)
 *      - transitions between scenes
 *      - drawing one frame (bands, node bars, labels, dots)
 *      - tap actions
 *   4. Visual editor
 *   5. Styles and registration
 */

const EPF_VERSION = "0.11.0";

/* ---------- 1. constants ---------- */

/* Defaults of the top-level options (see README). Per-node options default to empty. */
const EPF_DEFAULTS = {
  max_power: 2000, // W; bands reach full height and dots full speed here
  power_unit: "auto", // auto | W | kW
  card_height: 372, // px
  min_node_height: 24, // px; small nodes are widened to stay visible, 0 = strictly proportional
  transition_duration: 600, // ms; fade between two states, 0 = off
  font_scale: 1, // factor for all font sizes
  badge_position: "top-right", // top-right | top-left
  badge_background: false, // grey pill behind the battery badge
};

/* Values that are rarely changed, kept in one place instead of being options. */
const EPF_FIXED = {
  kiloThreshold: 1000, // power_unit auto: from here on kW
  wattDecimals: 0,
  kiloDecimals: 1,
  socDecimals: 0,
  yieldDecimals: 1,
  transitionThreshold: 50, // W; smaller changes only update the numbers
  minFlowHeight: 60, // px; band area at very small power
  minFlowRate: 0.75, // s per band at max_power
  maxFlowRate: 6, // s per band at very small power
  forecastSeconds: 10, // the forecast in the yield bar falls back to the yield after this
  badgeGap: 12, // px between battery badge and the labels below it
};

/* Font sizes in px (multiplied by font_scale) and weights, following the kiosk design rules. */
const EPF_FONT = {
  value: 18, // power values at the nodes, battery badge
  unit: 14, // units next to values
  name: 12, // node names (only when a name is set)
  ghost: 14, // value of an idle home node
  deviceName: 14,
  deviceValue: 14,
  yieldLabel: 14,
  yieldValue: 18,
  yieldUnit: 14,
  valueWeight: 300,
  textWeight: 300,
  labelWeight: 400,
};

/* Fixed drawing measures in px (or fractions of the card width). */
const EPF_GEOMETRY = {
  nodeGap: 14, // vertical gap between two nodes on one side
  ghostHeight: 3, // height of an idle node (home without power)
  minBand: 2, // minimum band thickness
  nodeWidth: 6, // width of a node bar
  minFlowArea: 40, // lower limit for the band area when scaling
  leftColumn: 0.3, // x of the left node bars
  rightColumn: 0.7, // x of the right node bars
  labelOffset: 8, // distance between node bar and label
  dotSpacing: 55, // distance between two dots on a band
  dotSamples: 24, // points per band for the dot path
};

/* Top-to-bottom order on each side. Battery and grid sit on the side of their current direction.
   Devices shown as nodes sit between home and battery (see _buildNodes). */
const EPF_ORDER = { solar: 0, batOut: 1, gridIn: 2, home: 0, batIn: 1, gridOut: 2 };

/* All possible bands: [source node, target node, key in the allocation result] */
const EPF_LINKS = [
  ["solar", "home", "solarToHome"],
  ["solar", "batIn", "solarToBattery"],
  ["solar", "gridOut", "solarToGrid"],
  ["batOut", "home", "batteryToHome"],
  ["batOut", "gridOut", "batteryToGrid"],
  ["gridIn", "home", "gridToHome"],
  ["gridIn", "batIn", "gridToBattery"],
];

const EPF_COLORS = {
  solar: "var(--energy-solar-color, #ff9800)",
  gridIn: "var(--energy-grid-consumption-color, #488fc2)",
  gridOut: "var(--energy-grid-return-color, #8353d1)",
  batOut: "var(--energy-battery-out-color, #4db6ac)",
  batIn: "var(--energy-battery-in-color, #f06292)",
  home: "var(--secondary-text-color, #9aa0a6)",
};
const EPF_DEVICE_COLORS = ["#d0cc5b", "#964cb5", "#b54c9d", "#5bd0cc", "#e07a5f", "#7ab0d0", "#a3c95b", "#d08a5b"];
const EPF_UNIT_PREFIXES = ["K", "M", "G", "T"];
const EPF_THIN_SPACE = " ";

const EPF_I18N = {
  de: {
    solar: "Solar", grid: "Netz", battery: "Batterie", home: "Haus", yield: "Ertrag heute", forecast: "Prognose morgen",
    setup: "Bitte im Editor mindestens einen Sensor für Solar, Batterie oder Netz wählen.",
  },
  en: {
    solar: "Solar", grid: "Grid", battery: "Battery", home: "Home", yield: "Yield today", forecast: "Forecast tomorrow",
    setup: "Please pick at least one sensor for solar, battery or grid in the editor.",
  },
};

/* ---------- 2. pure helpers ---------- */

const epfEsc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const epfClamp = (v, min, max) => Math.min(Math.max(v, min), max);

const epfSocIcon = (soc) =>
  soc === null ? "mdi:battery" : soc > 72 ? "mdi:battery-high" : soc > 44 ? "mdi:battery-medium" : soc > 16 ? "mdi:battery-low" : "mdi:battery-outline";

/* Sources (solar, battery, grid) fill targets (home, battery, grid) top to bottom.
   This "north-west corner" assignment never produces crossing bands. */
function epfAllocate(solar, batOut, fromGrid, cons, batIn, toGrid) {
  const src = [solar, batOut, fromGrid];
  const dst = [cons, batIn, toGrid];
  const forbidden = (i, j) => (i === 1 && j === 1) || (i === 2 && j === 2); // battery to battery, grid to grid
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (forbidden(i, j)) continue;
      const v = Math.min(src[i], dst[j]);
      if (v > 0) {
        r[i][j] = v;
        src[i] -= v;
        dst[j] -= v;
      }
    }
  }
  return {
    solarToHome: r[0][0], solarToBattery: r[0][1], solarToGrid: r[0][2],
    batteryToHome: r[1][0], batteryToGrid: r[1][2],
    gridToHome: r[2][0], gridToBattery: r[2][1],
  };
}

/* Splits the power flowing into the home among parts (home rest, then devices shown as
   own nodes). Sources (solar, battery, grid) fill the parts top to bottom, so bands do not
   cross. Returns one [fromSolar, fromBattery, fromGrid] per part. */
function epfSplitHome(fromSources, parts) {
  const left = [...fromSources];
  return parts.map((need) => {
    const got = [0, 0, 0];
    for (let i = 0; i < left.length && need > 0; i++) {
      const v = Math.min(left[i], need);
      got[i] = v;
      left[i] -= v;
      need -= v;
    }
    return got;
  });
}

/* Points at equal arc length along a cubic bezier, so dots move at constant speed. */
function epfSampleBezier(p0, p1, p2, p3, count) {
  const at = (t) => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  const steps = 120;
  const raw = [at(0)];
  const len = [0];
  for (let i = 1; i <= steps; i++) {
    const pt = at(i / steps);
    const prev = raw[i - 1];
    len.push(len[i - 1] + Math.hypot(pt[0] - prev[0], pt[1] - prev[1]));
    raw.push(pt);
  }
  const total = len[steps] || 1;
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    while (j < steps - 1 && len[j + 1] < target) j++;
    const seg = len[j + 1] - len[j] || 1;
    const f = epfClamp((target - len[j]) / seg, 0, 1);
    out.push([raw[j][0] + (raw[j + 1][0] - raw[j][0]) * f, raw[j][1] + (raw[j + 1][1] - raw[j][1]) * f]);
  }
  return out;
}

/* Position at phase (0..1) along sampled points. */
function epfPointAt(pts, phase) {
  const x = phase * (pts.length - 1);
  const j = Math.min(Math.floor(x), pts.length - 2);
  const t = x - j;
  return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t];
}

/* ---------- 3. the card ---------- */

class EssentialPowerFlowCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._uid = "epf" + Math.random().toString(36).slice(2, 8);
    this._width = 0;
    this._sig = null;
    this._actions = {};
    this._formatters = new Map();
  }

  /* ----- lifecycle ----- */

  /* new card from the card picker: the first matching sensors, adjustable in the editor */
  static getStubConfig(hass) {
    const ids = Object.keys(hass?.states || {});
    const find = (re) => ids.find((id) => id.startsWith("sensor.") && re.test(id)) || "";
    return { solar: { power: find(/(pv|solar).*(power|leistung)/) }, grid: { power: find(/grid.*(power|leistung)/) } };
  }

  static getConfigElement() {
    return document.createElement("essential-power-flow-card-editor");
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._watched = null;
    this._sig = null;
    this._shown = null;
    this._ensureShell();
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  get hass() {
    return this._hass;
  }

  /* masonry view: height in units of 50 px */
  getCardSize() {
    return Math.ceil(this._cardHeight() / 50);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    this._ensureShell();
    if (!this._ro && window.ResizeObserver) {
      this._ro = new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w && Math.abs(w - this._width) > 2) {
          this._width = w;
          this._sig = null;
          this._update();
        }
      });
      this._ro.observe(this);
    }
    if (!this._onVisibility) {
      /* app back from background: make sure nothing is left half-way */
      this._onVisibility = () => this._settle();
      document.addEventListener("visibilitychange", this._onVisibility);
    }
    this._settle();
  }

  disconnectedCallback() {
    this._stopForecast();
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._onVisibility) {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
    this._settle();
  }

  _ensureShell() {
    if (this._card) return;
    this.shadowRoot.innerHTML =
      `<style>${EssentialPowerFlowCard.styles}</style><ha-card><div class="main">` +
      `<div class="hint" hidden></div>` +
      `<div class="sankey"><svg class="flows" aria-hidden="true"></svg><div class="dots"></div><div class="labels"></div></div>` +
      `<div class="list" hidden></div><div class="yield" hidden></div>` +
      `<div class="badge"></div>` +
      `</div></ha-card>`;
    this._card = this.shadowRoot.querySelector("ha-card");
    this._main = this.shadowRoot.querySelector(".main");
    const q = (sel) => this.shadowRoot.querySelector(sel);
    this._parts = {
      hint: q(".hint"), sankey: q(".sankey"), svg: q("svg.flows"), dots: q(".dots"), labels: q(".labels"),
      list: q(".list"), yieldBar: q(".yield"), badge: q(".badge"),
    };
    this._main.addEventListener("click", (ev) => {
      const path = ev.composedPath();
      const el = path.find((n) => n.dataset && n.dataset.act);
      if (el) {
        this._handleClick(el.dataset.act);
        return;
      }
      /* yield bar with a forecast: tap switches to the forecast */
      if (this._config.solar?.forecast_tomorrow && path.includes(this._parts.yieldBar)) {
        this._toggleForecast();
        return;
      }
      /* card-wide tap_action: everywhere except the device list */
      if (path.includes(this._parts.list)) return;
      if (this._actions.card) this._handleClick("card");
    });
  }

  /* Re-render only when one of the watched entities, the width or the language changed. */
  _update() {
    if (!this._config || !this._hass || !this._card) return;
    if (!this._watched) this._watched = this._collectEntityIds();
    const sig =
      this._watched.map((id) => {
        const s = this._hass.states[id];
        return s ? `${s.state}|${s.attributes?.unit_of_measurement || ""}` : "-";
      }).join(";") + `@${this._width}|${this._lang()}`;
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  _collectEntityIds() {
    const c = this._config;
    const ids = [
      c.solar?.power, c.solar?.yield_today, c.solar?.forecast_tomorrow,
      c.battery?.power, c.battery?.soc,
      c.grid?.power,
      ...(c.devices || []).map((d) => d?.power),
    ];
    return ids.filter((id) => typeof id === "string" && id);
  }

  /* ----- options ----- */

  _opt(key) {
    const v = this._config[key];
    return v === undefined || v === null || v === "" ? EPF_DEFAULTS[key] : v;
  }

  /* numeric option; falls back to the default when invalid */
  _optNum(key, { min = -Infinity, max = Infinity, positive = false } = {}) {
    const v = Number(this._opt(key));
    if (!Number.isFinite(v) || (positive && v <= 0)) return EPF_DEFAULTS[key];
    return epfClamp(v, min, max);
  }

  _cardHeight() {
    return this._config ? this._optNum("card_height", { positive: true }) : EPF_DEFAULTS.card_height;
  }

  _transitionMs() {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduce ? 0 : this._optNum("transition_duration", { min: 0 });
  }

  _fontPx(key) {
    return EPF_FONT[key] * this._optNum("font_scale", { min: 0.5, max: 2 });
  }

  /* ----- reading states ----- */

  _lang() {
    return this._hass?.locale?.language || this._hass?.language || "en";
  }

  _t(key) {
    return (EPF_I18N[this._lang().slice(0, 2)] || EPF_I18N.en)[key];
  }

  /* state of one entity in W (kW, MW … are converted); 0 when unavailable */
  _watts(id) {
    const s = id ? this._hass.states[id] : null;
    const v = Number(s?.state);
    if (!s || !Number.isFinite(v)) return 0;
    const unit = String(s.attributes?.unit_of_measurement || "");
    const idx = EPF_UNIT_PREFIXES.indexOf(unit.toUpperCase().slice(0, 1));
    return idx > -1 ? v * Math.pow(1000, idx + 1) : v;
  }

  /* plain numeric state (percentages); null when unavailable */
  _number(id) {
    const v = Number(id ? this._hass.states[id]?.state : NaN);
    return Number.isFinite(v) ? v : null;
  }

  /* signed power of a node: positive = out of the node (grid import, battery discharge) */
  _signed(node) {
    const v = this._watts(node?.power);
    return node?.invert ? -v : v;
  }

  _min(node) {
    return Math.max(Number(node?.min_power) || 0, 0);
  }

  /* value below the node's min_power counts as 0 */
  _gate(v, node) {
    return v > 0 && v >= this._min(node) ? v : 0;
  }

  /* ----- formatting ----- */

  _numberFormat(decimals) {
    const key = `${this._lang()}|${decimals}`;
    let nf = this._formatters.get(key);
    if (!nf) {
      try {
        nf = new Intl.NumberFormat(this._lang(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      } catch (err) {
        nf = { format: (v) => v.toFixed(decimals) };
      }
      this._formatters.set(key, nf);
    }
    return nf;
  }

  /* power as [number, unit] following power_unit */
  _powerParts(v) {
    const mode = this._opt("power_unit");
    const isK = mode === "kW" || (mode !== "W" && Math.abs(v) >= EPF_FIXED.kiloThreshold);
    const d = isK ? EPF_FIXED.kiloDecimals : EPF_FIXED.wattDecimals;
    return [this._numberFormat(d).format(Math.abs(isK ? v / 1000 : v)), isK ? "kW" : "W"];
  }

  _fmt(v) {
    const [num, unit] = this._powerParts(v);
    return `${num}${EPF_THIN_SPACE}${unit}`;
  }

  /* like _fmt, with the unit in its own span (muted, smaller) */
  _fmtHtml(v) {
    const [num, unit] = this._powerParts(v);
    return `${num}<span class="unit">${EPF_THIN_SPACE}${unit}</span>`;
  }

  _socHtml(soc) {
    return `${this._numberFormat(EPF_FIXED.socDecimals).format(soc)}<span class="unit">${EPF_THIN_SPACE}%</span>`;
  }

  /* daily energy, shown in kWh (Wh is converted) */
  _fmtEnergy(id) {
    const so = id ? this._hass.states[id] : null;
    const v = Number(so?.state);
    if (!so || !Number.isFinite(v)) return null;
    let unit = String(so.attributes?.unit_of_measurement || "kWh");
    let val = v;
    if (unit === "Wh") {
      val = v / 1000;
      unit = "kWh";
    }
    return { num: this._numberFormat(EPF_FIXED.yieldDecimals).format(val), unit };
  }

  /* fonts as CSS variables on the card */
  _applyTypography() {
    const px = (k) => `${this._fontPx(k).toFixed(1)}px`;
    const vars = {
      "--epf-val-fs": px("value"),
      "--epf-unit-fs": px("unit"),
      "--epf-name-fs": px("name"),
      "--epf-ghost-fs": px("ghost"),
      "--epf-dev-nm-fs": px("deviceName"),
      "--epf-dev-v-fs": px("deviceValue"),
      "--epf-yl": px("yieldLabel"),
      "--epf-yv": px("yieldValue"),
      "--epf-yu": px("yieldUnit"),
      "--epf-val-fw": String(EPF_FONT.valueWeight),
      "--epf-text-fw": String(EPF_FONT.textWeight),
      "--epf-label-fw": String(EPF_FONT.labelWeight),
    };
    const css = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
    if (this._card.getAttribute("style") !== css) this._card.setAttribute("style", css);
  }

  /* seconds a dot needs for one band: fast at max_power, slow at small power */
  _flowRate(v) {
    const { minFlowRate: minR, maxFlowRate: maxR } = EPF_FIXED;
    const maxP = this._optNum("max_power", { positive: true });
    const r = v >= maxP ? minR : maxR - (v / maxP) * (maxR - minR);
    return Number.isFinite(r) && r > 0.1 ? r : maxR;
  }

  /* ----- forecast in the yield bar ----- */

  _toggleForecast() {
    const show = !this._forecastShown;
    this._stopForecast();
    this._forecastShown = show;
    if (show) this._forecastTimer = setTimeout(() => this._toggleForecast(), EPF_FIXED.forecastSeconds * 1000);
    if (this._parts) this._renderYield();
  }

  _stopForecast() {
    clearTimeout(this._forecastTimer);
    this._forecastTimer = null;
    this._forecastShown = false;
  }

  /* ----- model: what the sensors say, after min_power ----- */

  _readModel() {
    const c = this._config;
    const has = { grid: !!c.grid?.power, solar: !!c.solar?.power, battery: !!c.battery?.power };

    const grid = has.grid ? this._signed(c.grid) : 0;
    const fromGrid = this._gate(grid, c.grid);
    const toGrid = this._gate(-grid, c.grid);
    const solar = has.solar ? this._gate(this._watts(c.solar.power), c.solar) : 0;
    const bat = has.battery ? this._signed(c.battery) : 0;
    const batOut = this._gate(bat, c.battery);
    const batIn = this._gate(-bat, c.battery);
    const soc = c.battery?.soc ? this._number(c.battery.soc) : null;

    const consumption = Math.max(fromGrid + solar + batOut - toGrid - batIn, 0);
    const flows = epfAllocate(solar, batOut, fromGrid, consumption, batIn, toGrid);
    const home = flows.solarToHome + flows.batteryToHome + flows.gridToHome;

    /* devices: visible from their min_power on */
    const devices = (c.devices || [])
      .map((d, i) => {
        if (!d?.power) return null;
        const v = this._watts(d.power);
        if (v === 0 || Math.abs(v) < this._min(d)) return null;
        return {
          key: `dev${i}`, cfg: d, v,
          color: d.color || EPF_DEVICE_COLORS[i % EPF_DEVICE_COLORS.length],
          icon: d.icon || "mdi:flash",
          name: (d.name || "").trim(),
        };
      })
      .filter(Boolean);

    /* devices shown as node become own targets (in config order); the home keeps the rest */
    const nodeDevices = devices.filter((d) => d.cfg.as_node === true);
    const listDevices = devices.filter((d) => d.cfg.as_node !== true).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    let rest = home;
    for (const d of nodeDevices) {
      d.load = Math.min(Math.max(d.v, 0), rest);
      rest -= d.load;
    }
    if (nodeDevices.length) {
      const parts = epfSplitHome([flows.solarToHome, flows.batteryToHome, flows.gridToHome], [rest, ...nodeDevices.map((d) => d.load)]);
      [flows.solarToHome, flows.batteryToHome, flows.gridToHome] = parts[0];
      nodeDevices.forEach((d, i) => {
        [d.fromSolar, d.fromBattery, d.fromGrid] = parts[i + 1];
      });
    }

    return { has, fromGrid, toGrid, solar, batOut, batIn, soc, home: rest, devices: listDevices, nodeDevices, flows };
  }

  /* ----- scene: everything that is drawn, derived from the model ----- */

  _render() {
    this._actions = {};
    const c = this._config;
    const P = this._parts;
    const problem = !(c.solar?.power || c.battery?.power || c.grid?.power) ? "setup" : null;
    P.hint.textContent = problem ? this._t(problem) : "";
    P.hint.hidden = !problem;
    P.sankey.hidden = !!problem;
    if (problem) {
      for (const k of ["list", "yieldBar"]) P[k].hidden = true;
      P.badge.classList.remove("show");
      this._applyCardMode();
      return;
    }

    const m = this._readModel();
    const W = Math.max((this._width || this.getBoundingClientRect().width || 400) - 32, 240);

    const { left, right } = this._buildNodes(m);
    const links = EPF_LINKS.map(([s, t, key]) => [s, t, m.flows[key]]);
    for (const d of m.nodeDevices) links.push(["solar", d.key, d.fromSolar], ["batOut", d.key, d.fromBattery], ["gridIn", d.key, d.fromGrid]);
    const { L, R, flows } = this._linkNodes(left, right, links);

    this._renderBadge(m);
    this._renderStatic(m);
    this._applyCardMode();

    const target = this._buildTarget(L, R, flows, W);
    this._animateTo(target);
  }

  /* all candidate nodes in fixed order; which ones are shown is decided by _linkNodes */
  _buildNodes(m) {
    const c = this._config;
    const name = (node) => (node?.name || "").trim();
    const left = [];
    const right = [];

    if (m.has.solar) {
      left.push({ key: "solar", act: "solar", v: m.solar, color: EPF_COLORS.solar, cfg: c.solar, entity: c.solar.power,
        icon: c.solar.icon || "mdi:solar-power", name: name(c.solar) });
    }
    if (m.has.battery) {
      const b = c.battery;
      const icon = b.icon || epfSocIcon(m.soc);
      left.push({ key: "batOut", act: "battery", v: m.batOut, color: EPF_COLORS.batOut, cfg: b, entity: b.power, icon, name: name(b) });
      right.push({ key: "batIn", act: "battery", v: m.batIn, color: EPF_COLORS.batIn, cfg: b, entity: b.power, icon, name: name(b) });
    }
    if (m.has.grid) {
      const g = c.grid;
      const icon = g.icon || "mdi:transmission-tower";
      left.push({ key: "gridIn", act: "grid", v: m.fromGrid, color: EPF_COLORS.gridIn, cfg: g, entity: g.power, icon, name: name(g) });
      right.push({ key: "gridOut", act: "grid", v: m.toGrid, color: EPF_COLORS.gridOut, cfg: g, entity: g.power, icon, name: name(g) });
    }
    const h = c.home || {};
    right.unshift({ key: "home", act: "home", v: m.home, color: EPF_COLORS.home, cfg: h, entity: null,
      icon: h.icon || "mdi:home", name: name(h), forceShow: true });
    m.nodeDevices.forEach((d, i) => {
      right.splice(1 + i, 0, { key: d.key, act: d.key, v: d.load, color: d.color, cfg: d.cfg, entity: d.cfg.power,
        order: 0.5 + i / 100, icon: d.icon, name: d.name });
    });
    return { left, right };
  }

  /* links: [source key, target key, watts]. Bands need the min_power of both ends;
     nodes without a band disappear, only the home stays (as a grey line). */
  _linkNodes(left, right, links) {
    const byKey = {};
    for (const n of [...left, ...right]) {
      n.flows = [];
      byKey[n.key] = n;
    }
    const flows = [];
    for (const [s, t, v] of links) {
      if (!(v > 0) || !byKey[s] || !byKey[t]) continue;
      if (v < Math.max(this._min(byKey[s].cfg), this._min(byKey[t].cfg))) continue;
      const f = { s: byKey[s], t: byKey[t], v };
      flows.push(f);
      f.s.flows.push(f);
      f.t.flows.push(f);
    }
    const active = (n) => n.flows.length > 0;
    const L = left.filter(active);
    const R = right.filter((n) => active(n) || n.forceShow);
    for (const n of [...L, ...R]) n.ghost = !active(n);
    return { L, R, flows };
  }

  /* battery badge: icon and state of charge in a card corner, shown whenever battery.soc is set */
  _renderBadge(m) {
    const c = this._config;
    const B = this._parts.badge;
    const show = m.has.battery && m.soc !== null;
    B.classList.toggle("left", this._opt("badge_position") === "top-left");
    B.classList.toggle("bg", this._opt("badge_background") === true);
    B.style.setProperty("--epf-td", `${this._transitionMs()}ms`);
    if (show) {
      const clickable = this._bindAction("badge", c.battery, c.battery.soc);
      this._setHtml(B, `<ha-icon icon="${epfEsc(c.battery.icon || epfSocIcon(m.soc))}"></ha-icon><span>${this._socHtml(m.soc)}</span>`);
      if (clickable) B.dataset.act = "badge";
      else delete B.dataset.act;
      B.classList.toggle("clickable", clickable);
    }
    B.classList.toggle("show", show);
    this._badgeSide = show ? (B.classList.contains("left") ? "left" : "right") : null;
  }

  /* Room the labels on the badge side keep free at the top of the band area (in px from
     its top edge): badge bottom plus EPF_FIXED.badgeGap. 0 while the badge is hidden. */
  _badgeClearance() {
    if (!this._badgeSide) return 0;
    const B = this._parts.badge;
    if (!B.offsetHeight) return 0;
    return Math.max(0, B.offsetTop + B.offsetHeight + EPF_FIXED.badgeGap - this._parts.sankey.offsetTop);
  }

  /* device list and yield bar */
  _renderStatic(m) {
    const P = this._parts;
    this._applyTypography();

    let list = "";
    if (m.devices.length) {
      const base = Math.max(m.home, ...m.devices.map((d) => Math.abs(d.v)), 1);
      list = m.devices.map((d) => this._rowHtml(d, base)).join("");
    }
    this._setHtml(P.list, list);
    P.list.hidden = !list;

    this._renderYield();
  }

  /* yield bar: today's yield, or the forecast for a few seconds after a tap */
  _renderYield() {
    const s = this._config.solar || {};
    const P = this._parts;
    const y = s.yield_today ? this._fmtEnergy(s.yield_today) : null;
    const hasForecast = !!s.forecast_tomorrow;
    const fc = this._forecastShown && hasForecast ? this._fmtEnergy(s.forecast_tomorrow) : null;
    if (y) {
      const show = fc || y;
      const mode = fc ? "forecast" : "yield";
      const anim = this._yieldMode !== undefined && this._yieldMode !== mode; // fade only when switching
      this._yieldMode = mode;
      const icon = fc ? "mdi:weather-partly-cloudy" : "mdi:white-balance-sunny";
      P.yieldBar.classList.toggle("tappable", hasForecast);
      this._setHtml(P.yieldBar,
        `<span class="yswap${anim ? " anim" : ""}">` +
        `<ha-icon icon="${icon}" style="color:${EPF_COLORS.solar}"></ha-icon>` +
        `<span class="ylabel">${epfEsc(this._t(mode))}</span>` +
        `<span class="yval">${show.num}<span class="yunit">${epfEsc(show.unit)}</span></span></span>`);
    } else {
      this._setHtml(P.yieldBar, "");
    }
    P.yieldBar.hidden = !y;
  }

  _applyCardMode() {
    this._main.style.height = `${this._cardHeight()}px`;
    const tap = this._config.tap_action;
    if (tap && tap.action && tap.action !== "none") this._actions.card = { tap, entityId: null };
    this._main.classList.toggle("tappable", !!this._actions.card);
  }

  /* target state of a transition: band values, node labels and the height of the band area */
  _buildTarget(L, R, flows, W) {
    const nodes = {};
    for (const n of L) nodes[n.key] = { side: "left", n, html: this._labelHtml(n, "left", W) };
    for (const n of R) nodes[n.key] = { side: "right", n, html: this._labelHtml(n, "right", W) };
    const values = {};
    const flowMeta = {};
    for (const f of flows) {
      const k = `${f.s.key}>${f.t.key}`;
      values[k] = f.v;
      flowMeta[k] = { s: f.s.key, t: f.t.key, sColor: f.s.color, tColor: f.t.color };
    }

    /* band area grows with the square root of the power, up to max_power */
    const flowSum = flows.reduce((a, f) => a + f.v, 0);
    const ratio = Math.sqrt(Math.min(flowSum / this._optNum("max_power", { positive: true }), 1));
    const badgeClear = this._badgeClearance();
    const padTo = Math.max(this._parts.sankey.clientHeight, 80);
    const maxT = Math.max(padTo - 16 - badgeClear, 40);
    const minT = Math.min(EPF_FIXED.minFlowHeight, maxT);
    const T = minT + (maxT - minT) * ratio;
    return { flows: values, flowMeta, nodes, T, padTo, W, totalLines: flowSum, badgeClear, badgeSide: this._badgeSide };
  }

  /* ----- transitions ----- */

  /*
   * A "state" is what is on screen: band values (W), node presence (0..1), band area height.
   * _shown is the current state, _animateTo moves it to a new target:
   *   - below transition_threshold only the numbers change, geometry and dots stay
   *   - otherwise bands, bars and labels are interpolated for transition_duration ms
   *     while the dots are moved per frame; afterwards the dots run as CSS animation
   *   - when the page is hidden or the card detached, the target is drawn directly
   */
  _animateTo(target) {
    if (this._raf) cancelAnimationFrame(this._raf);
    const from = this._shown;
    const dur = this._transitionMs();

    /* labels for every node that is visible at the start or the end */
    const keys = new Set([...Object.keys(target.nodes), ...Object.keys(from?.nodes || {})]);
    const meta = {};
    for (const k of keys) meta[k] = target.nodes[k] || from.nodes[k];
    this._setHtml(this._parts.labels, [...keys].map((k) => meta[k].html).join(""));
    const labelEls = {};
    for (const el of this._parts.labels.children) labelEls[el.dataset.k] = el;
    const draw = (frame, mode) => this._drawFrame(frame, meta, labelEls, mode);

    if (from && from.W === target.W && this._isMinorChange(from, target)) {
      const keep = { ...target, flows: from.flows, T: from.T, padTo: from.padTo };
      this._pending = { target: keep, meta, labelEls, unfinished: false };
      /* dots still left in per-frame mode (e.g. after the app was paused): hand them back to CSS */
      draw(this._frameAt(null, keep, 1), this._dotMode === "js" ? "css" : "keep");
      return;
    }

    const animate = dur > 0 && from && from.W === target.W && !document.hidden && this.isConnected;
    this._pending = { target, meta, labelEls, unfinished: animate };
    if (!animate) {
      const frame = this._frameAt(null, target, 1);
      draw(frame, "css");
      this._shown = this._snapshot(frame, target, null, true);
      return;
    }

    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const frame = this._frameAt(from, target, eased);
      const done = t >= 1;
      draw(frame, done ? "css" : "js");
      this._shown = this._snapshot(frame, target, from, done);
      if (done) {
        this._raf = null;
        this._pending.unfinished = false;
      } else {
        this._raf = requestAnimationFrame(step);
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  /* Finish an interrupted transition at once and make sure the dots run as CSS
     animation again. Only redraws when something is actually left half-way. */
  _settle() {
    const pend = this._pending;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (!pend || (!pend.unfinished && this._dotMode !== "js")) return;
    const frame = this._frameAt(null, pend.target, 1);
    this._drawFrame(frame, pend.meta, pend.labelEls, "css");
    if (pend.unfinished) this._shown = this._snapshot(frame, pend.target, null, true);
    pend.unfinished = false;
  }

  /* true when no band changes by at least transition_threshold watts and nothing appears or disappears */
  _isMinorChange(from, to) {
    const th = EPF_FIXED.transitionThreshold;
    if (th <= 0) return false;
    const sameKeys = (a, b) => Object.keys(a).sort().join() === Object.keys(b).sort().join();
    if (!sameKeys(from.flows, to.flows) || !sameKeys(from.nodes, to.nodes)) return false;
    if (Math.abs(from.padTo - to.padTo) > 1) return false;
    if (Math.abs((from.badgeClear || 0) - (to.badgeClear || 0)) > 1 || from.badgeSide !== to.badgeSide) return false;
    return Object.keys(to.flows).every((k) => Math.abs(to.flows[k] - from.flows[k]) < th);
  }

  /* what is on screen right now, as the start point of the next transition */
  _snapshot(frame, target, from, done) {
    if (done) {
      return { flows: { ...target.flows }, flowP: {}, presence: {}, flowMeta: target.flowMeta, nodes: target.nodes,
        T: frame.T, padTo: frame.padTo, W: target.W, totalLines: target.totalLines,
        badgeClear: frame.badgeClear, badgeSide: frame.badgeSide };
    }
    const flows = {};
    const flowP = {};
    for (const [k, f] of Object.entries(frame.flows)) {
      if (f.p <= 0.01) continue;
      flows[k] = f.v;
      flowP[k] = f.p;
    }
    return {
      flows,
      flowP,
      presence: { ...frame.presence },
      flowMeta: { ...(from?.flowMeta || {}), ...target.flowMeta },
      nodes: { ...(from?.nodes || {}), ...target.nodes },
      T: frame.T,
      padTo: frame.padTo,
      W: target.W,
      totalLines: target.totalLines,
      badgeClear: frame.badgeClear,
      badgeSide: frame.badgeSide,
    };
  }

  /* interpolated state at progress e (0..1); presence continues from where an interrupted transition stopped */
  _frameAt(from, to, e) {
    const lerp = (a, b) => a + (b - a) * e;
    const startP = (inA, stored) => (stored ?? (inA ? 1 : 0));
    const flows = {};
    const flowMeta = {};
    for (const k of new Set([...Object.keys(to.flows), ...Object.keys(from?.flows || {})])) {
      const inB = k in to.flows;
      const b = to.flows[k] ?? 0;
      if (from) {
        const inA = k in from.flows;
        flows[k] = { v: lerp(from.flows[k] ?? 0, b), p: lerp(startP(inA, from.flowP?.[k]), inB ? 1 : 0) };
      } else {
        flows[k] = { v: b, p: 1 };
      }
      flowMeta[k] = to.flowMeta[k] || from.flowMeta[k];
    }
    const presence = {};
    for (const k of new Set([...Object.keys(to.nodes), ...Object.keys(from?.nodes || {})])) {
      const inB = k in to.nodes;
      presence[k] = from ? lerp(startP(k in from.nodes, from.presence?.[k]), inB ? 1 : 0) : 1;
    }
    return {
      flows,
      flowMeta,
      presence,
      T: from ? lerp(from.T, to.T) : to.T,
      padTo: from && from.padTo && to.padTo ? lerp(from.padTo, to.padTo) : to.padTo,
      W: to.W,
      totalLines: to.totalLines,
      /* the badge side switches at once, the clearance fades between both states */
      badgeClear: from ? lerp(from.badgeSide ? from.badgeClear || 0 : 0, to.badgeClear || 0) : to.badgeClear || 0,
      badgeSide: to.badgeSide || from?.badgeSide || null,
    };
  }

  /* ----- drawing one frame ----- */

  _columns(W) {
    const NW = EPF_GEOMETRY.nodeWidth;
    const leftX = Math.round(W * EPF_GEOMETRY.leftColumn);
    const rightX = Math.round(W * EPF_GEOMETRY.rightColumn) - NW;
    return { NW, leftX, rightX, x0: leftX + NW, x1: rightX, mid: (leftX + NW + rightX) / 2 };
  }

  /* geometry of one frame: node bars, band slots, label positions */
  _layout(frame, meta) {
    const { nodeGap: G, ghostHeight: GH, minBand: MINB, minFlowArea } = EPF_GEOMETRY;
    const T = frame.T;
    const nodes = {};
    for (const k of Object.keys(frame.presence)) {
      const n = meta[k].n;
      nodes[k] = { key: k, side: meta[k].side, order: n.order ?? EPF_ORDER[k], ghost: n.ghost, color: n.color, name: n.name, p: frame.presence[k], flows: [] };
    }
    const flows = [];
    for (const [k, f] of Object.entries(frame.flows)) {
      const fm = frame.flowMeta[k];
      if (!nodes[fm.s] || !nodes[fm.t]) continue;
      const fl = { key: k, s: nodes[fm.s], t: nodes[fm.t], v: f.v, p: f.p, sColor: fm.sColor, tColor: fm.tColor };
      flows.push(fl);
      fl.s.flows.push(fl);
      fl.t.flows.push(fl);
    }
    const bySide = (side) => Object.values(nodes).filter((n) => n.side === side).sort((a, b) => a.order - b.order);
    const L = bySide("left");
    const R = bySide("right");
    for (const n of [...L, ...R]) if (n.flows.length) n.ghost = false;

    /* one scale for both sides, so a watt is equally thick everywhere */
    const total = flows.reduce((a, f) => a + f.v, 0);
    const gapBefore = (ns, i) => (i ? G * Math.min(ns[i].p, ns[i - 1].p) : 0);
    const room = (ns) => {
      const gaps = ns.reduce((a, n, i) => a + gapBefore(ns, i), 0);
      const ghosts = ns.filter((n) => !n.flows.length).reduce((a, n) => a + GH * n.p, 0);
      return Math.max(T - gaps - ghosts, minFlowArea);
    };
    const roomL = room(L);
    const roomR = room(R);
    this._bandThickness(flows, [...L, ...R], total > 0 ? Math.min(roomL, roomR) / total : 0, roomL, roomR);

    /* a node bar is as high as the ends of its bands (hs at the source, ht at the target) */
    const stack = (ns, end) => {
      let y = 0;
      ns.forEach((n, i) => {
        y += gapBefore(ns, i);
        n.h = n.flows.length ? n.flows.reduce((a, f) => a + f[end], 0) : GH * n.p;
        n.y = y;
        y += n.h;
      });
      return y;
    };
    const hL = stack(L, "hs");
    const hR = stack(R, "ht");
    const Hc = Math.max(hL, hR, minFlowArea);
    for (const n of L) n.y += (Hc - hL) / 2;
    for (const n of R) n.y += (Hc - hR) / 2;

    /* band slots: on the source side sorted by target, on the target side by source (no crossings) */
    const slots = (ns, end, other) => {
      for (const n of ns) {
        let y = n.y;
        for (const f of [...n.flows].sort((a, b) => a[other].order - b[other].order)) {
          f[`${end}0`] = y;
          y += f[`h${end}`];
          f[`${end}1`] = y;
        }
      }
    };
    slots(L, "s", "t");
    slots(R, "t", "s");

    /* labels: the value row (icon + value) is centred on its bar, so all values sit at the
       bar's middle; a name hangs above.
       Labels are pushed down when they would overlap. */
    const valH = Math.max(26, Math.ceil(this._fontPx("value") * 1.2) + 2);
    const nameH = (n) => (n.name ? 15 : 0);
    const rowH = (n) => (n.ghost ? 24 : valH);
    const labelH = (n) => nameH(n) + rowH(n);
    const place = (ns) => {
      let prev = -Infinity;
      for (const n of ns) {
        n.lh = labelH(n);
        const centred = n.y + n.h / 2 - nameH(n) - rowH(n) / 2;
        n.ly = Math.max(centred, prev + 6 * n.p - n.lh * (1 - n.p));
        prev = n.ly + n.lh * n.p;
      }
    };
    place(L);
    place(R);

    /* vertical position: room for the topmost label, then centred in padTo */
    const all = [...L, ...R];
    let shift = -Math.min(0, ...all.map((n) => n.ly)) + 2;
    /* a label that is just appearing or leaving only counts with its presence, so the
       block does not jump when a node is added or removed */
    let H = Math.ceil(Math.max(Hc + shift, ...all.map((n) => n.ly + shift + n.lh * n.p)) + 2);
    if (frame.padTo && H < frame.padTo) {
      shift += (frame.padTo - H) / 2;
      H = frame.padTo;
    }
    /* keep the labels on the badge side below the badge */
    const badgeNs = frame.badgeSide === "left" ? L : frame.badgeSide === "right" ? R : [];
    if (frame.badgeClear > 0 && badgeNs.length) {
      /* weighted by presence, so an appearing or leaving label moves the block smoothly */
      const down = Math.max(...badgeNs.map((n) => (frame.badgeClear - n.ly - shift) * n.p));
      if (down > 0) {
        shift += down;
        H = Math.max(H, Math.ceil(Math.max(Hc + shift, ...all.map((n) => n.ly + shift + n.lh * n.p)) + 2));
      }
    }
    for (const n of all) {
      n.y += shift;
      n.ly += shift;
    }
    for (const f of flows) {
      f.s0 += shift;
      f.s1 += shift;
      f.t0 += shift;
      f.t1 += shift;
    }
    return { L, R, flows, H, W: frame.W, ...this._columns(frame.W) };
  }

  /* Band thickness at both ends: watts times scale (hs at the source, ht at the target).
     A node below min_node_height widens only its own ends, so the band opens towards the
     small node and the other node keeps its true size. If a side then needs more room
     than it has, the scale is reduced and the step repeated. */
  _bandThickness(flows, nodes, scale, roomL, roomR) {
    const MINB = EPF_GEOMETRY.minBand;
    const minNode = this._optNum("min_node_height", { min: 0 });
    let sc = scale;
    for (let pass = 0; pass < 4; pass++) {
      const widen = new Map();
      if (minNode > 0) {
        for (const n of nodes) {
          const h = n.flows.reduce((a, f) => a + f.v * sc, 0);
          const want = minNode * n.p;
          if (h > 0 && h < want) widen.set(n, want / h);
        }
      }
      let left = 0;
      let right = 0;
      for (const f of flows) {
        const h = f.v * sc;
        f.hs = Math.max(h * (widen.get(f.s) || 1), MINB * f.p);
        f.ht = Math.max(h * (widen.get(f.t) || 1), MINB * f.p);
        left += f.hs;
        right += f.ht;
      }
      const over = Math.max(left / roomL, right / roomR);
      if (!(over > 1.001)) break;
      sc /= over;
    }
  }

  _drawFrame(frame, meta, labelEls, mode) {
    const P = this._parts;
    const g = this._layout(frame, meta);
    const ghostCol = "var(--secondary-text-color, #9aa0a6)";

    let defs = "";
    let bands = "";
    for (const f of g.flows) {
      const gid = `${this._uid}g${f.key.replace(">", "_")}`;
      defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${g.x0}" y1="0" x2="${g.x1}" y2="0">` +
        `<stop offset="0" style="stop-color:${epfEsc(f.sColor)};stop-opacity:.42"></stop>` +
        `<stop offset="1" style="stop-color:${epfEsc(f.tColor)};stop-opacity:.3"></stop></linearGradient>`;
      bands += `<path d="M${g.x0},${f.s0} C${g.mid},${f.s0} ${g.mid},${f.t0} ${g.x1},${f.t0} L${g.x1},${f.t1} C${g.mid},${f.t1} ${g.mid},${f.s1} ${g.x0},${f.s1} Z" fill="url(#${gid})" style="opacity:${f.p.toFixed(3)}"></path>`;
    }
    const bar = (n, x) => {
      const ghost = !n.flows.length;
      return `<rect x="${x}" y="${n.y}" width="${g.NW}" height="${n.h}" rx="${Math.min(3, n.h / 2)}" style="fill:${epfEsc(ghost ? ghostCol : n.color)};opacity:${((ghost ? 0.5 : 1) * n.p).toFixed(3)}"></rect>`;
    };
    const bars = g.L.map((n) => bar(n, g.leftX)).join("") + g.R.map((n) => bar(n, g.rightX)).join("");

    const svgKey = `${g.W}x${g.H}`;
    if (this._svgSize !== svgKey) {
      P.svg.setAttribute("width", g.W);
      P.svg.setAttribute("height", g.H);
      P.svg.setAttribute("viewBox", `0 0 ${g.W} ${g.H}`);
      this._svgSize = svgKey;
    }
    this._setHtml(P.svg, `<defs>${defs}</defs>${bands}${bars}`);

    for (const n of [...g.L, ...g.R]) {
      const el = labelEls[n.key];
      if (!el) continue;
      el.style.top = `${n.ly}px`;
      el.style.opacity = n.p >= 1 ? "" : n.p.toFixed(3);
      el.style.visibility = n.p <= 0.01 ? "hidden" : "";
    }

    if (mode !== "keep") this._drawDots(g, frame.totalLines, mode);
  }

  /* Each band keeps the phase (0..1) of its dots. During a transition ("js") the dots
     are positioned per frame along the moving band, reusing their elements; afterwards
     ("css") a CSS animation continues from exactly that phase, so they never jump. */
  _dotPhases(key, dur, n, now) {
    if (!this._dotState) this._dotState = {};
    let st = this._dotState[key];
    if (st && st.phases.length === n) {
      const d = (now - st.ref) / 1000 / st.dur;
      st.phases = st.phases.map((ph) => (((ph + d) % 1) + 1) % 1);
    } else {
      const base = st ? st.phases[0] : ((now / 1000) % dur) / dur;
      st = { phases: Array.from({ length: n }, (_, k) => (base + k / n) % 1) };
    }
    st.ref = now;
    st.dur = dur;
    this._dotState[key] = st;
    return st.phases;
  }

  _drawDots(g, totalLines, mode) {
    const P = this._parts;
    const now = performance.now();
    const seen = new Set();
    const styles = []; // js: inline style per dot
    let keyframes = "";
    let html = "";
    g.flows.forEach((f, i) => {
      if (f.v <= 0 || f.p <= 0.01) return;
      if (mode === "css" && f.p < 0.99) return;
      seen.add(f.key);
      const sc = (f.s0 + f.s1) / 2;
      const tc = (f.t0 + f.t1) / 2;
      const pts = epfSampleBezier([g.x0, sc], [g.mid, sc], [g.mid, tc], [g.x1, tc], EPF_GEOMETRY.dotSamples);
      const dur = this._flowRate(f.v, totalLines);
      const n = Math.max(1, Math.round((g.x1 - g.x0) / EPF_GEOMETRY.dotSpacing));
      const r = Math.min(2.6, Math.max(1.2, Math.min(f.hs, f.ht) / 2));
      const phases = this._dotPhases(f.key, dur, n, now);
      const base = `width:${2 * r}px;height:${2 * r}px;background:${epfEsc(f.sColor)};`;
      if (mode === "js") {
        const op = f.p < 1 ? `opacity:${f.p.toFixed(3)};` : "";
        for (const ph of phases) {
          const [px, py] = epfPointAt(pts, ph);
          styles.push(`${base}${op}transform:translate(${(px - r).toFixed(1)}px,${(py - r).toFixed(1)}px)`);
        }
      } else {
        const name = `${this._uid}d${i}`;
        keyframes += `@keyframes ${name}{` +
          pts.map((pt, k) => `${((k / (pts.length - 1)) * 100).toFixed(2)}%{transform:translate(${(pt[0] - r).toFixed(1)}px,${(pt[1] - r).toFixed(1)}px)}`).join("") +
          `}`;
        for (const ph of phases) {
          html += `<span class="dot" style="${base}animation:${name} ${dur.toFixed(3)}s linear ${(-ph * dur).toFixed(3)}s infinite"></span>`;
        }
      }
    });
    if (this._dotState) for (const k of Object.keys(this._dotState)) if (!seen.has(k)) delete this._dotState[k];

    if (mode === "js") {
      /* reuse the span elements between frames instead of re-creating them */
      if (this._dotMode !== "js") P.dots.textContent = "";
      const pool = P.dots.children;
      while (pool.length < styles.length) {
        const s = document.createElement("span");
        s.className = "dot";
        P.dots.appendChild(s);
      }
      while (pool.length > styles.length) P.dots.lastChild.remove();
      styles.forEach((css, k) => {
        pool[k].style.cssText = css;
      });
    } else {
      P.dots.innerHTML = (keyframes ? `<style>${keyframes}</style>` : "") + html;
    }
    this._dotMode = mode;
  }

  /* only touch the DOM when the markup really changed (keeps ha-icon elements alive) */
  _setHtml(el, html) {
    if (el._epfHtml === html) return;
    el.innerHTML = html;
    el._epfHtml = html;
  }

  _labelHtml(n, side, W) {
    const { leftX, rightX, NW } = this._columns(W);
    const { labelOffset } = EPF_GEOMETRY;
    const clickable = this._bindAction(n.act, n.cfg, n.entity);
    const style = side === "left"
      ? `right:${W - leftX + labelOffset}px;max-width:${leftX - 12}px`
      : `left:${rightX + NW + labelOffset}px;max-width:${W - rightX - NW - 12}px`;
    const tag = clickable ? "button" : "div";
    const attrs = clickable ? ` type="button" data-act="${n.act}"` : "";
    return `<${tag} data-k="${n.key}" class="lbl ${side}${n.ghost ? " ghost" : ""}${clickable ? " clickable" : ""}" style="${style}"${attrs}>` +
      (n.name ? `<span class="name">${epfEsc(n.name)}</span>` : "") +
      `<span class="val"><ha-icon icon="${epfEsc(n.icon)}"></ha-icon><span>${this._fmtHtml(n.v)}</span></span>` +
      `</${tag}>`;
  }

  _rowHtml(d, base) {
    const clickable = this._bindAction(d.key, d.cfg, d.cfg.power);
    const pct = epfClamp((Math.abs(d.v) / base) * 100, 0, 100);
    const tag = clickable ? "button" : "div";
    const attrs = clickable ? ` type="button" data-act="${d.key}"` : "";
    return `<${tag} class="row${clickable ? " clickable" : ""}"${attrs}>` +
      `<ha-icon icon="${epfEsc(d.icon)}"></ha-icon>` +
      `<span class="mid">${d.name ? `<span class="nm">${epfEsc(d.name)}</span>` : ""}` +
      `<span class="bar"><span style="width:${pct.toFixed(1)}%;background:${epfEsc(d.color)}"></span></span></span>` +
      `<span class="v">${this._fmt(d.v)}</span>` +
      `</${tag}>`;
  }

  /* ----- tap actions ----- */

  /* Registers the action of an element: its own tap_action, otherwise more-info of its
     entity. tap_action "none" makes it not clickable. Returns true when it is clickable. */
  _bindAction(key, cfg, entityId) {
    const tap = cfg?.tap_action;
    if (tap?.action === "none") return false;
    if (tap?.action) {
      this._actions[key] = { tap, entityId: entityId || null };
      return true;
    }
    if (entityId) {
      this._actions[key] = { tap: { action: "more-info" }, entityId };
      return true;
    }
    return false;
  }

  _fire(type, detail, node = this) {
    node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  _handleClick(key) {
    const a = this._actions[key];
    if (!a) return;
    const tap = a.tap;
    switch (tap.action) {
      case "more-info": {
        const id = tap.entity || a.entityId;
        if (id) this._fire("hass-more-info", { entityId: id });
        break;
      }
      case "navigate": {
        if (!tap.navigation_path) break;
        if (tap.navigation_replace) history.replaceState(null, "", tap.navigation_path);
        else history.pushState(null, "", tap.navigation_path);
        this._fire("location-changed", { replace: !!tap.navigation_replace }, window);
        break;
      }
      case "url":
        if (tap.url_path) window.open(tap.url_path);
        break;
      case "toggle": {
        const id = tap.entity || a.entityId;
        if (id) this._hass.callService("homeassistant", "toggle", { entity_id: id });
        break;
      }
      case "perform-action": {
        if (!tap.perform_action) break;
        const [domain, service] = tap.perform_action.split(".", 2);
        this._hass.callService(domain, service, tap.data || {}, tap.target);
        break;
      }
      case "fire-dom-event":
        this._fire("ll-custom", tap);
        break;
      default:
        break;
    }
  }
}

/* ---------- 4. visual editor ---------- */

const EPF_EDITOR_I18N = {
  de: {
    solar: "Solar", battery: "Batterie", grid: "Netz", home: "Haus", devices: "Geräte", display: "Darstellung",
    power: "Leistung", invert: "Vorzeichen umkehren", soc: "Ladestand", icon: "Icon", name: "Name",
    min_power: "Mindestleistung", tap_action: "Aktion beim Antippen", yield_today: "Ertrag heute",
    forecast_tomorrow: "Prognose morgen", color: "Farbe", as_node: "Als eigener Knoten",
    max_power: "Maximale Leistung", power_unit: "Einheit", card_height: "Kartenhöhe",
    min_node_height: "Mindesthöhe Knoten", transition_duration: "Dauer der Überblendung", font_scale: "Schriftgröße (Faktor)",
    badge_position: "Akku-Pille", badge_background: "Hintergrund der Akku-Pille",
    add: "Gerät hinzufügen", up: "Nach oben", down: "Nach unten", remove: "Entfernen", newDevice: "Neues Gerät",
    h_battery_power: "Positiv = Entladen. Sonst Vorzeichen umkehren.",
    h_grid_power: "Positiv = Bezug. Sonst Vorzeichen umkehren.",
    h_min_power: "Darunter gilt der Wert als 0 (W).",
    h_yield_today: "Zeigt die Ertragsleiste.",
    h_forecast_tomorrow: "Antippen der Ertragsleiste zeigt die Prognose.",
    h_max_power: "Standard 2000 W. Ab hier volle Bandhöhe und Punktgeschwindigkeit.",
    h_card_height: "Standard 372 px.",
    h_min_node_height: "Standard 24 px, 0 = streng proportional.",
    h_transition_duration: "Standard 600 ms, 0 = aus.",
    h_font_scale: "Standard 1.",
    h_color: "Farbe des Bands und Balkens, z.B. #964cb5.",
    h_as_node: "Rechts unter dem Haus statt in der Liste.",
    h_card_tap_action: "Gilt überall außer in der Geräteliste und auf Knoten mit eigener Aktion.",
    o_auto: "Automatisch (W / kW)", o_w: "W", o_kw: "kW", o_top_right: "Oben rechts", o_top_left: "Oben links",
  },
  en: {
    solar: "Solar", battery: "Battery", grid: "Grid", home: "Home", devices: "Devices", display: "Display",
    power: "Power", invert: "Invert sign", soc: "State of charge", icon: "Icon", name: "Name",
    min_power: "Minimum power", tap_action: "Tap action", yield_today: "Yield today",
    forecast_tomorrow: "Forecast tomorrow", color: "Color", as_node: "Show as own node",
    max_power: "Maximum power", power_unit: "Unit", card_height: "Card height",
    min_node_height: "Minimum node height", transition_duration: "Transition duration", font_scale: "Font size (factor)",
    badge_position: "Battery badge", badge_background: "Battery badge background",
    add: "Add device", up: "Move up", down: "Move down", remove: "Remove", newDevice: "New device",
    h_battery_power: "Positive = discharging. Otherwise invert the sign.",
    h_grid_power: "Positive = import. Otherwise invert the sign.",
    h_min_power: "Below this the value counts as 0 (W).",
    h_yield_today: "Shows the yield bar.",
    h_forecast_tomorrow: "Tapping the yield bar shows the forecast.",
    h_max_power: "Default 2000 W. Full band height and dot speed from here on.",
    h_card_height: "Default 372 px.",
    h_min_node_height: "Default 24 px, 0 = strictly proportional.",
    h_transition_duration: "Default 600 ms, 0 = off.",
    h_font_scale: "Default 1.",
    h_color: "Color of band and bar, e.g. #964cb5.",
    h_as_node: "Right below the home instead of in the list.",
    h_card_tap_action: "Applies everywhere except the device list and nodes with their own action.",
    o_auto: "Automatic (W / kW)", o_w: "W", o_kw: "kW", o_top_right: "Top right", o_top_left: "Top left",
  },
};

/* keys whose value false is the default and is left out of the YAML */
const EPF_FALSE_DEFAULTS = new Set(["invert", "as_node", "badge_background"]);

/* Removes empty values, so the YAML only holds what was set. Device entries are kept. */
function epfClean(obj) {
  if (Array.isArray(obj)) return obj.map((v) => (v && typeof v === "object" ? epfClean(v) : v));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (v === false && EPF_FALSE_DEFAULTS.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const c = epfClean(v);
      if (Object.keys(c).length) out[k] = c;
      continue;
    }
    out[k] = Array.isArray(v) ? epfClean(v) : v;
  }
  return out;
}

/* Built from Home Assistant's own form element (ha-form), so entity pickers, icon pickers
   and tap actions look and work like in the built-in cards. One form for everything except
   the devices, plus one form per device. Forms are created once and only get new data,
   so nothing loses focus while typing. */
class EssentialPowerFlowCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    for (const f of this._forms()) f.hass = hass;
    if (!this._built) this._render();
  }

  connectedCallback() {
    this._ensureFormLoaded();
  }

  /* ha-form is loaded lazily by Home Assistant; opening a built-in card editor loads it */
  async _ensureFormLoaded() {
    if (customElements.get("ha-form")) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      const card = await helpers?.createCardElement({ type: "entities", entities: [] });
      await card?.constructor?.getConfigElement?.();
    } catch (err) {
      /* nothing to do: whenDefined below still waits */
    }
    await customElements.whenDefined("ha-form");
    this._built = false;
    this._render();
  }

  _t(key) {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").slice(0, 2);
    return (EPF_EDITOR_I18N[lang] || EPF_EDITOR_I18N.en)[key] ?? key;
  }

  _forms() {
    return this.shadowRoot ? [...this.shadowRoot.querySelectorAll("ha-form")] : [];
  }

  /* ----- schemas ----- */

  _mainSchema() {
    const sensor = { entity: { domain: "sensor" } };
    const watts = { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } };
    const common = [
      { name: "icon", selector: { icon: {} } },
      { name: "name", selector: { text: {} } },
      { name: "min_power", selector: watts },
      { name: "tap_action", selector: { ui_action: {} } },
    ];
    const select = (options) => ({ select: { mode: "dropdown", options: options.map(([value, label]) => ({ value, label: this._t(label) })) } });
    return [
      { type: "expandable", name: "solar", title: this._t("solar"), icon: "mdi:solar-power", schema: [
        { name: "power", selector: sensor },
        { name: "yield_today", selector: sensor },
        { name: "forecast_tomorrow", selector: sensor },
        ...common,
      ] },
      { type: "expandable", name: "battery", title: this._t("battery"), icon: "mdi:battery-medium", schema: [
        { name: "power", selector: sensor, helper: "h_battery_power" },
        { name: "invert", selector: { boolean: {} } },
        { name: "soc", selector: sensor },
        ...common,
      ] },
      { type: "expandable", name: "grid", title: this._t("grid"), icon: "mdi:transmission-tower", schema: [
        { name: "power", selector: sensor, helper: "h_grid_power" },
        { name: "invert", selector: { boolean: {} } },
        ...common,
      ] },
      { type: "expandable", name: "home", title: this._t("home"), icon: "mdi:home", schema: common },
      { type: "expandable", name: "display", flatten: true, title: this._t("display"), icon: "mdi:palette-outline", schema: [
        { type: "grid", name: "", schema: [
          { name: "card_height", selector: { number: { min: 120, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "min_node_height", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "px" } } },
          { name: "max_power", selector: watts },
          { name: "power_unit", selector: select([["auto", "o_auto"], ["W", "o_w"], ["kW", "o_kw"]]) },
          { name: "transition_duration", selector: { number: { min: 0, step: 50, mode: "box", unit_of_measurement: "ms" } } },
          { name: "font_scale", selector: { number: { min: 0.5, max: 2, step: 0.05, mode: "box" } } },
          { name: "badge_position", selector: select([["top-right", "o_top_right"], ["top-left", "o_top_left"]]) },
          { name: "badge_background", selector: { boolean: {} } },
        ] },
        { name: "tap_action", selector: { ui_action: {} }, helper: "h_card_tap_action" },
      ] },
    ];
  }

  _deviceSchema() {
    return [
      { name: "power", selector: { entity: { domain: "sensor" } } },
      { type: "grid", name: "", schema: [
        { name: "name", selector: { text: {} } },
        { name: "icon", selector: { icon: {} } },
        { name: "min_power", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } } },
        { name: "color", selector: { text: {} }, helper: "h_color" },
      ] },
      { name: "as_node", selector: { boolean: {} }, helper: "h_as_node" },
      { name: "tap_action", selector: { ui_action: {} } },
    ];
  }

  _label = (s) => (s.name ? this._t(s.name) : "");

  _helper = (s) => {
    if (s.helper) return this._t(s.helper);
    const key = `h_${s.name}`;
    const text = this._t(key);
    return text === key ? undefined : text;
  };

  /* ----- rendering ----- */

  _render() {
    if (!this._config || !this._hass || !customElements.get("ha-form")) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const devices = this._config.devices || [];
    if (!this._built || this._deviceCount !== devices.length) this._build(devices.length);
    const R = this.shadowRoot;

    const main = R.querySelector("ha-form.main");
    const { devices: _omit, ...rest } = this._config;
    main.data = rest;
    main.hass = this._hass;

    R.querySelectorAll(".dev").forEach((el, i) => {
      const d = devices[i] || {};
      const form = el.querySelector("ha-form");
      form.data = d;
      form.hass = this._hass;
      el.querySelector(".dev-title").textContent =
        d.name || (d.power && this._hass.states[d.power]?.attributes?.friendly_name) || d.power || this._t("newDevice");
      el.querySelector(".dev-icon").setAttribute("icon", d.icon || "mdi:flash");
      el.querySelector("[data-move='-1']").disabled = i === 0;
      el.querySelector("[data-move='1']").disabled = i === devices.length - 1;
    });
  }

  /* creates the DOM; only called again when the number of devices changes */
  _build(count) {
    const R = this.shadowRoot;
    const open = new Set([...R.querySelectorAll(".dev")].filter((d) => d.open).map((d) => Number(d.dataset.i)));
    R.innerHTML = `<style>${EssentialPowerFlowCardEditor.styles}</style>` +
      `<ha-form class="main"></ha-form>` +
      `<div class="section"><ha-icon icon="mdi:power-plug-outline"></ha-icon><span>${this._t("devices")}</span></div>` +
      `<div class="devs"></div>` +
      `<button class="add" type="button"><ha-icon icon="mdi:plus"></ha-icon><span>${this._t("add")}</span></button>`;

    const main = R.querySelector("ha-form.main");
    main.schema = this._mainSchema();
    main.computeLabel = this._label;
    main.computeHelper = this._helper;
    main.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      this._commit({ ...ev.detail.value, devices: this._config.devices });
    });

    const wrap = R.querySelector(".devs");
    for (let i = 0; i < count; i++) {
      const el = document.createElement("details");
      el.className = "dev";
      el.dataset.i = String(i);
      el.open = open.has(i);
      el.innerHTML =
        `<summary><ha-icon class="dev-icon"></ha-icon><span class="dev-title"></span>` +
        `<button type="button" data-move="-1" title="${this._t("up")}"><ha-icon icon="mdi:arrow-up"></ha-icon></button>` +
        `<button type="button" data-move="1" title="${this._t("down")}"><ha-icon icon="mdi:arrow-down"></ha-icon></button>` +
        `<button type="button" data-remove title="${this._t("remove")}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>` +
        `</summary><ha-form></ha-form>`;
      const form = el.querySelector("ha-form");
      form.schema = this._deviceSchema();
      form.computeLabel = this._label;
      form.computeHelper = this._helper;
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const list = [...(this._config.devices || [])];
        list[i] = ev.detail.value;
        this._commit({ ...this._config, devices: list });
      });
      el.querySelectorAll("summary button").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const list = [...(this._config.devices || [])];
          if (b.hasAttribute("data-remove")) list.splice(i, 1);
          else {
            const j = i + Number(b.dataset.move);
            [list[i], list[j]] = [list[j], list[i]];
          }
          this._commit({ ...this._config, devices: list });
        }));
      wrap.appendChild(el);
    }
    R.querySelector(".add").addEventListener("click", () => {
      this._commit({ ...this._config, devices: [...(this._config.devices || []), { power: "" }] });
    });
    this._built = true;
    this._deviceCount = count;
  }

  /* keeps the YAML in a readable order: sources, devices, display, then everything else */
  _commit(config) {
    const { type, ...rest } = config;
    const cleaned = epfClean(rest);
    if (!cleaned.devices || !cleaned.devices.length) delete cleaned.devices;
    const order = ["solar", "battery", "grid", "home", "devices", ...Object.keys(EPF_DEFAULTS), "tap_action"];
    const clean = { type };
    for (const k of order) if (k in cleaned) clean[k] = cleaned[k];
    for (const k of Object.keys(cleaned)) if (!(k in clean)) clean[k] = cleaned[k];
    this._config = clean;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: clean }, bubbles: true, composed: true }));
    this._render();
  }
}

EssentialPowerFlowCardEditor.styles = `
:host { display: block; }
.section { display: flex; align-items: center; gap: 12px; margin: 24px 0 8px; font-size: 16px; font-weight: 400; color: var(--primary-text-color); }
.section ha-icon { color: var(--secondary-text-color); }
.devs { display: flex; flex-direction: column; gap: 8px; }
.dev { border: 1px solid var(--divider-color, rgba(128,128,128,0.2)); border-radius: var(--ha-card-border-radius, 12px); padding: 0 12px; }
.dev[open] { padding-bottom: 12px; }
.dev summary { display: flex; align-items: center; gap: 12px; min-height: 48px; cursor: pointer; list-style: none; }
.dev summary::-webkit-details-marker { display: none; }
.dev summary ha-icon.dev-icon { color: var(--secondary-text-color); }
.dev-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.dev summary button, .add { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; background: none;
  color: var(--primary-text-color); font: inherit; cursor: pointer; border-radius: 8px; }
.dev summary button { width: 36px; height: 36px; padding: 0; }
.dev summary button:disabled { opacity: 0.3; cursor: default; }
.dev summary button ha-icon { --mdc-icon-size: 20px; }
.add { margin-top: 12px; padding: 8px 12px; color: var(--primary-color); font-size: 14px; }
.dev summary button:hover:not(:disabled), .add:hover { background: rgba(128,128,128,0.12); }
`;

/* ---------- 5. styles and registration ---------- */

EssentialPowerFlowCard.styles = `
:host { display: block; }
ha-card { display: block; font-family: Roboto, var(--ha-font-family-body, var(--paper-font-body1_-_font-family)), Noto, sans-serif; overflow: hidden; }
.main { position: relative; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
.main .sankey { flex: 1 1 0; min-height: 110px; }
.main .list { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
.main.tappable { cursor: pointer; }
.main.tappable .list { cursor: default; }
.main.tappable .list .clickable { cursor: pointer; }
[hidden] { display: none !important; }
.hint { font-size: 14px; font-weight: var(--epf-text-fw, 300); line-height: 1.4; color: var(--secondary-text-color); }
.clickable { cursor: pointer; border-radius: 8px; }
.clickable:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

/* sankey area: svg (bands, bars), dots and labels on top of each other */
.sankey { position: relative; width: 100%; }
.sankey svg { position: absolute; top: 0; left: 0; overflow: visible; }
.dots { position: absolute; inset: 0; pointer-events: none; }
.dot { position: absolute; top: 0; left: 0; border-radius: 50%; pointer-events: none; will-change: transform; }
@media (prefers-reduced-motion: reduce) { .dot { animation: none !important; display: none; } }
.labels { position: absolute; inset: 0; pointer-events: none; }
.labels > * { pointer-events: auto; }
.lbl { position: absolute; display: flex; flex-direction: column; gap: 1px; padding: 0; margin: 0;
  background: none; border: 0; color: var(--primary-text-color); font: inherit; text-align: left; line-height: 1.2; }
.lbl.left { align-items: flex-end; text-align: right; }
.lbl .name { font-size: var(--epf-name-fs, 12px); font-weight: var(--epf-text-fw, 300); color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.lbl .val { display: inline-flex; align-items: center; gap: 6px; font-size: var(--epf-val-fs, 18px); font-weight: var(--epf-val-fw, 300); white-space: nowrap; }
.lbl .unit { font-size: var(--epf-unit-fs, 14px); font-weight: var(--epf-text-fw, 300); color: var(--secondary-text-color); }
.lbl.left .val { flex-direction: row-reverse; }
.lbl.ghost .val { font-size: var(--epf-ghost-fs, 14px); color: var(--secondary-text-color); }
.lbl.ghost .unit { font-size: inherit; }
.lbl ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }

/* battery badge */
.badge { position: absolute; top: 12px; right: 12px; z-index: 1; display: flex; align-items: center; gap: 6px;
  padding: 5px 12px 5px 9px; border-radius: 999px; background: none;
  color: var(--primary-text-color); font-size: var(--epf-val-fs, 18px); font-weight: var(--epf-val-fw, 300); line-height: 1; white-space: nowrap;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--epf-td, 600ms) ease, visibility 0s linear var(--epf-td, 600ms); }
.badge.bg { background: rgba(128,128,128,0.12); }
.badge.left { right: auto; left: 12px; }
.badge.show { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity var(--epf-td, 600ms) ease, visibility 0s; }
.badge ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
.badge .unit { font-size: var(--epf-unit-fs, 14px); font-weight: var(--epf-text-fw, 300); color: var(--secondary-text-color); }

/* device list */
.list { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid rgba(128,128,128,0.2); padding-top: 8px; }
.row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 40px;
  box-sizing: border-box; width: 100%; padding: 0 2px; margin: 0; background: none; border: 0; color: var(--primary-text-color); font: inherit; text-align: left; }
.row ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
.row .mid { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.row .nm { font-size: var(--epf-dev-nm-fs, 14px); font-weight: var(--epf-text-fw, 300); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { display: block; height: 6px; border-radius: 3px; background: rgba(128,128,128,0.2); overflow: hidden; }
.bar > span { display: block; height: 100%; border-radius: 3px; }
.row .v { font-size: var(--epf-dev-v-fs, 14px); font-weight: var(--epf-val-fw, 300); min-width: 64px; text-align: right; white-space: nowrap; }

/* yield bar */
.yield { flex: none; display: flex; align-items: center; gap: 12px; height: 56px; box-sizing: border-box;
  margin: 0 -16px -16px; padding: 0 16px; border-top: 1px solid rgba(128,128,128,0.2); }
.yield.tappable { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.yswap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; }
.yswap.anim { animation: epf-yfade 250ms ease-out; }
@keyframes epf-yfade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .yswap.anim { animation: none; } }
.yield ha-icon { --mdc-icon-size: 22px; flex: none; }
.yield .ylabel { flex: 1 1 auto; min-width: 0; font-size: var(--epf-yl, 14px); font-weight: var(--epf-label-fw, 400); letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yield .yval { flex: none; font-size: var(--epf-yv, 18px); font-weight: var(--epf-val-fw, 300); color: var(--primary-text-color); white-space: nowrap; }
.yield .yunit { margin-left: 4px; font-size: var(--epf-yu, 14px); font-weight: var(--epf-text-fw, 300); color: var(--secondary-text-color); }
`;

if (!customElements.get("essential-power-flow-card-editor")) {
  customElements.define("essential-power-flow-card-editor", EssentialPowerFlowCardEditor);
}

if (!customElements.get("essential-power-flow-card")) {
  customElements.define("essential-power-flow-card", EssentialPowerFlowCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "essential-power-flow-card",
    name: "Essential Power Flow",
    description: "Power flow between solar, battery, grid and home as a Sankey diagram",
    preview: true,
  });
  console.info(`%c ESSENTIAL-POWER-FLOW %c ${EPF_VERSION} `, "background:#ff9800;color:#000;font-weight:600", "background:#333;color:#fff");
}
