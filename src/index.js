const PAPER='https://paper-api.alpaca.markets/v2';
const DATA='https://data.alpaca.markets/v1beta3/crypto/us';
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
function cfg(env){const endpoint=(env.alpaca_api_endpoint||'').replace(/\/$/,'');if(endpoint!==PAPER)throw new Error('Paper-only lock: alpaca_api_endpoint must be '+PAPER);if(!env.alpaca_api_key||!env.alpaca_api_secret)throw new Error('Missing Alpaca API secrets');return endpoint}
function headers(env){return {'APCA-API-KEY-ID':env.alpaca_api_key,'APCA-API-SECRET-KEY':env.alpaca_api_secret,'accept':'application/json'}}
async function alpaca(env,path,base){const endpoint=base||cfg(env);const r=await fetch(endpoint+path,{headers:headers(env)});const requestId=r.headers.get('x-request-id');let body;try{body=await r.json()}catch{body={message:await r.text()}}if(!r.ok)throw Object.assign(new Error(body?.message||'Alpaca request failed'),{status:r.status,requestId,detail:body});return {body,requestId}}
function auth(req,env){if(!env.OWNER_TOKEN)return false;const h=req.headers.get('authorization')||'';return h==='Bearer '+env.OWNER_TOKEN}
export default {async fetch(req,env){const u=new URL(req.url);try{
 if(u.pathname==='/health')return json({ok:true,service:'crypto-trading-bot',mode:'paper',trading_enabled:false,version:'0.1.0',time:new Date().toISOString()});
 if(!auth(req,env))return json({ok:false,error:'unauthorized'},401,{'www-authenticate':'Bearer'});
 cfg(env);
 if(req.method!=='GET')return json({ok:false,error:'method_not_allowed'},405);
 if(u.pathname==='/account'){const x=await alpaca(env,'/account');return json({ok:true,request_id:x.requestId,account:{id:x.body.id,status:x.body.status,currency:x.body.currency,buying_power:x.body.buying_power,cash:x.body.cash,portfolio_value:x.body.portfolio_value,crypto_status:x.body.crypto_status}})}
 if(u.pathname==='/positions'){const x=await alpaca(env,'/positions');return json({ok:true,request_id:x.requestId,positions:x.body})}
 if(u.pathname==='/orders'){const x=await alpaca(env,'/orders?status=all&limit=100&direction=desc');return json({ok:true,request_id:x.requestId,orders:x.body})}
 if(u.pathname==='/crypto/assets'){const x=await alpaca(env,'/assets?status=active&asset_class=crypto');return json({ok:true,request_id:x.requestId,assets:x.body})}
 if(u.pathname==='/crypto/quotes'){const symbols=(u.searchParams.get('symbols')||'BTC/USD,ETH/USD').split(',').map(s=>s.trim()).filter(Boolean).slice(0,10);const x=await alpaca(env,'/latest/quotes?symbols='+encodeURIComponent(symbols.join(',')),DATA);return json({ok:true,request_id:x.requestId,quotes:x.body})}
 return json({ok:false,error:'not_found',routes:['GET /health','GET /account','GET /positions','GET /orders','GET /crypto/assets','GET /crypto/quotes?symbols=BTC/USD,ETH/USD'],note:'All routes except /health require OWNER_TOKEN. Trading endpoints are intentionally disabled in v0.1.'},404);
 }catch(e){return json({ok:false,error:e.message,request_id:e.requestId||null,detail:e.detail||null},e.status||500)}}};