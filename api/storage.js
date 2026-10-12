'use strict';
const {createReserveHandlers,createNodeAdapter}=require('../server/node-gateway.js');
module.exports=createNodeAdapter(createReserveHandlers().storage);
