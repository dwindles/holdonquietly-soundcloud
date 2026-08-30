// Screenshot a region: node clip.js out.png x y w h
const fs = require('fs');
async function main(){
  const [out,x,y,w,h] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6]];
  const list = await fetch('http://127.0.0.1:9222/json').then(r=>r.json());
  const t = list.filter(p=>p.type==='page'&&/soundcloud\.com/.test(p.url||'')).sort((a,b)=>a.url.length-b.url.length)[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  const r = await send('Page.captureScreenshot',{format:'png',clip:{x,y,width:w,height:h,scale:2}});
  fs.writeFileSync(out, Buffer.from(r.data,'base64'));
  console.log('wrote',out);
  ws.close();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
