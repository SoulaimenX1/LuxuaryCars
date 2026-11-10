import { resolveAccessToken } from '@/lib/server-auth';
import { resolveVehicleInterval } from '@/lib/recent-booking-dates';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

// Proxy avec liste blanche : jamais d'URL choisie librement par le navigateur.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^RES-[A-Z0-9-]{5,30}$/i;
type Ctx = { params: Promise<{segments:string[]}> };
function allowed(parts:string[],method:string) {
  const route=parts.join('/');
  if (method==='GET') return route==='options'||route==='locations'||route==='me/favorites'||route==='me/loyalty'||route==='me/reviewable'||(parts[0]==='reviews'&&parts.length===2&&UUID.test(parts[1]))||(parts[0]==='editorial-reviews'&&parts.length===2&&UUID.test(parts[1]));
  if (method==='POST') return route==='quote'||route==='me/reviews'||(parts.length===3&&parts[0]==='me'&&parts[1]==='favorites'&&UUID.test(parts[2]))||(parts.length===3&&parts[0]==='me'&&parts[1]==='checkin'&&CODE.test(parts[2]));
  return false;
}
async function proxy(request:Request, ctx:Ctx, method:'GET'|'POST') {
  const {segments}=await ctx.params;
  if(!allowed(segments,method)) return NextResponse.json({message:'Not found'}, {status:404});
  if(method==='POST') {
    const origin=request.headers.get('origin');
    if(origin) { try {if(new URL(origin).host!==new URL(request.url).host) return NextResponse.json({message:'Origin rejected'}, {status:403});} catch{return NextResponse.json({message:'Invalid origin'}, {status:403});} }
  }
  const path=segments.join('/');
  const publicRoute=path==='options'||path==='locations'||path==='quote'||path.startsWith('reviews/')||path.startsWith('editorial-reviews/');
  const token=await resolveAccessToken();
  if(!publicRoute&&!token) return NextResponse.json({message:'Authentication required'}, {status:401});
  try {
    let body:string|undefined;
    let parsedQuote:Record<string,unknown>|null=null;
    if(method==='POST') {
      if(!request.headers.get('content-type')?.includes('application/json')) return NextResponse.json({message:'JSON required'}, {status:415});
      body=await request.text();
      if(body.length>6000) return NextResponse.json({message:'Request too large'}, {status:413});
      let parsed:unknown;
      try { parsed=JSON.parse(body); }
      catch { return NextResponse.json({message:'Invalid JSON'}, {status:400}); }
      if(path==='quote'&&parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) {
        const q={...(parsed as Record<string,unknown>)};
        if((!q.pickupAt||!q.returnAt)&&!q.pickupDate&&typeof q.vehicleId==='string'&&UUID.test(q.vehicleId)) {
          const resolved=await resolveVehicleInterval(q.vehicleId, 300);
          if(resolved) {
            q.pickupAt=resolved.pickupAt;
            q.returnAt=resolved.returnAt;
          }
        }
        if(typeof q.pickupAt==='string'&&q.pickupAt&&typeof q.returnAt==='string'&&q.returnAt) {
          delete q.pickupDate;
          delete q.returnDate;
        }
        if(typeof q.promotionCode==='string') {
          const trimmed=q.promotionCode.trim().toUpperCase();
          if(!/^[A-Z0-9_-]{3,30}$/.test(trimmed)) delete q.promotionCode;
          else q.promotionCode=trimmed;
        }
        if(Array.isArray(q.extraIds)) {
          const cleanExtras=q.extraIds.filter((id):id is string=>typeof id==='string'&&UUID.test(id));
          if(cleanExtras.length) q.extraIds=cleanExtras;
          else delete q.extraIds;
        }
        parsedQuote=q;
        body=JSON.stringify(q);
      }
    }
    const headers={...(token?{Authorization:`Bearer ${token}`}:{ }),...(method==='POST'?{'Content-Type':'application/json'}:{})};
    let r=await fetch(buildApiUrl(`/premium/${path}`),{
      method,headers,body,cache:'no-store'
    });
    let payload=await r.text();
    if(path==='quote'&&r.status===400&&parsedQuote&&(Array.isArray(parsedQuote.extraIds)||typeof parsedQuote.promotionCode==='string')) {
      const retryBody={...parsedQuote};
      if(/invalid or disabled rental extra/i.test(payload)) delete retryBody.extraIds;
      if(/promotion/i.test(payload)&&!retryBody.extraIds) delete retryBody.promotionCode;
      if(JSON.stringify(retryBody)!==body) {
        r=await fetch(buildApiUrl(`/premium/${path}`),{
          method,headers,body:JSON.stringify(retryBody),cache:'no-store'
        });
        payload=await r.text();
      }
    }
    try {return NextResponse.json(JSON.parse(payload),{status:r.status,headers:{'Cache-Control':'no-store'}});}
    catch {return NextResponse.json({message:'Invalid upstream response'}, {status:502});}
  } catch{return NextResponse.json({message:'Premium service unavailable'}, {status:502});}
}
export function GET(request:Request, ctx:Ctx){return proxy(request,ctx,'GET');}
export function POST(request:Request, ctx:Ctx){return proxy(request,ctx,'POST');}
