import type { Bindings } from "./types";
import { isUsageService, serviceUnits, type UsageService } from "./usage";

type AdminRange = {
  from: number;
  to: number;
  bucket: "hour" | "day" | "month";
};

const bucketSql = {
  hour: "strftime('%Y-%m-%dT%H:00:00Z', created_at, 'unixepoch')",
  day: "strftime('%Y-%m-%dT00:00:00Z', created_at, 'unixepoch')",
  month: "strftime('%Y-%m-01T00:00:00Z', created_at, 'unixepoch')",
} as const;

export function adminHtmlResponse() {
  return new Response(adminHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function adminScriptResponse() {
  return new Response(adminScript, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function adminStyleResponse() {
  return new Response(adminStyle, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function parseAdminRange(url: URL): AdminRange | null {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fromDate = url.searchParams.has("from") ? new Date(url.searchParams.get("from") ?? "") : monthStart;
  const toDate = url.searchParams.has("to") ? new Date(url.searchParams.get("to") ?? "") : now;
  const bucketValue = url.searchParams.get("bucket") ?? "day";
  if (
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(toDate.getTime()) ||
    fromDate >= toDate ||
    !["hour", "day", "month"].includes(bucketValue)
  ) {
    return null;
  }
  return {
    from: Math.floor(fromDate.getTime() / 1000),
    to: Math.floor(toDate.getTime() / 1000),
    bucket: bucketValue as AdminRange["bucket"],
  };
}

export async function getAdminStats(env: Bindings, range: AdminRange) {
  const timeExpression = bucketSql[range.bucket];
  const [byCategory, byUser, byTime] = await Promise.all([
    env.DB.prepare(
      `SELECT service, unit, SUM(quantity) AS quantity, COUNT(*) AS events
       FROM usage_event
       WHERE created_at >= ? AND created_at < ?
       GROUP BY service, unit
       ORDER BY service, unit`,
    )
      .bind(range.from, range.to)
      .all(),
    env.DB.prepare(
      `SELECT u.id AS user_id, u.name, u.email, e.service, e.unit,
              SUM(e.quantity) AS quantity, COUNT(*) AS events
       FROM usage_event e
       JOIN user u ON u.id = e.user_id
       WHERE e.created_at >= ? AND e.created_at < ?
       GROUP BY u.id, u.name, u.email, e.service, e.unit
       ORDER BY quantity DESC, u.name`,
    )
      .bind(range.from, range.to)
      .all(),
    env.DB.prepare(
      `SELECT ${timeExpression} AS bucket, service, unit,
              SUM(quantity) AS quantity, COUNT(*) AS events
       FROM usage_event
       WHERE created_at >= ? AND created_at < ?
       GROUP BY bucket, service, unit
       ORDER BY bucket DESC, service, unit`,
    )
      .bind(range.from, range.to)
      .all(),
  ]);

  return {
    range: {
      from: new Date(range.from * 1000).toISOString(),
      to: new Date(range.to * 1000).toISOString(),
      bucket: range.bucket,
    },
    byCategory: byCategory.results,
    byUser: byUser.results,
    byTime: byTime.results,
  };
}

export async function getAdminUsers(env: Bindings) {
  const [users, quotas] = await Promise.all([
    env.DB.prepare("SELECT id, name, email, created_at FROM user ORDER BY created_at DESC").all(),
    env.DB.prepare(
      `SELECT user_id, service, unit, limit_value, updated_at
       FROM user_quota
       ORDER BY user_id, service`,
    ).all(),
  ]);
  return { users: users.results, quotas: quotas.results };
}

export async function setAdminQuota(
  env: Bindings,
  userId: string,
  service: unknown,
  limit: unknown,
) {
  if (!isUsageService(service)) return { error: "Invalid service", status: 400 as const };
  if (limit !== null && (!Number.isSafeInteger(limit) || (limit as number) < 0)) {
    return { error: "limit must be null or a non-negative safe integer", status: 400 as const };
  }
  const existingUser = await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(userId).first();
  if (!existingUser) return { error: "User not found", status: 404 as const };

  const unit = serviceUnits[service];
  if (limit === null) {
    await env.DB.prepare("DELETE FROM user_quota WHERE user_id = ? AND service = ? AND unit = ?")
      .bind(userId, service, unit)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO user_quota (user_id, service, unit, limit_value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service, unit) DO UPDATE SET
         limit_value = excluded.limit_value,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, service, unit, limit as number, Math.floor(Date.now() / 1000))
      .run();
  }
  return { userId, service: service as UsageService, unit, limit };
}

const adminHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>File Transfer 管理</title>
  <link rel="stylesheet" href="/admin/admin.css">
</head>
<body>
  <main>
    <header><div><h1>File Transfer 管理</h1><p>计费用量统计与用户额度调整</p></div><button id="refresh">刷新</button></header>
    <section class="card filters">
      <label>开始时间<input id="from" type="datetime-local"></label>
      <label>结束时间<input id="to" type="datetime-local"></label>
      <label>时间粒度<select id="bucket"><option value="hour">小时</option><option value="day" selected>天</option><option value="month">月</option></select></label>
      <button id="apply">应用筛选</button>
    </section>
    <p id="status" role="status"></p>
    <section class="card"><h2>按类别</h2><div class="table"><table><thead><tr><th>类别</th><th>单位</th><th>用量</th><th>事件数</th></tr></thead><tbody id="category"></tbody></table></div></section>
    <section class="card"><h2>按用户</h2><div class="table"><table><thead><tr><th>用户</th><th>邮箱</th><th>类别</th><th>用量</th><th>事件数</th></tr></thead><tbody id="users-stats"></tbody></table></div></section>
    <section class="card"><h2>按时间</h2><div class="table"><table><thead><tr><th>时间</th><th>类别</th><th>用量</th><th>事件数</th></tr></thead><tbody id="time"></tbody></table></div></section>
    <section class="card">
      <h2>调整用户额度</h2>
      <form id="quota-form">
        <label>用户<select id="quota-user" required></select></label>
        <label>类别<select id="quota-service" required></select></label>
        <label>额度<input id="quota-limit" type="number" min="0" step="1" placeholder="留空表示删除额度"></label>
        <button type="submit">保存额度</button>
      </form>
      <div class="table"><table><thead><tr><th>用户</th><th>类别</th><th>单位</th><th>额度</th><th>更新时间</th></tr></thead><tbody id="quotas"></tbody></table></div>
    </section>
  </main>
  <script src="/admin/admin.js" defer></script>
</body>
</html>`;

const adminStyle = `:root{font-family:Inter,system-ui,sans-serif;color:#13233a;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1,h2,p{margin:0}header p{color:#62738a;margin-top:6px}.card{background:#fff;border:1px solid #dce5f0;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 8px 24px #183b6610}.filters,form{display:flex;flex-wrap:wrap;gap:14px;align-items:end}label{display:grid;gap:6px;font-weight:700;font-size:14px}input,select,button{font:inherit;border:1px solid #c7d5e7;border-radius:9px;padding:10px 12px;background:#fff}button{background:#166fe5;color:#fff;border-color:#166fe5;font-weight:800}button:hover{background:#0e5fc9}.table{overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse;min-width:680px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e6edf5;font-size:14px}th{color:#536780;background:#f8fafd}#status{min-height:24px;color:#166fe5;font-weight:700}.error{color:#c63838!important}@media(max-width:650px){main{padding:16px}header{align-items:start;gap:16px}.filters label,form label{width:100%}}`;

const adminScript = `const services={direct:['Direct','bytes'],stun:['STUN','bytes'],turn:['TURN','bytes'],sfu:['SFU','bytes'],r2:['R2','bytes'],durable:['Durable','requests']};
const el=id=>document.getElementById(id);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format=(value,unit)=>unit==='bytes'?formatBytes(Number(value)):Number(value).toLocaleString('zh-CN')+' 次';
function formatBytes(value){if(!Number.isFinite(value)||value<=0)return '0 B';const units=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(value)/Math.log(1024)),units.length-1);return (value/1024**i).toFixed(i?2:0)+' '+units[i]}
function localInput(date){const offset=date.getTimezoneOffset()*60000;return new Date(date.getTime()-offset).toISOString().slice(0,16)}
function setDefaults(){const now=new Date();el('to').value=localInput(now);el('from').value=localInput(new Date(now.getFullYear(),now.getMonth(),1))}
function row(values){return '<tr>'+values.map(value=>'<td>'+value+'</td>').join('')+'</tr>'}
async function json(url,init){const response=await fetch(url,init);const body=await response.json();if(!response.ok)throw new Error(body.error||'HTTP '+response.status);return body}
let userNames=new Map();
async function load(){el('status').className='';el('status').textContent='读取中...';try{const params=new URLSearchParams({from:new Date(el('from').value).toISOString(),to:new Date(el('to').value).toISOString(),bucket:el('bucket').value});const [stats,directory]=await Promise.all([json('/admin/api/stats?'+params),json('/admin/api/users')]);userNames=new Map(directory.users.map(user=>[user.id,user.name||user.email]));el('category').innerHTML=stats.byCategory.map(item=>row([esc(services[item.service]?.[0]||item.service),esc(item.unit),format(item.quantity,item.unit),Number(item.events).toLocaleString('zh-CN')])).join('')||row(['暂无数据','','','']);el('users-stats').innerHTML=stats.byUser.map(item=>row([esc(item.name),esc(item.email),esc(services[item.service]?.[0]||item.service),format(item.quantity,item.unit),Number(item.events).toLocaleString('zh-CN')])).join('')||row(['暂无数据','','','','']);el('time').innerHTML=stats.byTime.map(item=>row([esc(item.bucket),esc(services[item.service]?.[0]||item.service),format(item.quantity,item.unit),Number(item.events).toLocaleString('zh-CN')])).join('')||row(['暂无数据','','','']);el('quota-user').innerHTML=directory.users.map(user=>'<option value="'+esc(user.id)+'">'+esc(user.name)+' · '+esc(user.email)+'</option>').join('');el('quota-service').innerHTML=Object.entries(services).map(([key,value])=>'<option value="'+key+'">'+value[0]+' ('+value[1]+')</option>').join('');el('quotas').innerHTML=directory.quotas.map(item=>row([esc(userNames.get(item.user_id)||item.user_id),esc(services[item.service]?.[0]||item.service),esc(item.unit),format(item.limit_value,item.unit),new Date(item.updated_at*1000).toLocaleString('zh-CN')])).join('')||row(['暂无额度','','','','']);el('status').textContent='已更新 '+new Date().toLocaleTimeString('zh-CN')}catch(error){el('status').className='error';el('status').textContent=error instanceof Error?error.message:String(error)}}
el('quota-form').addEventListener('submit',async event=>{event.preventDefault();const userId=el('quota-user').value;const raw=el('quota-limit').value;try{await json('/admin/api/users/'+encodeURIComponent(userId)+'/quota',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:el('quota-service').value,limit:raw===''?null:Number(raw)})});await load()}catch(error){el('status').className='error';el('status').textContent=error instanceof Error?error.message:String(error)}});el('apply').addEventListener('click',load);el('refresh').addEventListener('click',load);setDefaults();load();`;
