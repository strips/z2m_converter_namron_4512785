// External converter for Namron 4512785 (Zigbee 30A relay)
// Supports: on/off, power monitoring, NTC temperature sensors, water leak sensor

// Version tracking
const CONVERTER_VERSION = '1.4.0'; // Cleaned for Z2M submission
const CONVERTER_BUILD = '2025-11-28-012';

import reporting from 'zigbee-herdsman-converters/lib/reporting';
import * as exposes from 'zigbee-herdsman-converters/lib/exposes';
import * as m from 'zigbee-herdsman-converters/lib/modernExtend';
import zcl from 'zigbee-herdsman/dist/zspec/zcl/index.js';
const {DataType} = zcl;

const e = exposes.presets;
const ea = exposes.access;

const hasAny = (obj, keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
const pick = (obj, keys) => keys.find((k) => Object.prototype.hasOwnProperty.call(obj, k));
const invert = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const parseEnumValue = (value, map, label) => {
    if (value === undefined || value === null) throw new Error(`[Namron4512785] missing value for ${label}`);
    if (typeof value === 'string') {
        const key = value.trim();
        if (Object.prototype.hasOwnProperty.call(map, key)) {
            return {raw: map[key], text: key};
        }
    } else if (typeof value === 'number') {
        const found = Object.entries(map).find(([, v]) => v === value);
        if (found) return {raw: value, text: found[0]};
    }
    throw new Error(`[Namron4512785] invalid ${label}: ${value}`);
};
const parseNumeric = (value, label, scale = 1) => {
    if (value === undefined || value === null) throw new Error(`[Namron4512785] missing value for ${label}`);
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`[Namron4512785] invalid ${label}: ${value}`);
    const raw = Math.round(num * scale);
    if (scale === 1) {
        return {raw, text: raw};
    }
    const decimals = Math.round(Math.log10(scale));
    const factor = 10 ** Math.max(decimals, 0);
    const friendly = Math.round((raw / scale) * factor) / factor;
    return {raw, text: friendly};
};

const PRIVATE_CLUSTER_ID = 0x04E0;
const NTC_TYPE_MAP = {
    'None': 0,
    'NTC-10K': 1,
    'NTC-12K': 2,
    'NTC-15K': 3,
    'NTC-22K': 4,
    'NTC-33K': 5,
    'NTC-47K': 6,
};
const NTC_TYPE_INV = invert(NTC_TYPE_MAP);
const WATER_RELAY_ACTION_MAP = {
    'No action': 0,
    'Water alarm: Turn OFF (restore when dry)': 1,
    'Water alarm: Turn ON (restore when dry)': 2,
    'Water alarm: Turn OFF (stay off)': 3,
    'Water alarm: Turn ON (stay on)': 4,
    'No water: Turn OFF': 5,
    'No water: Turn ON': 6,
};
const WATER_RELAY_ACTION_INV = invert(WATER_RELAY_ACTION_MAP);
const NTC1_OPERATION_MAP = {
    'No action': 0,
    'OFF when hot, ON when cold': 1,
    'ON when hot, OFF when cold': 2,
    'OFF when hot (stay off)': 3,
    'ON when hot (stay on)': 4,
};
const NTC1_OPERATION_INV = invert(NTC1_OPERATION_MAP);
const NTC2_OPERATION_MAP = {
    'No action': 0,
    'OFF when hot, ON when cold': 1,
    'ON when hot, OFF when cold': 2,
    'OFF when hot (stay off)': 3,
    'ON when hot (stay on)': 4,
};
const NTC2_OPERATION_INV = invert(NTC2_OPERATION_MAP);
const OVERRIDE_OPTION_MAP = {
    'No priority': 0,
    'Water alarm has priority': 1,
    'Temperature (NTC) has priority': 2,
};
const OVERRIDE_OPTION_INV = invert(OVERRIDE_OPTION_MAP);
const mkLogger = (logger) => ({
    info: (msg) => {
        if (logger && typeof logger.info === 'function') return logger.info(msg);
        if (logger && typeof logger.log === 'function') return logger.log(msg);
        // eslint-disable-next-line no-console
        console.warn(msg);
    },
    warn: (msg) => {
        if (logger && typeof logger.warn === 'function') return logger.warn(msg);
        if (logger && typeof logger.log === 'function') return logger.log(msg);
        // eslint-disable-next-line no-console
        console.warn(msg);
    },
    error: (msg) => {
        if (logger && typeof logger.error === 'function') return logger.error(msg);
        if (logger && typeof logger.log === 'function') return logger.log(msg);
        // eslint-disable-next-line no-console
        console.warn(msg);
    },
});
const findBestEndpoint = (device) => {
    const desired = [0x0006, 0x0002, 0x0402, 0x0B04, 0x0702];
    const eps = device.endpoints || [];
    const hasCluster = (ep, cid) => {
        const inputs = ep?.inputClusters || [];
        return inputs.includes?.(cid) || inputs.includes?.(String(cid));
    };
    const byDesired = eps.find((ep) => desired.some((cid) => hasCluster(ep, cid)));
    return byDesired || device.getEndpoint(1) || eps[0];
};

// Local numeric-ID fromZigbee converters (accept both numeric and named attributes)
const fzLocal = {
    // 0x0006 genOnOff -> state
    on_off_num: {
        cluster: 0x0006,
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            if (!msg.data) return;
            const key = pick(msg.data, [0x0000, 'onOff']);
            if (key !== undefined) {
                return {state: msg.data[key] ? 'ON' : 'OFF'};
            }
        },
    },

    // 0x0002 genDeviceTempCfg -> device_temperature (attr 0x0000, /10)
    device_temp_num: {
        cluster: 'genDeviceTempCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            if (!msg.data) return;
            const key = pick(msg.data, [0x0000, 'currentTemperature']);
            if (key !== undefined) {
                const raw = msg.data[key];
                if (raw !== -32768 && raw !== 0x8000 && raw != null) {
                    // Device reports 10x too high -> divide by 10
                    return {device_temperature: Math.round((raw / 10) * 10) / 10};
                }
            }
        },
    },

    // 0x0402 msTemperatureMeasurement -> ntc1_temperature (°C) from attr 0x0000 (/100)
    temp_measurement_num: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            if (!msg.data) return;
            const key = pick(msg.data, [0x0000, 'measuredValue']);
            if (key !== undefined) {
                const raw = msg.data[key];
                if (raw !== -32768 && raw !== 0x8000 && raw != null) {
                    return {ntc1_temperature: Math.round((raw / 100) * 10) / 10};
                }
            }
        },
    },

    // 0x04E0 Private cluster -> ntc2_temperature (attr 0x0000, /100), water_sensor (attr 0x0003)
    private_04e0_num: {
        cluster: '1248',  // Z2M converts 0x04E0 to string '1248' for lookup
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            const out = {};
            const data = msg.data;
            if (!data) return;

            const mapAndAssign = (attrId, aliases, handler) => {
                if (hasAny(data, aliases)) handler(data[pick(data, aliases)]);
            };

            mapAndAssign(0x0000, [0x0000, 'measuredValue2', 'ntc2Temperature'], (raw) => {
                if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                    out.ntc2_temperature = Math.round((raw / 100) * 10) / 10;
                }
            });
            mapAndAssign(0x0001, [0x0001, 'resistanceValue1'], (raw) => {
                if (raw != null) out.ntc1_sensor_type = NTC_TYPE_INV[raw] ?? raw;
            });
            mapAndAssign(0x0002, [0x0002, 'resistanceValue2'], (raw) => {
                if (raw != null) out.ntc2_sensor_type = NTC_TYPE_INV[raw] ?? raw;
            });
            mapAndAssign(0x0003, [0x0003, 'waterSensorValue', 'waterSensor'], (raw) => {
                out.water_sensor = !raw; // Inverted: true=water detected (shorted), false=no water
            });
            mapAndAssign(0x0004, [0x0004, 'NTCCalibration1'], (raw) => {
                if (typeof raw === 'number') out.ntc1_calibration = raw;
            });
            mapAndAssign(0x0005, [0x0005, 'NTCCalibration2'], (raw) => {
                if (typeof raw === 'number') out.ntc2_calibration = raw;
            });
            mapAndAssign(0x0006, [0x0006, 'waterAlarmRelayAction'], (raw) => {
                if (raw != null) out.water_alarm_relay_action = WATER_RELAY_ACTION_INV[raw] ?? raw;
            });
            mapAndAssign(0x0007, [0x0007, 'ntc1OperationSelect'], (raw) => {
                if (raw != null) out.ntc1_operation_mode = NTC1_OPERATION_INV[raw] ?? raw;
            });
            mapAndAssign(0x0008, [0x0008, 'ntc2OperationSelect'], (raw) => {
                if (raw != null) out.ntc2_operation_mode = NTC2_OPERATION_INV[raw] ?? raw;
            });
            mapAndAssign(0x0009, [0x0009, 'ntc1RelayAutoTemp'], (raw) => {
                if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                    out.ntc1_relay_auto_temp = Math.round((raw / 100) * 10) / 10;
                }
            });
            mapAndAssign(0x000A, [0x000A, 'ntc2RelayAutoTemp'], (raw) => {
                if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                    out.ntc2_relay_auto_temp = Math.round((raw / 100) * 10) / 10;
                }
            });
            mapAndAssign(0x000B, [0x000B, 'overrideOption'], (raw) => {
                if (raw != null) out.override_option = OVERRIDE_OPTION_INV[raw] ?? raw;
            });
            mapAndAssign(0x000C, [0x000C, 'ntc1TempHysterisis'], (raw) => {
                if (typeof raw === 'number') out.ntc1_temp_hysteresis = raw;
            });
            mapAndAssign(0x000D, [0x000D, 'ntc2TempHysterisis'], (raw) => {
                if (typeof raw === 'number') out.ntc2_temp_hysteresis = raw;
            });
            mapAndAssign(0x000E, [0x000E, 'waterConditionAlarm'], (raw) => {
                if (raw != null) out.water_condition_alarm = !!raw;
            });
            mapAndAssign(0x000F, [0x000F, 'ntcConditionAlarm'], (raw) => {
                if (raw != null) out.ntc_condition_alarm = !!raw;
            });
            mapAndAssign(0x0010, [0x0010, 'isExecuteCondition'], (raw) => {
                if (raw != null) out.is_execute_condition = !!raw;
            });

            return Object.keys(out).length ? out : undefined;
        },
    },

    // 0x0B04 haElectricalMeasurement -> voltage (0x0505 /10), current (0x0508 /1000), power (0x050B)
    electrical_num: {
        cluster: 'haElectricalMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            const out = {};
            if (!msg.data) return;
            const voltKey = pick(msg.data, [0x0505, 'rmsVoltage']);
            const currKey = pick(msg.data, [0x0508, 'rmsCurrent']);
            const powKey  = pick(msg.data, [0x050B, 'activePower']);
            if (voltKey !== undefined) out.voltage = msg.data[voltKey] / 10; // Scale down 10 and keep as-is
            if (currKey !== undefined) out.current = Math.round((msg.data[currKey] / 1000) * 100) / 100 ; // Scale down 1000 and round to 2 decimals
            if (powKey  !== undefined) out.power = msg.data[powKey]; // raw value is correct (W) 
            return Object.keys(out).length ? out : undefined;
        },
    },

    // 0x0702 seMetering -> energy (kWh) from attr 0x0000 (device reports 100× too high)
    metering_num: {
        cluster: 'seMetering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            if (!msg.data) return;
            const key = pick(msg.data, [0x0000, 'currentSummationDelivered', 'currentSummDelivered']);
            if (key !== undefined) {
                const raw = msg.data[key];
                if (typeof raw === 'number') {
                    return {energy: Math.round(raw / 100 * 100) / 100}; // Divide by 100, round to 2 decimals
                }
            }
        },
    },
};

// toZigbee convertGet for each exposed measurement so Refresh buttons work
const tzLocal = {
    get_attribute: {
        key: [
            // Read-only attributes (GET only)
            'device_temperature', 'ntc1_temperature', 'ntc2_temperature', 'water_sensor',
            'voltage', 'current', 'power', 'energy',
            'water_condition_alarm', 'ntc_condition_alarm', 'is_execute_condition',
        ],
        convertGet: async (entity, key) => {
            try {
                let res; let k; let raw; let val;
                switch (key) {
                    case 'device_temperature':
                        res = await entity.read('genDeviceTempCfg', [0x0000]);
                        k = pick(res, [0x0000, 'currentTemperature']); raw = res?.[k];
                        if (raw !== undefined && raw !== null && raw !== -32768 && raw !== 0x8000) {
                            val = raw; return {state: {device_temperature: val}};
                        }
                        break;
                    case 'ntc1_temperature':
                        res = await entity.read('msTemperatureMeasurement', [0x0000]);
                        k = pick(res, [0x0000, 'measuredValue']); raw = res?.[k];
                        if (raw !== undefined && raw !== null && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*100)/100;
                            return {state: {ntc1_temperature: val}};
                        }
                        break;
                    case 'ntc2_temperature':
                        res = await entity.read(0x04E0, [0x0000]);
                        k = pick(res, [0x0000, 'ntc2Temperature']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000 && raw !== 0) {
                            val = Math.round((raw/100)*100)/100;
                            return {state: {ntc2_temperature: val}};
                        }
                        break;
                    case 'water_sensor':
                        res = await entity.read(0x04E0, [0x0003]);
                        k = pick(res, [0x0003, 'waterSensor']); raw = res?.[k];
                        if (raw !== undefined) {
                            const state = !raw;
                            return {state: {water_sensor: state}};
                        }
                        break;
                    case 'voltage':
                        res = await entity.read('haElectricalMeasurement', [0x0505]);
                        k = pick(res, [0x0505, 'rmsVoltage']); raw = res?.[k];
                        if (typeof raw === 'number') { val = raw/10; return {state: {voltage: val}}; }
                        break;
                    case 'current':
                        res = await entity.read('haElectricalMeasurement', [0x0508]);
                        k = pick(res, [0x0508, 'rmsCurrent']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round((raw / 1000) * 100) / 100; return {state: {current: val}}; }
                        break;
                    case 'power':
                        res = await entity.read('haElectricalMeasurement', [0x050B]);
                        k = pick(res, [0x050B, 'activePower']); raw = res?.[k];
                        if (typeof raw === 'number') { return {state: {power: raw}}; }
                        break;
                    case 'energy':
                        res = await entity.read('seMetering', [0x0000]);
                        k = pick(res, [0x0000, 'currentSummationDelivered', 'currentSummDelivered']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round(raw / 100 * 100) / 100; return {state: {energy: val}}; }
                        break;
                    case 'water_condition_alarm':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000E]);
                        k = pick(res, [0x000E, 'waterConditionAlarm']); raw = res?.[k];
                        if (raw != null) return {state: {water_condition_alarm: !!raw}};
                        break;
                    case 'ntc_condition_alarm':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000F]);
                        k = pick(res, [0x000F, 'ntcConditionAlarm']); raw = res?.[k];
                        if (raw != null) return {state: {ntc_condition_alarm: !!raw}};
                        break;
                    case 'is_execute_condition':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0010]);
                        k = pick(res, [0x0010, 'isExecuteCondition']); raw = res?.[k];
                        if (raw != null) return {state: {is_execute_condition: !!raw}};
                        break;
                }
            } catch (err) {
                throw new Error(`Failed to read ${key}: ${err.message}`);
            }
        },
    },
    set_private_attribute: {
        key: [
            'ntc1_sensor_type', 'ntc2_sensor_type', 'water_alarm_relay_action',
            'ntc1_operation_mode', 'ntc2_operation_mode', 'ntc1_relay_auto_temp',
            'ntc2_relay_auto_temp', 'override_option', 'ntc1_calibration',
            'ntc2_calibration', 'ntc1_temp_hysteresis', 'ntc2_temp_hysteresis',
        ],
        convertGet: async (entity, key, meta) => {
            try {
                let res; let k; let raw; let val;
                switch (key) {
                    case 'ntc1_sensor_type':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0001]);
                        k = pick(res, [0x0001, 'resistanceValue1']); raw = res?.[k];
                        if (raw != null) return {state: {ntc1_sensor_type: NTC_TYPE_INV[raw] ?? raw}};
                        break;
                    case 'ntc2_sensor_type':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0002]);
                        k = pick(res, [0x0002, 'resistanceValue2']); raw = res?.[k];
                        if (raw != null) return {state: {ntc2_sensor_type: NTC_TYPE_INV[raw] ?? raw}};
                        break;
                    case 'water_alarm_relay_action':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0006]);
                        k = pick(res, [0x0006, 'waterAlarmRelayAction']); raw = res?.[k];
                        if (raw != null) return {state: {water_alarm_relay_action: WATER_RELAY_ACTION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_operation_mode':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0007]);
                        k = pick(res, [0x0007, 'ntc1OperationSelect']); raw = res?.[k];
                        if (raw != null) return {state: {ntc1_operation_mode: NTC1_OPERATION_INV[raw] ?? raw}};
                        break;
                    case 'ntc2_operation_mode':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0008]);
                        k = pick(res, [0x0008, 'ntc2OperationSelect']); raw = res?.[k];
                        if (raw != null) return {state: {ntc2_operation_mode: NTC2_OPERATION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_relay_auto_temp':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0009]);
                        k = pick(res, [0x0009, 'ntc1RelayAutoTemp']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc1_relay_auto_temp: val}};
                        }
                        break;
                    case 'ntc2_relay_auto_temp':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000A]);
                        k = pick(res, [0x000A, 'ntc2RelayAutoTemp']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc2_relay_auto_temp: val}};
                        }
                        break;
                    case 'override_option':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000B]);
                        k = pick(res, [0x000B, 'overrideOption']); raw = res?.[k];
                        if (raw != null) return {state: {override_option: OVERRIDE_OPTION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_calibration':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0004]);
                        k = pick(res, [0x0004, 'NTCCalibration1']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc1_calibration: raw}};
                        break;
                    case 'ntc2_calibration':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0005]);
                        k = pick(res, [0x0005, 'NTCCalibration2']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc2_calibration: raw}};
                        break;
                    case 'ntc1_temp_hysteresis':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000C]);
                        k = pick(res, [0x000C, 'ntc1TempHysterisis']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc1_temp_hysteresis: raw}};
                        break;
                    case 'ntc2_temp_hysteresis':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000D]);
                        k = pick(res, [0x000D, 'ntc2TempHysterisis']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc2_temp_hysteresis: raw}};
                        break;
                }
            } catch (err) {
                throw new Error(`Failed to read ${key}: ${err.message}`);
            }
        },
        convertSet: async (entity, key, value, meta) => {
            let payload; let result;
            switch (key) {
                case 'ntc1_sensor_type':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC_TYPE_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0001: {value: payload, type: DataType.ENUM8}});
                    return {state: {ntc1_sensor_type: result}};
                case 'ntc2_sensor_type':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC_TYPE_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0002: {value: payload, type: DataType.ENUM8}});
                    return {state: {ntc2_sensor_type: result}};
                case 'water_alarm_relay_action':
                    ({raw: payload, text: result} = parseEnumValue(value, WATER_RELAY_ACTION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0006: {value: payload, type: DataType.ENUM8}});
                    return {state: {water_alarm_relay_action: result}};
                case 'ntc1_operation_mode':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC1_OPERATION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0007: {value: payload, type: DataType.ENUM8}});
                    return {state: {ntc1_operation_mode: result}};
                case 'ntc2_operation_mode':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC2_OPERATION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0008: {value: payload, type: DataType.ENUM8}});
                    return {state: {ntc2_operation_mode: result}};
                case 'ntc1_relay_auto_temp':
                    ({raw: payload, text: result} = parseNumeric(value, key, 100));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0009: {value: payload, type: DataType.INT16}});
                    return {state: {ntc1_relay_auto_temp: result}};
                case 'ntc2_relay_auto_temp':
                    ({raw: payload, text: result} = parseNumeric(value, key, 100));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000A: {value: payload, type: DataType.INT16}});
                    return {state: {ntc2_relay_auto_temp: result}};
                case 'override_option':
                    ({raw: payload, text: result} = parseEnumValue(value, OVERRIDE_OPTION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000B: {value: payload, type: DataType.ENUM8}});
                    return {state: {override_option: result}};
                case 'ntc1_calibration':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0004: {value: payload, type: DataType.INT8}});
                    return {state: {ntc1_calibration: result}};
                case 'ntc2_calibration':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0005: {value: payload, type: DataType.INT8}});
                    return {state: {ntc2_calibration: result}};
                case 'ntc1_temp_hysteresis':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000C: {value: payload, type: DataType.INT8}});
                    return {state: {ntc1_temp_hysteresis: result}};
                case 'ntc2_temp_hysteresis':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000D: {value: payload, type: DataType.INT8}});
                    return {state: {ntc2_temp_hysteresis: result}};
                default:
                    throw new Error(`[Namron4512785] unsupported set key ${key}`);
            }
        },
    },
};

// Global polling setup
const g = globalThis;
g.__namron4512785_poll__ = g.__namron4512785_poll__ || new Map();

// Export as array per docs
export default [
    {
        zigbeeModel: ['4512785'],
        model: '4512785',
        vendor: 'Namron AS',
        description: 'Namron Zigbee 30A relay (numeric-ID external converter)',
        extend: [m.onOff({powerOnBehavior: true})],
        fromZigbee: [
            fzLocal.device_temp_num,
            fzLocal.temp_measurement_num,
            fzLocal.private_04e0_num,
            fzLocal.electrical_num,
            fzLocal.metering_num,
        ],
    toZigbee: [tzLocal.get_attribute, tzLocal.set_private_attribute],
        exposes: [
            // Electrical measurements with custom scaling
            e.numeric('voltage', ea.STATE | ea.STATE_GET).withUnit('V').withDescription('RMS voltage'),
            e.numeric('current', ea.STATE | ea.STATE_GET).withUnit('A').withDescription('RMS current'),
            e.numeric('power', ea.STATE | ea.STATE_GET).withUnit('W').withDescription('Active power'),
            e.numeric('energy', ea.STATE | ea.STATE_GET).withUnit('kWh').withDescription('Total energy consumed'),
            // Device-specific sensors
            e.numeric('device_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('Internal device temperature'),
            e.numeric('ntc1_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('External NTC1 temperature'),
            e.numeric('ntc2_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('External NTC2 temperature'),
            e.binary('water_sensor', ea.STATE | ea.STATE_GET, true, false).withDescription('External water sensor (true=water detected)'),
            e.enum('ntc1_sensor_type', ea.ALL, Object.keys(NTC_TYPE_MAP))
                .withDescription('Select NTC probe type for temperature sensor #1'),
            e.enum('ntc2_sensor_type', ea.ALL, Object.keys(NTC_TYPE_MAP))
                .withDescription('Select NTC probe type for temperature sensor #2'),
            e.enum('water_alarm_relay_action', ea.STATE_SET | ea.STATE_GET, Object.keys(WATER_RELAY_ACTION_MAP))
                .withDescription('How should the relay react when water sensor detects a leak?'),
            e.enum('ntc1_operation_mode', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC1_OPERATION_MAP))
                .withDescription('How should relay react to NTC1 temperature? (Hot = above threshold, Cold = below threshold)'),
            e.enum('ntc2_operation_mode', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC2_OPERATION_MAP))
                .withDescription('How should relay react to NTC2 temperature? (Hot = above threshold, Cold = below threshold)'),
            e.numeric('ntc1_relay_auto_temp', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature threshold for NTC1 relay control (0-100°C, works with ntc1_operation_mode)'),
            e.numeric('ntc2_relay_auto_temp', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature threshold for NTC2 relay control (0-100°C, works with ntc2_operation_mode)'),
            e.enum('override_option', ea.STATE_SET | ea.STATE_GET, Object.keys(OVERRIDE_OPTION_MAP))
                .withDescription('Which condition wins if both water alarm and temperature trigger at the same time?'),
            e.numeric('ntc1_calibration', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature calibration offset for NTC1 (-10 to +10°C)'),
            e.numeric('ntc2_calibration', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature calibration offset for NTC2 (-10 to +10°C)'),
            e.numeric('ntc1_temp_hysteresis', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature hysteresis for NTC1 to prevent rapid switching (-10 to +10°C)'),
            e.numeric('ntc2_temp_hysteresis', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Temperature hysteresis for NTC2 to prevent rapid switching (-10 to +10°C)'),
            e.binary('water_condition_alarm', ea.STATE, true, false)
                .withDescription('Water leak alarm status (true=alarm active)'),
            e.binary('ntc_condition_alarm', ea.STATE, true, false)
                .withDescription('NTC temperature alarm status (true=alarm active)'),
            e.binary('is_execute_condition', ea.STATE, true, false)
                .withDescription('Indicates if current conditions will trigger relay action'),
        ],
        meta: {configureKey: 1},
        configure: async (device, coordinatorEndpoint, logger) => {
            const L = mkLogger(logger);
            
            // Version banner - helps confirm correct converter is loaded
            L.info(`[Namron4512785] ========================================`);
            L.info(`[Namron4512785] Converter v${CONVERTER_VERSION} build ${CONVERTER_BUILD}`);
            L.info(`[Namron4512785] ========================================`);
            
            // Log device identification info to help diagnose "Not supported" issue
            L.warn(`[Namron4512785] DEVICE INFO: modelID="${device.modelID}" manufacturerName="${device.manufacturerName}" ieeeAddr=${device.ieeeAddr}`);
            L.warn(`[Namron4512785] DEVICE INFO: endpoints=${device.endpoints.map(ep => ep.ID).join(',')}`);
            
            const endpoint = findBestEndpoint(device);
            if (!endpoint) {
                L.error('[Namron4512785] no endpoint available on device');
                return;
            }
            L.info(`[Namron4512785] using endpoint ${endpoint.ID}`);
            try {
                // Bind common clusters (skip private 0x04E0)
                await reporting.bind(endpoint, coordinatorEndpoint, [
                    'genOnOff',
                    'genDeviceTempCfg',
                    'msTemperatureMeasurement',
                    'haElectricalMeasurement',
                    'seMetering',
                ]);
            } catch (err) {
                L.warn(`[Namron4512785] bind failed: ${err}`);
            }

            // Configure reporting using helpers where available
            try { await reporting.onOff(endpoint); } catch (err) { L.warn(`[Namron4512785] onOff rpt failed: ${err}`); }
            try { await reporting.temperature(endpoint, {min: 15, max: 600, change: 10}); } catch (err) { L.warn(`[Namron4512785] temp rpt failed: ${err}`); }
            try { await reporting.rmsVoltage(endpoint, {min: 10, max: 3600, change: 1}); } catch (err) { L.warn(`[Namron4512785] volt rpt failed: ${err}`); }
            try { await reporting.rmsCurrent(endpoint, {min: 10, max: 3600, change: 10}); } catch (err) { L.warn(`[Namron4512785] curr rpt failed: ${err}`); }
            try { await reporting.activePower(endpoint, {min: 10, max: 3600, change: 5}); } catch (err) { L.warn(`[Namron4512785] power rpt failed: ${err}`); }

            // Manual reporting for 0x0002 currentTemperature
            try {
                await endpoint.configureReporting(0x0002, [{
                    attribute: 0x0000,
                    minimumReportInterval: 15,
                    maximumReportInterval: 600,
                    reportableChange: 10,
                }]);
            } catch (err) { L.warn(`[Namron4512785] device temp rpt failed: ${err}`); }

            // Basic metering: report currentSummationDelivered (0x0000)
            try {
                await endpoint.configureReporting(0x0702, [{
                    attribute: 0x0000,
                    minimumReportInterval: 30,
                    maximumReportInterval: 3600,
                    reportableChange: 1,
                }]);
            } catch (err) { L.warn(`[Namron4512785] metering rpt failed: ${err}`); }

            // CRITICAL: DO NOT configure reporting for cluster 0x0402 (NTC1 temperature)
            // The device has factory default reporting that works, but if we try to customize
            // the reporting parameters, the device accepts them (status=0) but then STOPS
            // sending automatic reports entirely. Better to use device defaults.
            // Debug log evidence: Device sent automatic reports at 12:13:05, we reconfigured
            // at 12:13:16 (device accepted status=0), but then NO MORE automatic reports.
            // Manual reads still work, so the issue is specifically with custom reporting config.
            //
            // REMOVED: Custom reporting configuration for 0x0402
            // Device will use factory defaults which send automatic temperature reports.
            L.info('[Namron4512785] Skipping 0x0402 reporting config - using device defaults');

            // CRITICAL: Configure reporting for private cluster 0x04E0 (NTC temps, water sensor)
            // Without this, the device may not report temperature/water changes automatically
            try {
                await endpoint.configureReporting(0x04E0, [
                    {
                        attribute: 0x0000, // ntc2_temperature
                        minimumReportInterval: 15,
                        maximumReportInterval: 600,
                        reportableChange: 10, // 0.1°C (raw is ×100)
                    },
                    {
                        attribute: 0x0003, // water_sensor
                        minimumReportInterval: 1,
                        maximumReportInterval: 300,
                        reportableChange: 1,
                    },
                ]);
                L.info('[Namron4512785] configured reporting for private cluster 0x04E0');
            } catch (err) { 
                L.warn(`[Namron4512785] private cluster 0x04E0 reporting failed (may not be supported): ${err}`); 
            }

            // Proactively read key attributes once to seed initial state
            const safeRead = async (cluster, attrs, label) => {
                try {
                    await endpoint.read(cluster, attrs);
                    L.info(`[Namron4512785] initial read OK for ${label}`);
                } catch (err) {
                    L.warn(`[Namron4512785] initial read failed for ${label}: ${err}`);
                }
            };

            await safeRead('genOnOff', [0x0000], 'genOnOff:0x0000');
            await safeRead('genDeviceTempCfg', [0x0000], 'genDeviceTempCfg:0x0000');
            await safeRead('msTemperatureMeasurement', [0x0000], 'msTemperatureMeasurement:0x0000');
            await safeRead('haElectricalMeasurement', [0x0505, 0x0508, 0x050B], 'haElectricalMeasurement:volt/curr/power');
            await safeRead('seMetering', [0x0000], 'seMetering:energy');
            
            // Private cluster 0x04E0: Read temps, water sensor, and CRITICAL config (NTC sensor types)
            await safeRead(0x04E0, [0x0000, 0x0003], '0x04E0:ntc2_temp/water_sensor');
            await safeRead(0x04E0, [0x0001, 0x0002], '0x04E0:ntc1_type/ntc2_type');
            await safeRead(0x04E0, [0x0007, 0x0008], '0x04E0:ntc1_operation/ntc2_operation');
            
            L.info('[Namron4512785] IMPORTANT: Set ntc1_sensor_type and ntc2_sensor_type (r1-r6) to enable temperature reporting!');
        },
        onEvent: async (type, data, device) => {
            let eventType = type;
            let eventDevice = device;
            
            if (typeof type === 'object' && type !== null && 'type' in type) {
                eventType = type.type;
                eventDevice = type.device;
            }
            
            if (!eventDevice || !eventDevice.ieeeAddr || eventType === 'start' || eventType === 'stop') {
                return;
            }
            
            const key = eventDevice.ieeeAddr;
            const g = globalThis;
            g.__namron4512785_poll__ = g.__namron4512785_poll__ || new Map();
            
            if (eventType === 'stop') {
                if (g.__namron4512785_poll__.has(key)) {
                    clearInterval(g.__namron4512785_poll__.get(key));
                    g.__namron4512785_poll__.delete(key);
                }
                return;
            }
            
            if (g.__namron4512785_poll__.has(key)) return;
            
            const intervalMs = 60000;
            const timer = setInterval(async () => {
                try {
                    const ep = findBestEndpoint(eventDevice);
                    if (!ep) return;
                    
                    await ep.read('msTemperatureMeasurement', [0x0000]);
                    await ep.read(0x04E0, [0x0000, 0x0003]);
                } catch (e) {
                    // Polling errors are non-critical
                }
            }, intervalMs);
            g.__namron4512785_poll__.set(key, timer);
        },
    },
];
