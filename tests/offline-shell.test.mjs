import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/sw.js',import.meta.url),'utf8')
  .replace("const BUILD_ASSETS = ['./index.html'];", "const BUILD_ASSETS = ['./index.html','./assets/app.js'];");
const root='https://workshop.example/masterskaya/';
function worker({html='<script src="./assets/app.js"></script>', failBundle=false}={}) {
  const handlers=new Map(), banks=new Map(), messages=[];
  let fetched=0, skipped=false, offline=false;
  const normalize=input=>typeof input==='string'?input:input.url;
  const cache={
    async open(name) {
      if(!banks.has(name)) banks.set(name,new Map());
      const entries=banks.get(name);
      return {put:async(key,value)=>entries.set(normalize(key),value.clone()),
        match:async key=>entries.get(normalize(key))?.clone()};
    },
    keys:async()=>[...banks.keys()], delete:async key=>banks.delete(key),
  };
  const context=vm.createContext({URL,Response,caches:cache,
    self:{location:{href:root+'sw.js'},addEventListener:(type,fn)=>handlers.set(type,fn),
      skipWaiting:async()=>{skipped=true;},clients:{claim:async()=>{},matchAll:async()=>[{postMessage:value=>messages.push(value)}]}},
    fetch:async input=>{
      fetched++;
      if(offline) throw new Error('NETWORK_UNAVAILABLE');
      const url=normalize(input);
      if(failBundle && url.endsWith('/assets/app.js')) return new Response('Unavailable',{status:503});
      return new Response(url.endsWith('/index.html')?html:'bundle or optional asset');
    },
  });
  vm.runInContext(script,context);
  async function event(type,extra={}) {
    const work=[]; let response;
    handlers.get(type)({...extra,waitUntil:promise=>work.push(promise),respondWith:promise=>{response=promise;}});
    const result=response?await response:undefined;
    await Promise.all(work);
    return result;
  }
  return {event,banks,messages,get fetched(){return fetched;},get skipped(){return skipped;},
    goOffline(){offline=true;}};
}

test('the first installation caches HTML and its bundle; navigation and script then launch without any network requests',async()=>{
  const w=worker(); await w.event('install'); assert.equal(w.skipped,true);
  const count=w.fetched; w.goOffline();
  const page=await w.event('fetch',{request:{url:root,method:'GET',mode:'navigate'}});
  assert.match(await page.text(),/assets\/app.js/);
  const bundle=await w.event('fetch',{request:{url:root+'assets/app.js',method:'GET',mode:'cors'}});
  assert.equal(bundle.status,200);
  assert.equal(w.fetched,count);
  await w.event('message',{data:{type:'CHECK_OFFLINE_SHELL'},source:{postMessage:value=>w.messages.push(value)}});
  assert.equal(w.messages.at(-1).ready,true);
});

test('a failed critical bundle leaves the old shell untouched and does not activate the new one',async()=>{
  const w=worker({failBundle:true});
  w.banks.set('masterskaya-shell-previous',new Map([[root+'index.html',new Response('old usable shell')]]));
  await assert.rejects(w.event('install'),/SHELL_DOWNLOAD_FAILED/);
  assert.equal(w.skipped,false);
  assert.equal(await w.banks.get('masterskaya-shell-previous').get(root+'index.html').text(),'old usable shell');
});

test('HTML from a different deployment cannot be cached as a complete offline shell',async()=>{
  const w=worker({html:'<script src="./assets/newer.js"></script>'});
  await assert.rejects(w.event('install'),/SHELL_VERSION_MISMATCH/);
  assert.equal(w.skipped,false);
});

test('worker activation preserves the previous app shell and unrelated origin caches',async()=>{
  const w=worker();
  w.banks.set('other-project',new Map());
  w.banks.set('masterskaya-shell-oldest',new Map());
  w.banks.set('masterskaya-shell-previous',new Map());
  await w.event('install'); await w.event('activate');
  assert.equal(w.banks.has('other-project'),true);
  assert.equal(w.banks.has('masterskaya-shell-previous'),true);
  assert.equal(w.banks.has('masterskaya-shell-oldest'),false);
});

test('API and other applications are never intercepted or cached by the offline shell',async()=>{
  const w=worker();
  assert.equal(await w.event('fetch',{request:{url:'https://functions.yandexcloud.net/function',method:'POST',mode:'cors'}}),undefined);
  assert.equal(await w.event('fetch',{request:{url:'https://workshop.example/another-app/',method:'GET',mode:'navigate'}}),undefined);
  assert.equal(w.fetched,0);
});
