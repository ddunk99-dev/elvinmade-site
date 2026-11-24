import assert from "node:assert/strict";
class Mem{constructor(){this.m=new Map()}
  async get(k,o){const v=this.m.get(k);return v===undefined?null:(o?.type==='json'?JSON.parse(v):v)}
  async setJSON(k,v,o={}){if(o.onlyIfNew&&this.m.has(k))return{modified:false};this.m.set(k,JSON.stringify(v));return{modified:true,etag:'x'}}
  async delete(k){this.m.delete(k)}
  async list({prefix=''}={}){return{blobs:[...this.m.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key,etag:'x'})),directories:[]}}}
globalThis.__ES_STORES__={'es-reviews':new Mem,'es-orders':new Mem,'es-meta':new Mem,'es-limits':new Mem};
process.env.ADMIN_PASSWORD='correct-horse-battery';process.env.REVIEW_LINK_SECRET='s3cret-for-tests';process.env.SITE_URL='https://elvinmade.com';
const P=new URL('../netlify/functions/',import.meta.url).href;
const reviews=(await import(P+'reviews.mjs')).default, orders=(await import(P+'orders.mjs')).default,
  admin=(await import(P+'admin.mjs')).default, link=(await import(P+'order-link.mjs')).default;
let n=0;const ctx=()=>({ip:'10.0.0.'+(++n)});const fixed={ip:'9.9.9.9'};
const req=(url,method='GET',body,h={})=>new Request('https://x'+url,{method,headers:{'content-type':'application/json',...h},body:body?JSON.stringify(body):undefined});
const call=async(fn,r,c=ctx())=>{const res=await fn(r,c);return{status:res.status,body:await res.json()}};
const A={authorization:'Bearer correct-horse-battery'};
const old=Date.now()-60000;
const base={rating:5,name:'Jordan M.',body:'Beautiful bracelet, strung tight and the stones are gorgeous.',startedAt:old};

// empty list
let r=await call(reviews,req('/api/reviews'));assert.equal(r.status,200);assert.deepEqual(r.body.reviews,[]);
// honeypot + time trap silently dropped
r=await call(reviews,req('/api/reviews','POST',{...base,website:'spam.com'}));assert.equal(r.body.status,'pending');
r=await call(reviews,req('/api/reviews','POST',{...base,startedAt:Date.now()}));assert.equal(r.body.status,'pending');
assert.equal((await globalThis.__ES_STORES__['es-reviews'].list({prefix:'r/'})).blobs.length,0,'bots must not be stored');
// validation
r=await call(reviews,req('/api/reviews','POST',{...base,rating:7}));assert.equal(r.body.code,'rating');
r=await call(reviews,req('/api/reviews','POST',{...base,body:'short'}));assert.equal(r.body.code,'body');
// general review -> pending, not public
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,productName:'Trinity'}));assert.equal(r.status,201);assert.equal(r.body.status,'pending');
r=await call(reviews,req('/api/reviews'));assert.equal(r.body.reviews.length,0);
// rate limit: 3/hour per ip (only successful saves count)
for(let i=0;i<3;i++){r=await call(reviews,req('/api/reviews','POST',base),fixed);assert.equal(r.status,201)}
r=await call(reviews,req('/api/reviews','POST',base),fixed);assert.equal(r.status,429);
// order recorded from checkout
r=await call(orders,req('/api/orders','POST',{name:'Ana Diaz',email:'Ana@Example.com',items:[{id:225,name:'Trinity',qty:1},{id:9,name:'Golden Reaper',qty:1}]}));
assert.equal(r.status,201);const ref=r.body.ref;assert.match(ref,/^ES-\d{6}$/);
// verified attempt before confirmation
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,orderRef:ref,email:'ana@example.com'}));assert.equal(r.body.code,'order_not_confirmed');assert.equal(r.body.canPostUnverified,true);
// wrong email
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,orderRef:ref,email:'x@y.com'}));assert.equal(r.body.code,'order_not_found');
// admin auth
r=await call(admin,req('/api/admin?view=orders','GET',null,{authorization:'Bearer nope'}));assert.equal(r.status,401);
r=await call(admin,req('/api/admin','POST',{action:'confirmOrder',ref},A));assert.equal(r.body.order.status,'confirmed');
// verified -> auto-published
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,orderRef:ref.replace('ES-','es '),email:'ana@example.com'}));
assert.equal(r.status,201);assert.equal(r.body.status,'approved');assert.equal(r.body.review.verified,true);assert.equal(r.body.review.email,undefined);
// duplicate blocked
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,orderRef:ref,email:'ana@example.com'}));assert.equal(r.body.code,'already_reviewed');
// item not in order
r=await call(reviews,req('/api/reviews','POST',{...base,productId:16,orderRef:ref,email:'ana@example.com'}));assert.equal(r.body.code,'not_in_order');
// review link token flow (no email needed)
r=await call(admin,req('/api/admin','POST',{action:'reviewLink',ref},A));const url=new URL(r.body.url);
const [lref,tok]=url.searchParams.get('review').split('.');assert.equal(url.hash,'#reviews');
r=await call(link,req(`/api/order-link?r=${lref}&t=${tok}`));assert.equal(r.status,200);assert.equal(r.body.items.length,2);assert.equal(r.body.email,undefined);
r=await call(link,req(`/api/order-link?r=${lref}&t=bad`));assert.equal(r.status,404);
r=await call(reviews,req('/api/reviews','POST',{...base,title:'Gift for my dad',productId:9,orderRef:lref,token:tok}));assert.equal(r.body.status,'approved');
// verified with a link in it -> held
r=await call(reviews,req('/api/reviews','POST',{...base,body:'Great, also see www.cheap-deals.xyz for more stuff',orderRef:lref,token:tok}));assert.equal(r.body.status,'pending');
// public list shows 2 verified, no private fields
r=await call(reviews,req('/api/reviews'));assert.equal(r.body.reviews.length,2);
for(const x of r.body.reviews){assert.equal(x.email,undefined);assert.equal(x.orderRef,undefined);assert.equal(x.ipHash,undefined)}
// admin approve a pending general review, then hide it, then delete verified one frees slot
r=await call(admin,req('/api/admin?view=reviews','GET',null,A));const pend=r.body.reviews.find(x=>x.status==='pending'&&!x.verified);
await call(admin,req('/api/admin','POST',{action:'setStatus',id:pend.id,status:'approved'},A));
r=await call(reviews,req('/api/reviews'));assert.equal(r.body.reviews.length,3);
await call(admin,req('/api/admin','POST',{action:'setStatus',id:pend.id,status:'hidden'},A));
r=await call(reviews,req('/api/reviews'));assert.equal(r.body.reviews.length,2);
const v=r.body.reviews.find(x=>x.productId===225);
await call(admin,req('/api/admin','POST',{action:'deleteReview',id:v.id},A));
r=await call(reviews,req('/api/reviews','POST',{...base,productId:225,orderRef:ref,email:'ana@example.com'}));assert.equal(r.body.status,'approved','slot freed after delete');
// add past order manually
r=await call(admin,req('/api/admin','POST',{action:'addOrder',name:'Old Customer',email:'old@c.com',items:[{id:0,name:'Custom design'}]},A));assert.equal(r.body.order.status,'confirmed');
// lockout: 8 wrong then even right password is refused
for(let i=0;i<8;i++)await call(admin,req('/api/admin?view=orders','GET',null,{authorization:'Bearer wrong'}),fixed);
r=await call(admin,req('/api/admin?view=orders','GET',null,A),fixed);assert.equal(r.status,429);
// turnstile enforced when secret set
process.env.TURNSTILE_SECRET_KEY='ts';const of=globalThis.fetch;
globalThis.fetch=async()=>new Response(JSON.stringify({success:false}));
r=await call(reviews,req('/api/reviews','POST',{...base,turnstileToken:'t'}));assert.equal(r.body.code,'captcha');
globalThis.fetch=async()=>new Response(JSON.stringify({success:true}));
r=await call(reviews,req('/api/reviews','POST',{...base,turnstileToken:'t'}));assert.equal(r.status,201);
globalThis.fetch=of;delete process.env.TURNSTILE_SECRET_KEY;
// oversized body
r=await call(reviews,req('/api/reviews','POST',{...base,body:'x'.repeat(20000)}));assert.equal(r.status,413);
console.log('ALL BACKEND TESTS PASSED');
