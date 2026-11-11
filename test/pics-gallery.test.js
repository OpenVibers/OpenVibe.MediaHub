'use strict';
const assert = require('assert');
const sharp = require('sharp');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const text = buf.toString('utf8');
                resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] || null }, text, buffer: buf, json() { return JSON.parse(text); } });
            });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}


(async () => {
 const t = await boot(); const get = hostClient(t); const a = t.network.addUser('galleryauthor'); const b = t.network.addUser('reader');
 const same = { 'sec-fetch-site': 'same-origin' };
 try {
 const image = (await t.ctx.pics.upload({requester: `user:${a.subject}`}, {buffer: await sharp({create:{width:120,height:90,channels:3,background:'#246'}}).png().toBuffer(), name:'forest.png'}, {title:'Forest'})).image;
 await check('Pics comment writes require a signed-in person', async () => {
   const out = await get(`/api/v1/images/${image.slug}/comments`, { json: { message: 'hello' }, headers: same });
   assert.equal(out.status, 401, out.text);
 });
 const pub = (as, json) => get(`/api/v1/images/${image.slug}/publication`, { as, json, headers: same });
 await check('resumable chunks enforce ownership, offsets and idempotent completion', async () => {
   const bytes = await sharp({create:{width:31,height:41,channels:3,background:'#a42'}}).png().toBuffer();
   const created = await get('/api/v1/uploads',{as:a,json:{size:bytes.length,content_type:'image/png'},headers:same});
   assert.equal(created.status,201,created.text); const u=created.json();
   assert.equal((await get(`/api/v1/uploads/${u.id}`,{as:b})).status,404);
   const send = (offset, body) => get(`/api/v1/uploads/${u.id}`,{as:a,method:'PATCH',body,headers:{...same,'content-type':'application/octet-stream','upload-offset':String(offset)}});
   assert.equal((await send(1,bytes)).status,409);
   assert.equal((await send(0,bytes)).status,200);
   const complete = () => get(`/api/v1/uploads/${u.id}/complete`,{as:a,method:'POST',headers:same});
   const first = await complete(); assert.equal(first.status,201,first.text);
   const again = await complete(); assert.equal(again.status,200,again.text); assert.equal(first.json().id,again.json().id);
 });
 await check('new uploads are unlisted: reachable by their link, never in the gallery', async () => {
   assert.equal((await get(`/i/${image.slug}`)).status,200);
   assert.equal((await get(`/api/v1/pictures/${image.id}`)).status,200);
   assert.equal((await get('/api/v1/gallery')).json().pictures.length,0);
   assert.equal((await get(`/i/${image.slug}`,{as:a})).status,200);
 });
 await check('publishing requires owner, same origin and valid tags', async () => {
   // The picture is visible by its link, so a stranger is refused, not told it is missing.
   assert.equal((await pub(b,{listed:true})).status,403);
   assert.equal((await get(`/api/v1/images/${image.slug}/publication`,{as:a,json:{listed:true}})).status,403);
   assert.equal((await pub(a,{listed:true,tags:['<script>']})).status,422);
   assert.equal((await pub(a,{listed:true,tags:['forest']})).status,200);
 });
 await check('public gallery, search, HTML and indexing expose only published pictures', async () => {
   const list = (await get('/api/v1/gallery?tag=forest')).json(); assert.equal(list.pictures.length,1); assert.equal(list.pictures[0].title,'Forest');
   assert.equal((await get('/api/v1/gallery?q=unmatched')).json().pictures.length,0);
   const home = await get('/'); assert.equal(home.status,200,home.text); assert.ok(home.text.includes('Forest'));
   const page = await get(`/i/${image.slug}`); assert.ok(page.text.includes('ImageObject')); assert.ok(page.text.includes('index, follow'));
   assert.ok((await get('/sitemap.xml')).text.includes(`/i/${image.slug}`));
 });
 await check('likes and daily views are idempotent and public-only', async () => {
   for(let i=0;i<2;i++) assert.equal((await get(`/api/v1/images/${image.slug}/like`,{as:b,method:'PUT',headers:same})).status,200);
   await get(`/i/${image.slug}`); await get(`/i/${image.slug}`);
   const row = (await get('/api/v1/gallery')).json().pictures[0]; assert.equal(row.likes,1); assert.equal(row.views,1);
 });
 await check('narrowing sharing removes picture from discovery immediately', async () => {
   await t.ctx.sharing.setAudience({kind:'user',subject:a.subject},'picture',image.id,'private');
   assert.equal((await get('/api/v1/gallery')).json().pictures.length,0);
   assert.equal((await get(`/api/v1/pictures/${image.id}`)).status,404);
   assert.equal((await get(`/i/${image.slug}/thumb.webp`)).status,404);
 });
 await check('moderation removes public pictures and owner can unpublish', async () => {
   assert.equal((await pub(a,{listed:true})).status,200);
   await t.ctx.s.db.query("UPDATE pics_images SET state = 'hidden' WHERE id = $1",[image.id]);
   assert.equal((await get('/api/v1/gallery')).json().pictures.length,0);
   assert.equal((await pub(a,{listed:true})).status,422);
   assert.equal((await pub(a,{listed:false})).status,200);
 });
 } finally { await t.close(); } done();
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exit(1);});
