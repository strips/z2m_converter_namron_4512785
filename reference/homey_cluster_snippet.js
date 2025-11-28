/* 
*   Info gained from Elektroimportøren / Namron
*
*    Jeg vil tro du ikke får noen data på temperatur siden type NTC sensor ikke er definert. Denne må settes til r1-r6 for å at enheten skal rapportere data
*
*    Dette er Cluster oppsettet for Prive Configuration (730) på enheten
*
*    r0 = No sensor
*    r1 = NTC-10K
*    r2 = NTC-12K
*    r3 = NTC-15K
*    r4 = NTC-22K
*    r5 = NTC-33K
*    r6 = NTC-47K
*
*/

'use strict';

const {ZCLDataTypes, Cluster} = require('zigbee-clusters');

const ATTRIBUTES = {
    measuredValue2: {
        id: 0x0000,
        type: ZCLDataTypes.int16,
        // Raw temperature/NTC reading (°C ×100) for probe #2.
    },
    resistanceValue1: {
        id: 0x0001,
        type: ZCLDataTypes.enum8({
            r0: 0,
            r1: 1,
            r2: 2,
            r3: 3,
            r4: 4,
            r5: 5,
            r6: 6,
        }),
        // Probe #1 NTC type selector (r0–r6 → none / 10K / 12K / 15K / 22K / 33K / 47K).
    },
    resistanceValue2: {
        id: 0x0002,
        type: ZCLDataTypes.enum8({
            r0: 0,
            r1: 1,
            r2: 2,
            r3: 3,
            r4: 4,
            r5: 5,
            r6: 6,
        }),
        // Probe #2 NTC type selector (same mapping as probe #1).
    },
    waterSensorValue: {
        id: 0x0003,
        type: ZCLDataTypes.bool,
        // External water leak sensor state (true when water detected).
    },
    NTCCalibration1: {
        id: 0x0004,
        type: ZCLDataTypes.int8,
        // Offset applied to NTC probe #1 result (°C ×1).
    },
    NTCCalibration2: {
        id: 0x0005,
        type: ZCLDataTypes.int8,
        // Offset applied to NTC probe #2 result (°C ×1).
    },
    waterAlarmRelayAction: {
        id: 0x0006,
        type: ZCLDataTypes.enum8({
            noAction: 0,
            AlarmTurnOff: 1,
            AlarmTurnOn: 2,
            AlarmTurnOffNoAction: 3,
            AlarmTurnOnNoAction: 4,
            NoAlarmTurnOff: 5,
            NoAlarmTurnOn: 6,
        }),
        // Relay behavior when the water sensor trips (various on/off + override combos).
    },
    ntc1OperationSelect: {
        id: 0x0007,
        type: ZCLDataTypes.enum8({
            unuse: 0,
            ntc1_1: 1,
            ntc1_2: 2,
            ntc1_3: 3,
            ntc1_4: 4,
        }),
        // Mode/preset for NTC probe #1 (manufacturer-defined profiles).
    },
    ntc2OperationSelect: {
        id: 0x0008,
        type: ZCLDataTypes.enum8({
            unuse: 0,
            ntc2_1: 1,
            ntc2_2: 2,
            ntc2_3: 3,
            ntc2_4: 4,
        }),
        // Mode/preset for NTC probe #2 (manufacturer-defined profiles).
    },
    ntc1RelayAutoTemp: {
        id: 0x0009,
        type: ZCLDataTypes.int16,
        // Target temperature (°C ×100) at which relay reacts for probe #1.
    },
    ntc2RelayAutoTemp: {
        id: 0x000A,
        type: ZCLDataTypes.int16,
        // Target temperature (°C ×100) at which relay reacts for probe #2.
    },
    overrideOption: {
        id: 0x000B,
        type: ZCLDataTypes.enum8({
            NoPriority: 0,
            WaterAlarmPriority: 1,
            NTCPriority: 2,
        }),
        // Which condition (water vs NTC) wins when both trigger.
    },
    ntc1TempHysterisis: {
        id: 0x000C,
        type: ZCLDataTypes.int8,
        // Hysteresis (°C ×1) for probe #1 auto control.
    },
    ntc2TempHysterisis: {
        id: 0x000D,
        type: ZCLDataTypes.int8,
        // Hysteresis (°C ×1) for probe #2 auto control.
    },
    waterConditionAlarm: {
        id: 0x000E,
        type: ZCLDataTypes.bool,
        // Indicates whether the water alarm condition is active.
    },
    ntcConditionAlarm: {
        id: 0x000F,
        type: ZCLDataTypes.bool,
        // Indicates whether the NTC temperature alarm condition is active.
    },
    isExecuteCondition: {
        id: 0x0010,
        type: ZCLDataTypes.bool,
        // Overall flag signalling that the configured condition should execute.
    },
};

const COMMANDS = {
    setClear: {id: 0x0000},
};

class HzcSwitchUserInterfaceConfigurationCluster extends Cluster {
    static get ID() {
        return 0x04E0;
    }

    static get NAME() {
        return 'switchUserInterfaceConfiguration';
    }

    static get ATTRIBUTES() {
        return ATTRIBUTES;
    }

    static get COMMANDS() {
        return COMMANDS;
    }
}

module.exports = HzcSwitchUserInterfaceConfigurationCluster;
