import zcl from 'zigbee-herdsman/dist/zspec/zcl/index.js';
const {DataType} = zcl;
console.log('DataType:', DataType);
console.log('DataType.enum8:', DataType?.enum8);
console.log('DataType keys:', Object.keys(DataType || {}).slice(0, 10));
