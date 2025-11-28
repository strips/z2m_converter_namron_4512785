# Zigbee2MQTT External Converter for Namron 4512785

## Architecture Overview

This is an **external converter** for Zigbee2MQTT (Z2M), enabling the Namron 4512785 (30A relay with NTC temperature probes and water sensor) to work with Z2M. The converter translates between Zigbee cluster messages and Z2M's device state model.

**Key files:**
- `namron_30a_relay.mjs` – Main converter (ESM export array format)
- `cluster.json` – Zigbee cluster/attribute documentation from device manufacturer
- `homey_cluster_snippet.{js,esm.mjs}` – Homey platform custom cluster definition (reference only)

## Zigbee2MQTT Converter Pattern

### Structure
Converters export an **array** containing device definition objects with:
- `zigbeeModel`, `model`, `vendor`, `description` – Device identification
- `extend` – Array of modernExtend helpers (e.g., `m.onOff()`, `m.electricityMeter()`)
- `fromZigbee` – Array of parsers converting Zigbee → Z2M state
- `toZigbee` – Array of converters handling Z2M commands → Zigbee writes
- `exposes` – Array defining UI capabilities (switches, sensors, enums, numerics)
- `configure` – Async function for initial device setup (binding, reporting)
- `onEvent` – Optional lifecycle handler (start/stop/deviceAnnounce)

### Numeric Cluster ID Pattern
This converter uses **numeric cluster/attribute IDs** (e.g., `0x0006`, `0x0505`) instead of named ones to handle devices with non-standard attribute naming. The `pick()` helper tries both numeric and known string aliases.

### Private Cluster 0x04E0
Device-specific cluster with 17 attributes controlling:
- NTC temperature probes (type selection, calibration, trigger temps, hysteresis)
- Water sensor state and relay action profiles
- Priority/override logic when multiple conditions trigger

Attribute IDs `0x0000`–`0x0010` map to specific settings; see `cluster.json` for full list.

## Critical Patterns

### Temperature Scaling
- **Device internal temp** (cluster 0x0002, attr 0x0000): Raw value **÷10** to get °C
- **NTC probe temps** (clusters 0x0402, 0x04E0 attr 0x0000): Raw **÷100** to get °C
- **Config temperatures** (0x04E0 attrs 0x0009, 0x000A): User provides °C, multiply **×100** before writing

### Electrical Measurements (0x0B04)
- Voltage (0x0505): raw **÷10** → V
- Current (0x0508): raw **÷1000** → A  
- Power (0x050B): raw **÷10** → W (device reports 10× actual value)

### Energy Metering (0x0702)
- Current Summation Delivered (0x0000): Assume Wh, **÷1000** → kWh

### Enum Value Handling
Use `parseEnumValue(value, MAP, label)` to accept both string keys (e.g., `"ntc_10k"`) and numeric values, returning `{raw, text}`. Always write the numeric `raw` to Zigbee; return the `text` as state.

### Debug Logging
All fromZigbee converters include debug variants (`debug_0006`, etc.) that log incoming attribute keys and message types to console. Keep these for troubleshooting unreliable devices.

## Development Workflow

### Testing Changes
1. Copy updated `namron_30a_relay.mjs` into Z2M data directory: `data/extension/`
2. Restart Zigbee2MQTT or reload converters via MQTT/UI
3. Watch Z2M logs for `[Namron4512785]` debug output
4. Use Z2M frontend "Exposes" tab to verify exposed entities appear correctly
5. Test refresh buttons (triggers `convertGet` in `tzLocal.get_attribute`)

### Common Issues
- **Missing state updates:** Check `configure()` reporting intervals; device may not auto-report. The `onEvent` polling (60s) backstops unreliable reporting.
- **Wrong values:** Verify scaling factors match device behavior (power divider was discovered empirically).
- **Attribute read failures:** Device firmware may not support read for some 0x04E0 attrs; `safeRead()` logs warnings but continues.

### Extending Attributes
1. Add attribute to `cluster.json` (if new discovery)
2. Define mapping constants (e.g., `NEW_SETTING_MAP`) and inverse (`invert()`)
3. Add case to `fzLocal.private_04e0_num` converter with `mapAndAssign()`
4. Add matching case to `tzLocal.set_private_attribute` or `get_attribute`
5. Add to both `exposes` array and `key` array in toZigbee converter

## Integration Context

This converter enables Z2M to control a high-power Zigbee relay used for heating/water systems. The device's NTC probes + water sensor allow automated safety shutoff (e.g., overheat protection, leak detection). The override priority logic resolves conflicts when multiple conditions trigger simultaneously.

The Homey cluster snippets demonstrate the same 0x04E0 cluster in a different platform; they're included as reference but not used by Z2M.
