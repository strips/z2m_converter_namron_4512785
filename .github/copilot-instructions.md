# Zigbee2MQTT External Converter for Namron 4512785

## Architecture Overview

This is an **external converter** for Zigbee2MQTT (Z2M), enabling the Namron 4512785 (30A relay with NTC temperature probes and water sensor) to work with Z2M. The converter translates between Zigbee cluster messages and Z2M's device state model.

**Current Status:** v1.4.0 - Production-ready, cleaned for Z2M project submission (2025-11-28)

**Key files:**
- `namron_30a_relay.mjs` – Main converter (ESM export array format, v1.4.0)
- `reference/cluster.json` – Original Zigbee cluster/attribute documentation from device manufacturer
- `reference/4512785-Cluster-47_extra.json` – Enhanced cluster documentation generated with Google Gemini 3 Pro from manufacturer PDF and email correspondence
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
- **Hysteresis** (0x04E0 attrs 0x000C, 0x000D): Stored as int8, scale **×10** when writing
- **Calibration** (0x04E0 attrs 0x0004, 0x0005): Stored as int8, scale **×10** when writing, range -10.0°C to +10.0°C

### Electrical Measurements (0x0B04)
- **Voltage** (0x0505): raw **÷10** → V (e.g., 2319 → 231.9V)
- **Current** (0x0508): raw **÷1000** → A, rounded to 2 decimals (e.g., 3290 → 3.29A)
- **Power** (0x050B): **raw value** in W (NO scaling needed - device reports correctly)
  - Initial implementation incorrectly divided by 10; fixed in v1.2.4
- **Note:** Do NOT use `modernExtend.electricityMeter()` - it conflicts with custom scaling

### Energy Metering (0x0702)
- **Current Summation Delivered** (0x0000): Raw **÷100** → kWh (e.g., 28427 → 284.27 kWh)
- **CRITICAL:** Device sends shortened attribute key `'currentSummDelivered'` NOT `'currentSummationDelivered'`
- Must check both keys in `pick()` array: `['currentSummDelivered', 'currentSummationDelivered', 0x0000]`
- Fixed in v1.2.4 after discovering 28426 kWh display error

### Water Sensor Logic
- **Physical behavior:** Water presence **shorts** the sensor terminals
- **State mapping:** `true` = water detected (alarm), `false` = dry (normal)
- **Inverted from raw:** Use `!raw` to flip the raw boolean value
- Cluster 0x04E0 attr 0x0003 (waterSensorValue) and 0x000E (waterConditionAlarm)

### Enum Value Handling
Use `parseEnumValue(value, MAP, label)` to accept both string keys (e.g., `"NTC-10K"`) and numeric values, returning `{raw, text}`. Always write the numeric `raw` to Zigbee; return the `text` as state.

**User-Friendly Labels (v1.3.0+):** All enum maps now use descriptive labels instead of technical codes:
- `NTC_TYPE_MAP`: `"NTC-10K"` (not `"ntc_10k"`)
- `WATER_RELAY_ACTION_MAP`: `"Water alarm: Turn OFF (restore when dry)"` (not `"alarm_turn_off"`)
- `NTC1/2_OPERATION_MAP`: Full sentences describing behavior (not `"ntc1_1"`)
- `OVERRIDE_OPTION_MAP`: `"Water Alarm Priority"` (not `"WaterAlarmPriority"`)

These labels appear in Z2M GUI dropdowns and are defined in `reference/4512785-Cluster-47_extra.json`.

### Power-On Behavior (v1.2.5+)
- **Feature:** Configures relay state after power outage using `powerOnBehavior` setting
- **Integration:** Uses `m.onOff({ powerOnBehavior: true })` from modernExtend
- **Options:** `off`, `on`, `previous` (restore last state before outage)
- **Use case:** Critical for heating systems that must restore after power loss

## Development Workflow

### Version History
- **v1.2.3** – Initial working version with basic scaling
- **v1.2.4** – Fixed power scaling (removed incorrect ÷10), fixed energy key name (`currentSummDelivered`)
- **v1.2.5** – Added powerOnBehavior support
- **v1.3.0** – Updated all enum labels with user-friendly descriptions from cluster.json
- **v1.3.1** – Updated all expose descriptions with detailed cluster documentation
- **v1.4.0** – Removed debug converters and excessive logging for Z2M submission (2025-11-28)

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
- **Duplicate entities in GUI:** Avoid using `modernExtend.electricityMeter()` - it adds extra exposes that conflict with custom scaling
- **Energy shows huge values:** Check for shortened attribute key `'currentSummDelivered'` instead of standard `'currentSummationDelivered'`
- **Water sensor inverted:** Device hardware shorts terminals when wet, so logic must flip: `true` = water detected

### Extending Attributes
1. Add attribute to `cluster.json` (if new discovery)
2. Define mapping constants (e.g., `NEW_SETTING_MAP`) and inverse (`invert()`)
3. Add case to `fzLocal.private_04e0_num` converter with `mapAndAssign()`
4. Add matching case to `tzLocal.set_private_attribute` or `get_attribute`
5. Add to both `exposes` array and `key` array in toZigbee converter

## Integration Context

This converter enables Z2M to control a high-power Zigbee relay used for heating/water systems. The device's NTC probes + water sensor allow automated safety shutoff (e.g., overheat protection, leak detection). The override priority logic resolves conflicts when multiple conditions trigger simultaneously.

The Homey cluster snippets demonstrate the same 0x04E0 cluster in a different platform; they're included as reference but not used by Z2M.
