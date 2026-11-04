<h1 align="center">Power Sankey Card</h1>

<p align="center">
  The power flow between solar, battery, grid and home as a Sankey diagram for Home Assistant dashboards.
</p>

<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-41BDF5.svg" alt="HACS Custom"></a>
  <a href="https://github.com/beatschubser/ha-power-sankey-card/releases"><img src="https://img.shields.io/github/v/release/beatschubser/ha-power-sankey-card?include_prereleases" alt="Release"></a>
  <a href="https://github.com/beatschubser/ha-power-sankey-card/actions/workflows/validate.yml"><img src="https://github.com/beatschubser/ha-power-sankey-card/actions/workflows/validate.yml/badge.svg" alt="Validate"></a>
</p>

## Features

> [!NOTE]
> All features are based on my own ideas, but the code is 100% AI-generated. I just want to be transparent about that.

- Bands show at a glance where the power comes from and where it goes. Their thickness is proportional to the power, and they never cross.
- Battery and grid switch sides with their direction: discharging and import on the left, charging and export on the right.
- Changes fade smoothly, moving dots show the direction and get faster with more power.
- Devices appear in a list below the diagram, sorted by power. Large consumers such as a wallbox can be shown as their own node next to the home.
- A badge in the corner shows the battery's state of charge.
- A yield bar shows today's solar yield. Tap it to see tomorrow's forecast.
- Everything can be set up in the visual editor, including tap actions. YAML works too.
- One file, no dependencies.

## Installation

### HACS

1. In HACS, open the menu (three dots, top right) → **Custom repositories**.
2. Repository: `https://github.com/beatschubser/ha-power-sankey-card`, type: **Dashboard** → **Add**.
3. Search for "Power Sankey Card", open it and click **Download**.
4. Reload the browser.

### Manual

1. Copy `power-sankey-card.js` to `/config/www/`.
2. Settings → Dashboards → menu (three dots, top right) → **Resources** → **Add resource**. (No menu entry? Enable **Advanced mode** in your user profile.)
3. URL: `/local/power-sankey-card.js?v=0.9.1`, type: **JavaScript module**.
4. Reload the browser. After an update, raise the version in the URL so the browser does not use the cached file.

## Example

```yaml
type: custom:power-sankey-card
solar:
  power: sensor.solar_power
  yield_today: sensor.solar_energy_today
  forecast_tomorrow: sensor.solar_forecast_tomorrow
battery:
  power: sensor.battery_power
  soc: sensor.battery_soc
grid:
  power: sensor.grid_power
devices:
  - power: sensor.wallbox_power
    icon: mdi:car
    min_power: 300
    as_node: true
  - power: sensor.dryer_power
    icon: mdi:tumble-dryer
max_power: 8000
```

## Sources and home

`solar`, `battery`, `grid` and `home` share the same basic options. At least one source needs a `power` sensor.

| Option | For | Effect |
| --- | --- | --- |
| `power` | solar, battery, grid | Power sensor (W, kW or MW). Battery: positive = discharging. Grid: positive = import. |
| `invert` | battery, grid | Inverts the sign if the sensor reports it the other way round. |
| `soc` | battery | State of charge in %. Shows the battery badge. |
| `yield_today` | solar | Today's yield (kWh or Wh). Shows the yield bar at the bottom. |
| `forecast_tomorrow` | solar | Forecast for tomorrow. Tapping the yield bar shows it for 10 seconds, tapping again switches back at once. |
| `icon` | all | Own icon. Otherwise the battery picks its icon by state of charge. |
| `name` | all | Name above the value. Without it, no name is shown. |
| `min_power` | all | Values below count as 0 W. A band is only drawn when it reaches the minimum power of its source and its target. |
| `tap_action` | all | Action on tap. Without it, the sensor's more-info dialog opens; for the home, the card's action applies. `action: none` turns tapping off. |

The home consumption is always calculated from the sources. The home is always shown, as a grey line when it draws no power.

## Devices

`devices` is a list of consumers. They appear below the diagram, sorted by power. The bars show their share of the current home consumption.

| Option | Effect |
| --- | --- |
| `power` | Power sensor. |
| `name` | Name in the list or at the node. |
| `icon` | Icon, default `mdi:flash`. |
| `min_power` | The device only appears from this power on. |
| `color` | Color of bar and band, e.g. `"#964cb5"`. Otherwise taken from a fixed palette. |
| `as_node` | `true` shows the device as its own node to the right, below the home, instead of in the list. Its power must be part of the home consumption. |
| `tap_action` | As for the sources. |

## Display

| Option | Default | Effect |
| --- | --- | --- |
| `max_power` | `2000` | Power in W at which the bands reach their full height and the dots their full speed. |
| `power_unit` | `auto` | `auto` (kW from 1000 W on), `W` or `kW`. |
| `card_height` | `372` | Card height in px. |
| `min_node_height` | `24` | Minimum height of a node in px, so small values stay visible. Only the band end at the small node is widened. `0` draws strictly proportional. |
| `transition_duration` | `600` | Duration of the fade in ms, `0` turns it off. Skipped automatically with "reduce motion". |
| `font_scale` | `1` | Factor for all font sizes (0.5 to 2). |
| `badge_position` | `top-right` | Corner of the battery badge: `top-right` or `top-left`. Labels below keep a distance of 12 px. |
| `badge_background` | `false` | Grey background for the battery badge. |
| `tap_action` | none | Action when tapping the card. Applies everywhere except the device list and elements with their own action. |

Rarely changed values such as decimals, dot speeds and font sizes are collected in `PSC_FIXED` and `PSC_FONT` at the top of the file.

## How the diagram works

- Sources are on the left, targets on the right, each in a fixed order: solar, battery, grid and home, battery, grid.
- Sources fill the targets from top to bottom (solar goes to the home first), so bands never cross. Devices with `as_node` are supplied from the home's share.
- Numbers are rounded, bands are exact: "0.5 kW" can be anything from 450 to 549 W.

## License

[MIT](LICENSE)
