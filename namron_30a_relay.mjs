// External converter for Namron 4512785 (Zigbee 30A relay)
// Hybrid: modernExtend for onOff + custom numeric parsers with debug logs.

import reporting from 'zigbee-herdsman-converters/lib/reporting';
import * as exposes from 'zigbee-herdsman-converters/lib/exposes';
import * as m from 'zigbee-herdsman-converters/lib/modernExtend';

const e = exposes.presets;
const ea = exposes.access;

// Helpers
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
    none: 0,
    ntc_10k: 1,
    ntc_12k: 2,
    ntc_15k: 3,
    ntc_22k: 4,
    ntc_33k: 5,
    ntc_47k: 6,
};
const NTC_TYPE_INV = invert(NTC_TYPE_MAP);
const WATER_RELAY_ACTION_MAP = {
    no_action: 0,
    alarm_turn_off: 1,
    alarm_turn_on: 2,
    alarm_turn_off_no_action: 3,
    alarm_turn_on_no_action: 4,
    no_alarm_turn_off: 5,
    no_alarm_turn_on: 6,
};
const WATER_RELAY_ACTION_INV = invert(WATER_RELAY_ACTION_MAP);
const NTC1_OPERATION_MAP = {
    unuse: 0,
    ntc1_1: 1,
    ntc1_2: 2,
    ntc1_3: 3,
    ntc1_4: 4,
};
const NTC1_OPERATION_INV = invert(NTC1_OPERATION_MAP);
const NTC2_OPERATION_MAP = {
    unuse: 0,
    ntc2_1: 1,
    ntc2_2: 2,
    ntc2_3: 3,
    ntc2_4: 4,
};
const NTC2_OPERATION_INV = invert(NTC2_OPERATION_MAP);
const OVERRIDE_OPTION_MAP = {
    no_priority: 0,
    water_alarm_priority: 1,
    ntc_priority: 2,
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

    // 0x0002 genDeviceTempCfg -> device_temperature (°C) from attr 0x0000 (/10)
    device_temp_num: {
        cluster: 0x0002,
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
        cluster: 0x0402,
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
        cluster: PRIVATE_CLUSTER_ID,
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
                out.water_sensor = !!raw;
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
        cluster: 0x0B04,
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            const out = {};
            if (!msg.data) return;
            const voltKey = pick(msg.data, [0x0505, 'rmsVoltage']);
            const currKey = pick(msg.data, [0x0508, 'rmsCurrent']);
            const powKey  = pick(msg.data, [0x050B, 'activePower']);
            if (voltKey !== undefined) out.voltage = Math.round((msg.data[voltKey] / 10) * 10) / 10;
            if (currKey !== undefined) out.current = Math.round((msg.data[currKey] / 1000) * 1000) / 1000;
            if (powKey  !== undefined) out.power = Math.round((msg.data[powKey] / 10) * 10) / 10; // divide by 10 as observed
            return Object.keys(out).length ? out : undefined;
        },
    },

    // 0x0702 seMetering -> energy (kWh) from attr 0x0000 (assume Wh, divide /1000)
    metering_num: {
        cluster: 0x0702,
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg) => {
            if (!msg.data) return;
            const key = pick(msg.data, [0x0000, 'currentSummationDelivered']);
            if (key !== undefined) {
                const raw = msg.data[key];
                if (typeof raw === 'number') {
                    return {energy: Math.round((raw / 1000) * 1000) / 1000};
                }
            }
        },
    },

    // Debug loggers for verification of clusters/attrs
    debug_0006: { cluster: 0x0006, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x0006 (${msg.cluster}): keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
    debug_0002: { cluster: 0x0002, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x0002 (${msg.cluster}): keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
    debug_0402: { cluster: 0x0402, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x0402 (${msg.cluster}): keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
    debug_04E0: { cluster: 0x04E0, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x04E0: keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
    debug_0B04: { cluster: 0x0B04, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x0B04 (${msg.cluster}): keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
    debug_0702: { cluster: 0x0702, type: ['attributeReport', 'readResponse'], convert: (m, msg) => {
        // eslint-disable-next-line no-console
        console.warn(`[Namron4512785] DEBUG 0x0702 (${msg.cluster}): keys=${Object.keys(msg.data||{}).join(',')} type=${msg.type}`);
    }},
};

// toZigbee convertGet for each exposed measurement so Refresh buttons work
const tzLocal = {
    get_attribute: {
        key: [
            'device_temperature', 'ntc1_temperature', 'ntc2_temperature', 'water_sensor',
            'voltage', 'current', 'power', 'energy',
            'ntc1_sensor_type', 'ntc2_sensor_type', 'water_alarm_relay_action',
            'ntc1_operation_mode', 'ntc2_operation_mode', 'ntc1_relay_auto_temp',
            'ntc2_relay_auto_temp', 'override_option', 'ntc1_calibration',
            'ntc2_calibration', 'ntc1_temp_hysteresis', 'ntc2_temp_hysteresis',
            'water_condition_alarm', 'ntc_condition_alarm', 'is_execute_condition',
        ],
        convertGet: async (entity, key) => {
            // eslint-disable-next-line no-console
            console.warn(`[Namron4512785] get ${key}`);
            try {
                let res; let k; let raw; let val;
                switch (key) {
                    case 'device_temperature':
                        res = await entity.read('genDeviceTempCfg', [0x0000]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read genDeviceTempCfg keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0000, 'currentTemperature']); raw = res?.[k];
                        if (raw !== undefined && raw !== null && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/10)*10)/10; return {state: {device_temperature: val}};
                        }
                        break;
                    case 'ntc1_temperature':
                        res = await entity.read('msTemperatureMeasurement', [0x0000]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read msTemperatureMeasurement keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0000, 'measuredValue']); raw = res?.[k];
                        if (raw !== undefined && raw !== null && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc1_temperature: val}};
                        }
                        break;
                    case 'ntc2_temperature':
                        res = await entity.read(0x04E0, [0x0000]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0000, 'ntc2Temperature']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc2_temperature: val}};
                        }
                        break;
                    case 'water_sensor':
                        res = await entity.read(0x04E0, [0x0003]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0003, 'waterSensor']); raw = res?.[k];
                        if (raw !== undefined) return {state: {water_sensor: !!raw}};
                        break;
                    case 'voltage':
                        res = await entity.read('haElectricalMeasurement', [0x0505]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read haElectricalMeasurement keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0505, 'rmsVoltage']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round((raw/10)*10)/10; return {state: {voltage: val}}; }
                        break;
                    case 'current':
                        res = await entity.read('haElectricalMeasurement', [0x0508]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read haElectricalMeasurement keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0508, 'rmsCurrent']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round((raw/1000)*1000)/1000; return {state: {current: val}}; }
                        break;
                    case 'power':
                        res = await entity.read('haElectricalMeasurement', [0x050B]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read haElectricalMeasurement keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x050B, 'activePower']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round((raw/10)*10)/10; return {state: {power: val}}; }
                        break;
                    case 'energy':
                        res = await entity.read('seMetering', [0x0000]);
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] read seMetering keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0000, 'currentSummationDelivered', 'currentSummDelivered']); raw = res?.[k];
                        if (typeof raw === 'number') { val = Math.round((raw/1000)*1000)/1000; return {state: {energy: val}}; }
                        break;
                    case 'ntc1_sensor_type':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0001]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0001, 'resistanceValue1']); raw = res?.[k];
                        if (raw != null) return {state: {ntc1_sensor_type: NTC_TYPE_INV[raw] ?? raw}};
                        break;
                    case 'ntc2_sensor_type':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0002]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0002, 'resistanceValue2']); raw = res?.[k];
                        if (raw != null) return {state: {ntc2_sensor_type: NTC_TYPE_INV[raw] ?? raw}};
                        break;
                    case 'water_alarm_relay_action':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0006]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0006, 'waterAlarmRelayAction']); raw = res?.[k];
                        if (raw != null) return {state: {water_alarm_relay_action: WATER_RELAY_ACTION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_operation_mode':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0007]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0007, 'ntc1OperationSelect']); raw = res?.[k];
                        if (raw != null) return {state: {ntc1_operation_mode: NTC1_OPERATION_INV[raw] ?? raw}};
                        break;
                    case 'ntc2_operation_mode':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0008]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0008, 'ntc2OperationSelect']); raw = res?.[k];
                        if (raw != null) return {state: {ntc2_operation_mode: NTC2_OPERATION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_relay_auto_temp':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0009]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0009, 'ntc1RelayAutoTemp']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc1_relay_auto_temp: val}};
                        }
                        break;
                    case 'ntc2_relay_auto_temp':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000A]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000A, 'ntc2RelayAutoTemp']); raw = res?.[k];
                        if (typeof raw === 'number' && raw !== -32768 && raw !== 0x8000) {
                            val = Math.round((raw/100)*10)/10; return {state: {ntc2_relay_auto_temp: val}};
                        }
                        break;
                    case 'override_option':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000B]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000B, 'overrideOption']); raw = res?.[k];
                        if (raw != null) return {state: {override_option: OVERRIDE_OPTION_INV[raw] ?? raw}};
                        break;
                    case 'ntc1_calibration':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0004]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0004, 'NTCCalibration1']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc1_calibration: raw}};
                        break;
                    case 'ntc2_calibration':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0005]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0005, 'NTCCalibration2']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc2_calibration: raw}};
                        break;
                    case 'ntc1_temp_hysteresis':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000C]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000C, 'ntc1TempHysterisis']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc1_temp_hysteresis: raw}};
                        break;
                    case 'ntc2_temp_hysteresis':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000D]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000D, 'ntc2TempHysterisis']); raw = res?.[k];
                        if (typeof raw === 'number') return {state: {ntc2_temp_hysteresis: raw}};
                        break;
                    case 'water_condition_alarm':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000E]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000E, 'waterConditionAlarm']); raw = res?.[k];
                        if (raw != null) return {state: {water_condition_alarm: !!raw}};
                        break;
                    case 'ntc_condition_alarm':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x000F]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x000F, 'ntcConditionAlarm']); raw = res?.[k];
                        if (raw != null) return {state: {ntc_condition_alarm: !!raw}};
                        break;
                    case 'is_execute_condition':
                        res = await entity.read(PRIVATE_CLUSTER_ID, [0x0010]);
                        console.warn(`[Namron4512785] read 0x04E0 keys=${Object.keys(res||{}).join(',')}`);
                        k = pick(res, [0x0010, 'isExecuteCondition']); raw = res?.[k];
                        if (raw != null) return {state: {is_execute_condition: !!raw}};
                        break;
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[Namron4512785] get ${key} failed: ${err}`);
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
        convertSet: async (entity, key, value, meta) => {
            // eslint-disable-next-line no-console
            console.warn(`[Namron4512785] set ${key} -> ${value}`);
            let payload; let result;
            switch (key) {
                case 'ntc1_sensor_type':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC_TYPE_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0001: payload});
                    return {state: {ntc1_sensor_type: result}};
                case 'ntc2_sensor_type':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC_TYPE_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0002: payload});
                    return {state: {ntc2_sensor_type: result}};
                case 'water_alarm_relay_action':
                    ({raw: payload, text: result} = parseEnumValue(value, WATER_RELAY_ACTION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0006: payload});
                    return {state: {water_alarm_relay_action: result}};
                case 'ntc1_operation_mode':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC1_OPERATION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0007: payload});
                    return {state: {ntc1_operation_mode: result}};
                case 'ntc2_operation_mode':
                    ({raw: payload, text: result} = parseEnumValue(value, NTC2_OPERATION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0008: payload});
                    return {state: {ntc2_operation_mode: result}};
                case 'ntc1_relay_auto_temp':
                    ({raw: payload, text: result} = parseNumeric(value, key, 100));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0009: payload});
                    return {state: {ntc1_relay_auto_temp: result}};
                case 'ntc2_relay_auto_temp':
                    ({raw: payload, text: result} = parseNumeric(value, key, 100));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000A: payload});
                    return {state: {ntc2_relay_auto_temp: result}};
                case 'override_option':
                    ({raw: payload, text: result} = parseEnumValue(value, OVERRIDE_OPTION_MAP, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000B: payload});
                    return {state: {override_option: result}};
                case 'ntc1_calibration':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0004: payload});
                    return {state: {ntc1_calibration: result}};
                case 'ntc2_calibration':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x0005: payload});
                    return {state: {ntc2_calibration: result}};
                case 'ntc1_temp_hysteresis':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000C: payload});
                    return {state: {ntc1_temp_hysteresis: result}};
                case 'ntc2_temp_hysteresis':
                    ({raw: payload, text: result} = parseNumeric(value, key));
                    await entity.write(PRIVATE_CLUSTER_ID, {0x000D: payload});
                    return {state: {ntc2_temp_hysteresis: result}};
                default:
                    throw new Error(`[Namron4512785] unsupported set key ${key}`);
            }
        },
    },
};

// Use modernExtend for on/off (includes get+set and exposure)

// Export as array per docs
export default [
    {
        zigbeeModel: ['4512785'],
        model: '4512785',
        vendor: 'Namron AS',
        description: 'Namron Zigbee 30A relay (numeric-ID external converter)',
        extend: [m.onOff({powerOnBehavior: false}), m.electricityMeter()],
        fromZigbee: [
            // Parsers
            fzLocal.on_off_num,
            fzLocal.device_temp_num,
            fzLocal.temp_measurement_num,
            fzLocal.private_04e0_num,
            // Debuggers
            fzLocal.debug_0006,
            fzLocal.debug_0002,
            fzLocal.debug_0402,
            fzLocal.debug_04E0,
            fzLocal.debug_0B04,
            fzLocal.debug_0702,
        ],
    toZigbee: [tzLocal.get_attribute, tzLocal.set_private_attribute],
        exposes: [
            e.switch(),
            e.numeric('device_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('Internal device temperature'),
            e.numeric('ntc1_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('External NTC1 temperature'),
            e.numeric('ntc2_temperature', ea.STATE | ea.STATE_GET).withUnit('°C').withDescription('External NTC2 temperature'),
            e.binary('water_sensor', ea.STATE | ea.STATE_GET, true, false).withDescription('External water sensor'),
            e.numeric('voltage', ea.STATE | ea.STATE_GET).withUnit('V').withDescription('RMS voltage'),
            e.numeric('current', ea.STATE | ea.STATE_GET).withUnit('A').withDescription('RMS current'),
            e.numeric('power', ea.STATE | ea.STATE_GET).withUnit('W').withDescription('Active power'),
            e.numeric('energy', ea.STATE | ea.STATE_GET).withUnit('kWh').withDescription('Total energy, kWh'),
            e.enum('ntc1_sensor_type', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC_TYPE_MAP))
                .withDescription('Select NTC type for probe #1 (set r1–r6 to enable reporting).'),
            e.enum('ntc2_sensor_type', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC_TYPE_MAP))
                .withDescription('Select NTC type for probe #2 (set r1–r6 to enable reporting).'),
            e.enum('water_alarm_relay_action', ea.STATE_SET | ea.STATE_GET, Object.keys(WATER_RELAY_ACTION_MAP))
                .withDescription('Relay behaviour when water alarm triggers.'),
            e.enum('ntc1_operation_mode', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC1_OPERATION_MAP))
                .withDescription('Manufacturer-defined operating profile for NTC1.'),
            e.enum('ntc2_operation_mode', ea.STATE_SET | ea.STATE_GET, Object.keys(NTC2_OPERATION_MAP))
                .withDescription('Manufacturer-defined operating profile for NTC2.'),
            e.numeric('ntc1_relay_auto_temp', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Relay trigger temperature for probe #1 (°C).'),
            e.numeric('ntc2_relay_auto_temp', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Relay trigger temperature for probe #2 (°C).'),
            e.enum('override_option', ea.STATE_SET | ea.STATE_GET, Object.keys(OVERRIDE_OPTION_MAP))
                .withDescription('Select which condition has priority when multiple triggers occur.'),
            e.numeric('ntc1_calibration', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Calibration offset applied to NTC1.'),
            e.numeric('ntc2_calibration', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Calibration offset applied to NTC2.'),
            e.numeric('ntc1_temp_hysteresis', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Hysteresis for NTC1 control logic.'),
            e.numeric('ntc2_temp_hysteresis', ea.STATE_SET | ea.STATE_GET).withUnit('°C')
                .withDescription('Hysteresis for NTC2 control logic.'),
            e.binary('water_condition_alarm', ea.STATE, true, false)
                .withDescription('Water alarm condition flag.'),
            e.binary('ntc_condition_alarm', ea.STATE, true, false)
                .withDescription('NTC temperature alarm condition flag.'),
            e.binary('is_execute_condition', ea.STATE, true, false)
                .withDescription('Indicates if configured condition will execute.'),
        ],
        meta: {configureKey: 1},
        configure: async (device, coordinatorEndpoint, logger) => {
            const L = mkLogger(logger);
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
            // Private cluster may not support read; try anyway
            await safeRead(0x04E0, [0x0000, 0x0003], '0x04E0:ntc2/water');
        },
        // Add light polling to keep values fresh if the device doesn't report often
        onEvent: async (type, data, device) => {
            // eslint-disable-next-line no-console
            if (type === 'start') console.warn('[Namron4512785] converter loaded (start event)');
            // eslint-disable-next-line no-console
            if (type === 'deviceAnnounce') console.warn(`[Namron4512785] deviceAnnounce for ${device?.ieeeAddr}`);
            const key = device?.ieeeAddr;
            if (!key) return;
            const g = globalThis;
            g.__namron4512785_poll__ = g.__namron4512785_poll__ || new Map();
            if (type === 'start' || type === 'deviceAnnounce') {
                if (g.__namron4512785_poll__.has(key)) return;
                const intervalMs = 60000; // 60s
                // eslint-disable-next-line no-console
                console.warn(`[Namron4512785] start polling ${key} every ${intervalMs/1000}s`);
                const timer = setInterval(async () => {
                    try {
                        const ep = findBestEndpoint(device);
                        if (!ep) return;
                        // Read measurements; modernExtend fz should parse attributeReports, but this also returns directly
                        await ep.read('haElectricalMeasurement', [0x0505, 0x0508, 0x050B]);
                        await ep.read('seMetering', [0x0000]);
                        await ep.read('genDeviceTempCfg', [0x0000]);
                        await ep.read('msTemperatureMeasurement', [0x0000]);
                        await ep.read(0x04E0, [0x0000, 0x0003]);
                    } catch (e) {
                        // eslint-disable-next-line no-console
                        console.warn(`[Namron4512785] poll error: ${e}`);
                    }
                }, intervalMs);
                g.__namron4512785_poll__.set(key, timer);
            }
            if (type === 'stop') {
                const timer = g.__namron4512785_poll__.get(key);
                if (timer) clearInterval(timer);
                g.__namron4512785_poll__.delete(key);
            }
        },
    },
];
