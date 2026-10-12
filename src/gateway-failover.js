import reserve from './reserve-gateway-config.js';

const PRIMARY_STORAGE = 'https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt';
const PRIMARY_ABLY = 'https://functions.yandexcloud.net/d4en94jbo8opqbd4d0co';
const RETRYABLE_STATUS = new Set([408,425,429,500,502,503,504]);
const REPLAY_SAFE_ACTIONS = new Set(['github','renew','session-check','health','devices',
  'device-rename','device-revoke','device-diagnostics']);

export function reserveEndpointFor(endpoint) {
  if(reserve.enabled === false) return '';
  if(endpoint === PRIMARY_STORAGE) return reserve.storage || '';
  if(endpoint === PRIMARY_ABLY) return reserve.ably || '';
  return '';
}

function error(code,cause,status) {
  const result=new Error(code); result.code=code;
  if(cause) result.cause=cause;
  if(status) result.status=status;
  return result;
}

// Only deployment-controlled HTTPS endpoints are used in production. The
// transport does not accept an endpoint from a response, URL query or localStorage.
export function createGatewayFailover({now=Date.now,cooldownMs=60_000}={}) {
  const failedUntil=new Map(), lastSuccess=new Map();
  async function send({endpoint,reserveEndpoint=reserveEndpointFor(endpoint),headers={},body,
    fetchImpl=globalThis.fetch,timeoutMs=20_000,errorPrefix='GATEWAY',onFallback}={}) {
    if(typeof fetchImpl !== 'function') throw error('FETCH_UNAVAILABLE');
    if(reserveEndpoint) {
      const url=new URL(reserveEndpoint);
      if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw error('RESERVE_ENDPOINT_INVALID');
    }
    const canReplay=!body?.action || REPLAY_SAFE_ACTIONS.has(body.action);
    const serialized=JSON.stringify(body);
    const configured=reserveEndpoint && reserveEndpoint !== endpoint;
    const cooling=configured && (failedUntil.get(endpoint)||0)>now();
    const routes=configured ? (cooling ? [reserveEndpoint,endpoint] : [endpoint,reserveEndpoint]) : [endpoint];
    let lastError;
    for(let i=0;i<routes.length;i++) {
      const route=routes[i], controller=new AbortController();
      // Fail over promptly when a verified reserve is configured; preserve the
      // original timeout otherwise. Every attempt reuses the identical intent.
      const duration=configured && canReplay && route===endpoint ? Math.min(timeoutMs,6000) : timeoutMs;
      const timer=setTimeout(()=>controller.abort(),duration);
      try {
        let response;
        try {
          response=await fetchImpl(route,{method:'POST',headers:{'Content-Type':'application/json',...headers},
            body:serialized,signal:controller.signal,cache:'no-store'});
        } catch(cause) {
          throw error(errorPrefix+(cause?.name==='AbortError'?'_REQUEST_TIMEOUT':'_REQUEST_FAILED'),cause);
        }
        let payload;
        try { payload=await response.json(); }
        catch(cause) { throw error(response.ok?errorPrefix+'_RESPONSE_INVALID':`${errorPrefix}_HTTP_${response.status}`,cause,response.status); }
        if(!response.ok) throw error(String(payload?.error || `${errorPrefix}_HTTP_${response.status}`),undefined,response.status);
        failedUntil.delete(route);
        lastSuccess.set(endpoint,{route:route===endpoint?'primary':'reserve',at:now()});
        if(route!==endpoint) { try { onFallback?.(route); } catch {} }
        return payload;
      } catch(cause) {
        lastError=cause;
        const transient=RETRYABLE_STATUS.has(Number(cause.status)) ||
          cause.code===errorPrefix+'_REQUEST_TIMEOUT' || cause.code===errorPrefix+'_REQUEST_FAILED' ||
          cause.code===errorPrefix+'_RESPONSE_INVALID';
        // A 401/403, revoked device, conflict, invalid input or consumed one-time
        // code is never replayed against a second server.
        if(!transient) throw cause;
        failedUntil.set(route,now()+cooldownMs);
        if(!canReplay || i===routes.length-1) throw cause;
      } finally { clearTimeout(timer); }
    }
    throw lastError || error(errorPrefix+'_REQUEST_FAILED');
  }
  return {send,lastRoute:endpoint=>lastSuccess.get(endpoint)||null};
}

export const gatewayFailover=createGatewayFailover();
