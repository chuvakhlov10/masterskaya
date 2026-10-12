'use strict';
const http=require('node:http');
const {createNodeAdapter,createReserveHandlers}=require('./node-gateway.js');

function createReserveServer(options={}) {
  const handlers=createReserveHandlers(options);
  const routes=new Map([['/api/storage',createNodeAdapter(handlers.storage)],['/api/ably',createNodeAdapter(handlers.ably)]]);
  return http.createServer(async(req,res)=>{
    let route;
    try { route=new URL(req.url,'http://reserve.local').pathname; }
    catch { res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ok":false,"error":"INVALID_URL"}');return; }
    const handler=routes.get(route);
    if(!handler) {
      res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,error:'NOT_FOUND'}));return;
    }
    await handler(req,res);
  });
}
if(require.main===module) {
  const port=Number(process.env.PORT||3000);
  createReserveServer().listen(port,'0.0.0.0',()=>console.log('Reserve gateway listening on port '+port));
}
module.exports={createReserveServer};
