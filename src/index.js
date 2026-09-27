const VERSION = "0.2.2";
const PAPER_API = "https://paper-api.alpaca.markets/v2";
const DATA_API = "https://data.alpaca.markets/v1beta3/crypto/us";
const SYMBOLS = ["BTC/USD", "SOL/USD"];
const TERMINAL_ORDER_STATUSES = ["filled","canceled","expired","rejected","replaced"];

function now(){return new Date().toISOString();}
function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
function num(value,fallback=null){const n=Number(value);return Number.isFinite(n)?n:fallback;}
function ownerAuthorized(request,env){if(!env.OWNER_TOKEN)return false;return request.headers.get("Authorization")===`Bearer ${env.OWNER_TOKEN}`;}
function validate(env){
  const endpoint=String(env.alpaca_api_endpoint||"").replace(/\/$/,"");
  if(endpoint!==PAPER_API) throw new Error("PAPER SAFETY LOCK FAILED: live endpoint prohibited.");
  if(!env.alpaca_api_key) throw new Error("Missing alpaca_api_key.");
  if(!env.alpaca_api_secret) throw new Error("Missing alpaca_api_secret.");
  if(!env.db) throw new Error("Missing D1 binding: db.");
}
function alpacaHeaders(env,jsonBody=false){
  const h={"APCA-API-KEY-ID":env.alpaca_api_key,"APCA-API-SECRET-KEY":env.alpaca_api_secret,"Accept":"application/json"};
  if(jsonBody)h["Content-Type"]="application/json";
  return h;
}
async function alpacaRequest(env,method,base,path,body=null){
  validate(env);
  if(base!==PAPER_API&&base!==DATA_API) throw new Error("API host rejected by safety lock.");
  const options={method,headers:alpacaHeaders(env,body!==null)};
  if(body!==null)options.body=JSON.stringify(body);
  const response=await fetch(base+path,options);
  let data=null; try{data=await response.json();}catch{data=null;}
  if(!response.ok) throw new Error(data?.message||`Alpaca HTTP ${response.status}`);
  return data;
}
async function logEvent(env,type,message,symbol=null,details=null,level="info"){
  try{
    await env.db.prepare(`INSERT INTO bot_events (level,event_type,symbol,message,details) VALUES (?,?,?,?,?)`)
      .bind(level,type,symbol,message,details?JSON.stringify(details):null).run();
  }catch{}
}
async function settings(env){
  const row=await env.db.prepare(`SELECT * FROM bot_settings WHERE id=1`).first();
  if(!row)throw new Error("bot_settings missing.");
  return row;
}
async function strategy(env,symbol){return await env.db.prepare(`SELECT * FROM strategy_params WHERE symbol=?`).bind(symbol).first();}
async function latestQuotes(env){
  const encoded=encodeURIComponent(SYMBOLS.join(","));
  const data=await alpacaRequest(env,"GET",DATA_API,`/latest/quotes?symbols=${encoded}`);
  const output={};
  for(const symbol of SYMBOLS){
    const q=data?.quotes?.[symbol]||data?.[symbol];
    const bid=num(q?.bp), ask=num(q?.ap);
    if(bid&&ask&&bid>0&&ask>=bid)output[symbol]={bid,ask,midpoint:(bid+ask)/2,timestamp:q?.t||null};
  }
  return output;
}
async function recordObservation(env,symbol,quote){
  const previous=await env.db.prepare(`SELECT midpoint FROM observations WHERE symbol=? ORDER BY id DESC LIMIT 1`).bind(symbol).first();
  const midpoint=quote.midpoint;
  const spreadBps=((quote.ask-quote.bid)/midpoint)*10000;
  let momentumBps=null;
  if(previous&&num(previous.midpoint)>0)momentumBps=((midpoint-num(previous.midpoint))/num(previous.midpoint))*10000;
  await env.db.prepare(`INSERT INTO observations (symbol,bid,ask,midpoint,spread_bps,momentum_bps,observed_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(symbol,quote.bid,quote.ask,midpoint,spreadBps,momentumBps,now()).run();
  return {symbol,bid:quote.bid,ask:quote.ask,midpoint,spread_bps:spreadBps,momentum_bps:momentumBps};
}
async function openTrade(env){return await env.db.prepare(`SELECT * FROM trades WHERE status IN ('buy_submitted','open','sell_submitted') ORDER BY id ASC LIMIT 1`).first();}
async function todayNetPnl(env){
  const row=await env.db.prepare(`SELECT COALESCE(SUM(estimated_net_pnl),0) AS pnl FROM trades WHERE status='closed' AND date(closed_at)=date('now')`).first();
  return num(row?.pnl,0);
}
function clientOrderId(prefix,symbol){return ["ctb",prefix,symbol.replace("/","").toLowerCase(),Date.now().toString(36)].join("-");}
async function submitBuy(env,symbol,notional){
  return await alpacaRequest(env,"POST",PAPER_API,"/orders",{symbol,notional:Number(notional).toFixed(2),side:"buy",type:"market",time_in_force:"gtc",client_order_id:clientOrderId("buy",symbol)});
}
async function submitSell(env,symbol,qty){
  return await alpacaRequest(env,"POST",PAPER_API,"/orders",{symbol,qty:String(qty),side:"sell",type:"market",time_in_force:"gtc",client_order_id:clientOrderId("sell",symbol)});
}
async function getOrder(env,orderId){return await alpacaRequest(env,"GET",PAPER_API,`/orders/${encodeURIComponent(orderId)}`);}
async function createTrade(env,symbol,observation,order,notional){
  await env.db.prepare(`INSERT INTO trades (symbol,status,notional,buy_order_id,entry_signal_bps,entry_spread_bps,opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(symbol,"buy_submitted",notional,order.id,observation.momentum_bps,observation.spread_bps,now(),now(),now()).run();
}
async function reconcileBuy(env,trade){
  const order=await getOrder(env,trade.buy_order_id);
  if(order.status==="filled"){
    const qty=num(order.filled_qty), price=num(order.filled_avg_price);
    if(!qty||!price)throw new Error("Filled buy missing quantity or price.");
    await env.db.prepare(`UPDATE trades SET status='open',quantity=?,entry_price=?,updated_at=? WHERE id=?`).bind(qty,price,now(),trade.id).run();
    await logEvent(env,"buy_filled","Paper buy filled.",trade.symbol,{trade_id:trade.id,qty,price});
    return {action:"buy_filled",symbol:trade.symbol,qty,price};
  }
  if(TERMINAL_ORDER_STATUSES.includes(order.status)){
    await env.db.prepare(`UPDATE trades SET status='failed',exit_reason=?,closed_at=?,updated_at=? WHERE id=?`).bind(`buy_${order.status}`,now(),now(),trade.id).run();
    return {action:"buy_failed",status:order.status};
  }
  return {action:"buy_pending",status:order.status};
}
async function reconcileSell(env,trade){
  const order=await getOrder(env,trade.sell_order_id);
  if(order.status!=="filled"){
    if(TERMINAL_ORDER_STATUSES.includes(order.status)){
      await env.db.prepare(`UPDATE trades SET status='open',sell_order_id=NULL,updated_at=? WHERE id=?`).bind(now(),trade.id).run();
      return {action:"sell_failed",status:order.status};
    }
    return {action:"sell_pending",status:order.status};
  }
  const exitPrice=num(order.filled_avg_price);
  const qty=num(order.filled_qty)||num(trade.quantity);
  if(!exitPrice||!qty)throw new Error("Filled sell missing quantity or price.");
  const entryPrice=num(trade.entry_price);
  const gross=(exitPrice-entryPrice)*qty;
  const estimatedFees=(entryPrice*qty+exitPrice*qty)*0.0025;
  const net=gross-estimatedFees;
  await env.db.prepare(`UPDATE trades SET status='closed',exit_price=?,gross_pnl=?,estimated_fees=?,estimated_net_pnl=?,closed_at=?,updated_at=? WHERE id=?`)
    .bind(exitPrice,gross,estimatedFees,net,now(),now(),trade.id).run();
  const loss=net<0;
  await env.db.prepare(loss
    ? `UPDATE bot_settings SET consecutive_losses=consecutive_losses+1,updated_at=? WHERE id=1`
    : `UPDATE bot_settings SET consecutive_losses=0,updated_at=? WHERE id=1`
  ).bind(now()).run();
  await env.db.prepare(`UPDATE strategy_params SET closed_trades=closed_trades+1,winning_trades=winning_trades+?,losing_trades=losing_trades+?,estimated_net_pnl=estimated_net_pnl+?,updated_at=? WHERE symbol=?`)
    .bind(loss?0:1,loss?1:0,net,now(),trade.symbol).run();
  await logEvent(env,"trade_closed","Paper trade closed.",trade.symbol,{trade_id:trade.id,gross_pnl:gross,estimated_fees:estimatedFees,estimated_net_pnl:net});
  return {action:"trade_closed",symbol:trade.symbol,gross_pnl:gross,estimated_fees:estimatedFees,estimated_net_pnl:net};
}
async function manageOpenTrade(env,trade,quotes){
  if(trade.status==="buy_submitted")return await reconcileBuy(env,trade);
  if(trade.status==="sell_submitted")return await reconcileSell(env,trade);
  if(trade.status!=="open")return {action:"nothing"};
  const quote=quotes[trade.symbol];
  if(!quote)return {action:"missing_quote"};
  const params=await strategy(env,trade.symbol);
  if(!params)throw new Error(`Strategy missing for ${trade.symbol}`);
  const entry=num(trade.entry_price), current=quote.bid;
  const moveBps=((current-entry)/entry)*10000;
  const heldMinutes=(Date.now()-new Date(trade.opened_at).getTime())/60000;
  const takeProfit=num(params.take_profit_bps), stopLoss=num(params.stop_loss_bps), maxHold=num(params.max_hold_minutes);
  let reason=null;
  if(moveBps>=takeProfit)reason="take_profit";
  else if(moveBps<=-stopLoss)reason="stop_loss";
  else if(heldMinutes>=maxHold)reason="max_hold";
  if(!reason)return {action:"hold",symbol:trade.symbol,move_bps:moveBps,held_minutes:heldMinutes};
  const qty=num(trade.quantity);
  if(!qty||qty<=0)throw new Error("Cannot exit trade: invalid quantity.");
  const order=await submitSell(env,trade.symbol,qty);
  await env.db.prepare(`UPDATE trades SET status='sell_submitted',sell_order_id=?,exit_reason=?,updated_at=? WHERE id=?`).bind(order.id,reason,now(),trade.id).run();
  await logEvent(env,"sell_submitted",`Paper exit submitted: ${reason}`,trade.symbol,{trade_id:trade.id,order_id:order.id,move_bps:moveBps});
  return {action:"sell_submitted",symbol:trade.symbol,reason,move_bps:moveBps};
}
async function riskCheck(env,s){
  if(num(s.paper_only)!==1)return {allowed:false,reason:"paper_only_lock"};
  if(num(s.kill_switch)===1)return {allowed:false,reason:"kill_switch"};
  if(num(s.enabled)!==1)return {allowed:false,reason:"trading_disabled"};
  if(num(s.consecutive_losses,0)>=num(s.consecutive_loss_limit,3))return {allowed:false,reason:"consecutive_loss_limit"};
  const pnl=await todayNetPnl(env);
  if(pnl<=-Math.abs(num(s.daily_loss_limit,5)))return {allowed:false,reason:"daily_loss_limit",daily_pnl:pnl};
  return {allowed:true,daily_pnl:pnl};
}
async function findEntry(env,observations){
  const candidates=[];
  for(const obs of observations){
    const params=await strategy(env,obs.symbol);
    if(!params||obs.momentum_bps===null)continue;
    const momentumThreshold=num(params.entry_momentum_bps), spreadLimit=num(params.max_spread_bps);
    if(obs.momentum_bps>=momentumThreshold&&obs.spread_bps<=spreadLimit)candidates.push({observation:obs,score:obs.momentum_bps-obs.spread_bps});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}
async function runCycle(env){
  validate(env);
  const s=await settings(env);
  if(num(s.paper_only)!==1)throw new Error("DATABASE PAPER SAFETY LOCK FAILED.");
  const quotes=await latestQuotes(env);
  const observations=[];
  for(const symbol of SYMBOLS)if(quotes[symbol])observations.push(await recordObservation(env,symbol,quotes[symbol]));
  await env.db.prepare(`UPDATE bot_settings SET last_cycle_at=?,updated_at=? WHERE id=1`).bind(now(),now()).run();
  const existing=await openTrade(env);
  if(existing){
    const management=await manageOpenTrade(env,existing,quotes);
    return {ok:true,version:VERSION,mode:"paper",observations,management};
  }
  const risk=await riskCheck(env,s);
  if(!risk.allowed)return {ok:true,version:VERSION,mode:"paper",observations,action:"no_trade",reason:risk.reason,daily_pnl:risk.daily_pnl??null};
  const entry=await findEntry(env,observations);
  if(!entry)return {ok:true,version:VERSION,mode:"paper",observations,action:"no_trade",reason:"no_valid_signal"};
  const notional=num(s.order_notional,12);
  const safeNotional=Math.min(Math.max(notional,10),12);
  const order=await submitBuy(env,entry.observation.symbol,safeNotional);
  await createTrade(env,entry.observation.symbol,entry.observation,order,safeNotional);
  await logEvent(env,"buy_submitted","Paper entry submitted.",entry.observation.symbol,{order_id:order.id,notional:safeNotional,momentum_bps:entry.observation.momentum_bps,spread_bps:entry.observation.spread_bps});
  return {ok:true,version:VERSION,mode:"paper",action:"buy_submitted",symbol:entry.observation.symbol,notional:safeNotional,momentum_bps:entry.observation.momentum_bps,spread_bps:entry.observation.spread_bps};
}
async function botStatus(env){
  const s=await settings(env), open=await openTrade(env), pnl=await todayNetPnl(env);
  const counts=await env.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed FROM trades`).first();
  const strategies=await env.db.prepare(`SELECT * FROM strategy_params ORDER BY symbol`).all();
  return {version:VERSION,mode:"paper",enabled:num(s.enabled)===1,kill_switch:num(s.kill_switch)===1,paper_only:num(s.paper_only)===1,order_notional:num(s.order_notional),hard_order_cap:12,daily_loss_limit:num(s.daily_loss_limit),consecutive_losses:num(s.consecutive_losses),consecutive_loss_limit:num(s.consecutive_loss_limit),today_estimated_net_pnl:pnl,open_trade:open||null,total_trades:num(counts?.total,0),closed_trades:num(counts?.closed,0),strategies:strategies.results||[],last_cycle_at:s.last_cycle_at};
}
async function recentTrades(env){const r=await env.db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT 50`).all();return r.results||[];}
async function recentEvents(env){const r=await env.db.prepare(`SELECT * FROM bot_events ORDER BY id DESC LIMIT 50`).all();return r.results||[];}
async function setEnabled(env,enabled){await env.db.prepare(`UPDATE bot_settings SET enabled=?,updated_at=? WHERE id=1`).bind(enabled?1:0,now()).run();}
async function setKill(env,enabled){await env.db.prepare(`UPDATE bot_settings SET kill_switch=?,enabled=CASE WHEN ?=1 THEN 0 ELSE enabled END,updated_at=? WHERE id=1`).bind(enabled?1:0,enabled?1:0,now()).run();}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(url.pathname==="/health")return json({ok:true,service:"crypto-trading-bot",version:VERSION,mode:"paper",execution_engine:"installed",safety_lock:"paper-only",symbols:SYMBOLS,time:now()});
      if(url.pathname==="/")return json({ok:true,service:"crypto-trading-bot",version:VERSION,mode:"paper",message:"Paper execution engine installed.",public:["GET /","GET /health"],owner_routes:["GET /bot/status","POST /bot/cycle","POST /bot/start","POST /bot/stop","POST /bot/kill","POST /bot/reset-kill","GET /bot/trades","GET /bot/events"]});
      if(!ownerAuthorized(request,env))return json({ok:false,error:"unauthorized"},401);
      validate(env);
      if(url.pathname==="/bot/status"&&request.method==="GET")return json({ok:true,bot:await botStatus(env)});
      if(url.pathname==="/bot/cycle"&&request.method==="POST")return json(await runCycle(env));
      if(url.pathname==="/bot/start"&&request.method==="POST"){
        const s=await settings(env);
        if(num(s.paper_only)!==1)throw new Error("Paper safety lock failed.");
        if(num(s.kill_switch)===1)return json({ok:false,error:"kill_switch_active"},409);
        await setEnabled(env,true); await logEvent(env,"bot_started","Paper trading enabled.");
        return json({ok:true,mode:"paper",enabled:true});
      }
      if(url.pathname==="/bot/stop"&&request.method==="POST"){await setEnabled(env,false);await logEvent(env,"bot_stopped","Paper trading disabled.");return json({ok:true,enabled:false});}
      if(url.pathname==="/bot/kill"&&request.method==="POST"){await setKill(env,true);await logEvent(env,"kill_switch","Kill switch activated.",null,null,"warning");return json({ok:true,kill_switch:true,enabled:false});}
      if(url.pathname==="/bot/reset-kill"&&request.method==="POST"){await setKill(env,false);await logEvent(env,"kill_switch_reset","Kill switch reset.");return json({ok:true,kill_switch:false,enabled:false});}
      if(url.pathname==="/bot/trades"&&request.method==="GET")return json({ok:true,trades:await recentTrades(env)});
      if(url.pathname==="/bot/events"&&request.method==="GET")return json({ok:true,events:await recentEvents(env)});
      return json({ok:false,error:"not_found"},404);
    }catch(error){return json({ok:false,version:VERSION,mode:"paper",error:error?.message||"Internal error"},500);}
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil(runCycle(env).catch(async error=>{await logEvent(env,"scheduled_cycle_error",error?.message||"Scheduled cycle failed.",null,null,"error");}));
  }
};
