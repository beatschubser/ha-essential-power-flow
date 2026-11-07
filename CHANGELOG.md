# Changelog

## 0.11.1

- Fixed: in Safari and the Home Assistant app on Mac and iOS, the moving dots could run outside their band after the values changed.

## 0.11.0

- Renamed to Essential Power Flow. The card type is now `custom:essential-power-flow-card` and the file `essential-power-flow-card.js`. Existing cards need the new `type`, a manual installation the new resource URL.

## 0.10.0

- Renamed to Sleek Power Flow. The card type is now `custom:sleek-power-flow-card` and the file `sleek-power-flow-card.js`. Existing cards need the new `type`, a manual installation the new resource URL.

## 0.9.1

First public release.

- Sankey diagram of the power flow between solar, battery, grid and home, with smooth transitions and moving dots.
- Devices as a list below the diagram or as own nodes next to the home (e.g. a wallbox).
- Battery badge with state of charge in a corner of the card.
- Yield bar with today's solar yield; tapping it shows tomorrow's forecast.
- Visual editor with entity and icon pickers, tap actions and a device list to add, reorder and remove devices.
