window.BERTH_MARK = ["................",".......##.......","......####......",".....######.....","....########....","...##########...","..############..","..##..####..##..","......####......","......####......","......####......","................","................",".######..######.",".######..######.","................"];
window.markSvg = function(size,color){ const rows=window.BERTH_MARK; let r=""; for(let y=0;y<16;y++)for(let x=0;x<16;x++){ if(rows[y][x]==='#') r+=`<rect x="${x}" y="${y}" width="1" height="1"/>`; } return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${color}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${r}</svg>`; };

const C = document.getElementById('content');
const clamp01 = x => Math.max(0, Math.min(1, x));
const seg = (t,a,b) => clamp01((t-a)/(b-a));
const eOutExpo = x => x>=1?1:1-Math.pow(2,-10*x);
const eOutCubic = x => 1-Math.pow(1-x,3);
const lerp=(a,b,x)=>a+(b-a)*x;
const px=v=>v+'px';
function el(tag, css, html){ const e=document.createElement(tag); if(css)Object.assign(e.style,css); if(html!=null)e.innerHTML=html; C.appendChild(e); return e; }
const G = '#35d07f', RED='#f2564d';
const scenes = {};

scenes.open = () => {
  const wrap = el('div', { position:'absolute', left:'50%', top:'42%', transform:'translate(-50%,-50%)' });
  const size=360, cell=size/16;
  const grid = document.createElement('div'); Object.assign(grid.style,{ position:'relative', width:px(size), height:px(size) }); wrap.appendChild(grid);
  const cells=[]; const rows=window.BERTH_MARK; let idx=0;
  for(let y=0;y<16;y++) for(let x=0;x<16;x++){ if(rows[y][x]==='#'){ const d=document.createElement('div'); Object.assign(d.style,{position:'absolute',left:px(x*cell),top:px(y*cell),width:px(cell+0.5),height:px(cell+0.5),background:G}); grid.appendChild(d); cells.push({d,o:idx++}); } }
  const total=cells.length;
  const word = el('div', { position:'absolute', left:'50%', top:'66%', transform:'translate(-50%,-50%)', fontFamily:'Silkscreen,monospace', fontSize:'110px', letterSpacing:'6px' }, 'berth');
  const tag = el('div', { position:'absolute', left:'50%', top:'76%', transform:'translate(-50%,-50%)', fontFamily:'Silkscreen,monospace', fontSize:'26px', letterSpacing:'8px', color:'#9ba5b4' }, 'COINS THAT BUILD APPS');
  return (t)=>{
    const drawP = seg(t,0.1,1.4);
    cells.forEach(c=>{ const cp = clamp01((drawP*total - c.o)/2.2); c.d.style.opacity=cp; c.d.style.transform=`scale(${lerp(.4,1,eOutCubic(cp))})`; });
    wrap.style.filter = `drop-shadow(0 0 ${lerp(6,26,Math.sin(clamp01(seg(t,1.2,4.5))*Math.PI))}px rgba(53,208,127,.28))`;
    const wp = eOutExpo(seg(t,1.2,2.2)); word.style.opacity=wp; word.style.transform=`translate(-50%, calc(-50% + ${px((1-wp)*36)}))`;
    const tp = seg(t,2.1,3.1); tag.style.opacity=tp; tag.style.letterSpacing=px(lerp(18,8,eOutCubic(tp)));
    C.style.opacity = 1 - seg(t,4.15,4.5);
  };
};

scenes.thesis = () => {
  const l1full='most launches sell a promise.';
  const l2parts=[['berth ships a ', '#f3f5f7'],['product.', G]];
  const l1 = el('div',{ position:'absolute', left:'12%', top:'40%', fontSize:'66px', fontWeight:'600', color:'#c7cfdb', letterSpacing:'-.5px' });
  const l2 = el('div',{ position:'absolute', left:'12%', top:'52%', fontSize:'82px', fontWeight:'700', letterSpacing:'-1px' });
  const c1=document.createElement('span'); l1.appendChild(c1); const cur1=document.createElement('span'); cur1.className='cur'; l1.appendChild(cur1);
  const s2a=document.createElement('span'); s2a.style.color=l2parts[0][1]; const s2b=document.createElement('span'); s2b.style.color=l2parts[1][1];
  l2.appendChild(s2a); l2.appendChild(s2b); const cur2=document.createElement('span'); cur2.className='cur'; l2.appendChild(cur2);
  return (t)=>{
    const n1=Math.floor(clamp01(seg(t,0.2,1.5))*l1full.length); c1.textContent=l1full.slice(0,n1);
    cur1.style.opacity = (t<1.8 && Math.floor(t*2)%2===0)?1:0;
    l1.style.opacity = lerp(1,0.32,seg(t,1.9,2.3));
    const full2=l2parts[0][0]+l2parts[1][0]; const n2=Math.floor(clamp01(seg(t,1.9,3.4))*full2.length);
    const shown=full2.slice(0,n2); s2a.textContent=shown.slice(0,Math.min(shown.length,l2parts[0][0].length)); s2b.textContent=shown.slice(l2parts[0][0].length);
    cur2.style.opacity = (t>1.9 && t<3.4 && Math.floor(t*2)%2===0)?1:0;
    C.style.opacity = 1 - seg(t,4.2,4.5);
  };
};

scenes.loop = () => {
  const title = el('div',{ position:'absolute', left:'50%', top:'16%', transform:'translate(-50%,-50%)', fontSize:'58px', fontWeight:'700', letterSpacing:'-.5px', textAlign:'center', width:'80%' }, 'one sentence in. <span style="color:'+G+'">a real product out.</span>');
  const nodes=[ {t:'YOU',d:'write one sentence'},{t:'PUMP.FUN',d:'a coin launches'},{t:'TRADING FEES',d:'<span style="color:'+G+'">an AI builds</span> the app'},{t:'USERS PAY',d:'85% <span style="color:'+RED+'">burns</span> the coin'} ];
  const NW=380, GAP=70, startX=(1920-(NW*4+GAP*3))/2, Y=430;
  const nodeEls=nodes.map((n,i)=>el('div',{ position:'absolute', left:px(startX+i*(NW+GAP)), top:px(Y), width:px(NW), height:'190px', boxSizing:'border-box', border:'1px solid #2d3440', background:'#0d0f13', boxShadow:'6px 6px 0 rgba(0,0,0,.5)', padding:'30px 28px', display:'flex', flexDirection:'column', justifyContent:'center' }, `<div style="font-family:Silkscreen,monospace;font-size:15px;letter-spacing:2px;color:#7c8798">${n.t}</div><div style="font-size:31px;margin-top:14px">${n.d}</div>`));
  const arrows=[0,1,2].map(i=>el('div',{ position:'absolute', left:px(startX+NW+i*(NW+GAP)+GAP/2-16), top:px(Y+95-30), width:'32px', textAlign:'center', fontFamily:'JetBrains Mono', fontSize:'46px', color:'#7c8798' }, '→'));
  const chip1=el('div',{ position:'absolute', left:px(startX), top:px(Y+230), fontFamily:'JetBrains Mono', fontSize:'27px', color:'#c7cfdb', border:'1px solid #1e232c', background:'#0d0f13', padding:'16px 22px' }, 'fees → <b>60%</b> build · <b>25%</b> $BERTH · <b>15%</b> you');
  const chip2=el('div',{ position:'absolute', right:px(startX), top:px(Y+230), fontFamily:'JetBrains Mono', fontSize:'27px', color:'#c7cfdb', border:'1px solid #1e232c', background:'#0d0f13', padding:'16px 22px' }, 'revenue → <span style="color:'+RED+'">85% buyback + burn</span>');
  return (t)=>{
    const tp=eOutExpo(seg(t,0,1)); title.style.opacity=tp; title.style.transform=`translate(-50%, calc(-50% + ${px((1-tp)*30)}))`;
    nodeEls.forEach((e,i)=>{ const p=eOutCubic(seg(t,1+i*0.5,1.8+i*0.5)); e.style.opacity=p; e.style.transform=`translateY(${px((1-p)*40)})`; });
    arrows.forEach((a,i)=>{ a.style.opacity=seg(t,1.6+i*0.5,2.0+i*0.5); });
    chip1.style.opacity=eOutCubic(seg(t,3.4,4.1)); chip2.style.opacity=eOutCubic(seg(t,3.7,4.4));
    const pp=seg(t,4.6,6.9); nodeEls.forEach((e,i)=>{ const localCenter=(i+0.5)/4; const d=Math.abs(pp-localCenter); const glow=clamp01(1-d*7); const isBurn=i===3; const col=isBurn&&pp>0.72?RED:G; e.style.borderColor = glow>0.05?col:'#2d3440'; e.style.boxShadow = glow>0.05?`6px 6px 0 rgba(0,0,0,.5), 0 0 ${px(glow*34)} ${col}66`:'6px 6px 0 rgba(0,0,0,.5)'; });
    C.style.opacity = 1 - seg(t,7.6,8.0);
  };
};

scenes.receipts = () => {
  const title=el('div',{ position:'absolute', left:'12%', top:'20%', fontSize:'64px', fontWeight:'700', letterSpacing:'-.6px' }, 'engineered like infrastructure.');
  const stats=[ {v:211,l:'TESTS, NO NETWORK',fmt:'int'},{v:'31/0',l:'SECURITY CHECKS'},{v:0,l:'LEDGER DRIFT',tone:G},{v:'50/53',l:'FEATURE MATRIX'} ];
  const SX=['12%','32%','52%','70%'];
  const sEls=stats.map((s,i)=>{ const w=el('div',{ position:'absolute', left:SX[i], top:'40%' }); const v=document.createElement('div'); Object.assign(v.style,{fontFamily:'JetBrains Mono',fontWeight:'700',fontSize:'104px',letterSpacing:'-2px',color:s.tone||'#f3f5f7'}); const l=document.createElement('div'); Object.assign(l.style,{fontFamily:'Silkscreen,monospace',fontSize:'15px',letterSpacing:'2px',color:'#7c8798',marginTop:'16px'}); l.textContent=s.l; w.appendChild(v); w.appendChild(l); w._v=v; return w; });
  const lead=el('div',{ position:'absolute', left:'12%', top:'60%', fontSize:'33px', color:'#c7cfdb' }, 'a real build pipeline runs in production, end to end.');
  const punch1=el('div',{ position:'absolute', left:'12%', top:'44%', fontSize:'74px', fontWeight:'700', opacity:0 }, 'fees fund the build.');
  const punch2=el('div',{ position:'absolute', left:'12%', top:'56%', fontSize:'74px', fontWeight:'700', opacity:0 });
  punch2.innerHTML='revenue funds the <span style="color:'+RED+'">burn.</span>';
  return (t)=>{
    const tp=eOutExpo(seg(t,0,0.9)); title.style.opacity=tp; title.style.transform=`translateY(${px((1-tp)*24)})`;
    sEls.forEach((w,i)=>{ const p=seg(t,0.9+i*0.28,1.7+i*0.28); w.style.opacity=eOutCubic(p); w.style.transform=`translateY(${px((1-eOutCubic(p))*24)})`; const s=stats[i]; w._v.textContent = s.fmt==='int' ? Math.round(lerp(0,s.v,eOutCubic(p))) : s.v; });
    lead.style.opacity=eOutCubic(seg(t,2.4,3.2));
    const outp=seg(t,4.2,4.8); [title,...sEls,lead].forEach(e=>e.style.filter=`opacity(${1-outp})`);
    const p1=eOutExpo(seg(t,4.7,5.4)); punch1.style.opacity=p1; punch1.style.transform=`translateY(${px((1-p1)*24)})`;
    const p2=eOutExpo(seg(t,5.2,5.9)); punch2.style.opacity=p2; punch2.style.transform=`translateY(${px((1-p2)*24)})`;
    C.style.opacity=1-seg(t,7.6,8.0);
  };
};

scenes.end = () => {
  const wrap=el('div',{ position:'absolute', left:'50%', top:'42%', transform:'translate(-50%,-50%)', display:'flex', alignItems:'center', gap:'26px' });
  const mk=document.createElement('span'); mk.style.lineHeight='0'; mk.innerHTML=window.markSvg(96,G); wrap.appendChild(mk);
  const wd=document.createElement('span'); Object.assign(wd.style,{fontFamily:'Silkscreen,monospace',fontSize:'120px',letterSpacing:'4px'}); wd.textContent='berth'; wrap.appendChild(wd);
  const tag=el('div',{ position:'absolute', left:'50%', top:'56%', transform:'translate(-50%,-50%)', fontFamily:'Silkscreen,monospace', fontSize:'26px', letterSpacing:'8px', color:'#9ba5b4' }, 'COINS THAT BUILD APPS');
  const url=el('div',{ position:'absolute', left:'50%', top:'66%', transform:'translate(-50%,-50%)', fontFamily:'Silkscreen,monospace', fontSize:'44px', letterSpacing:'3px' }, 'berth.fun');
  const underline=el('div',{ position:'absolute', left:'50%', top:'71%', transform:'translateX(-50%)', height:'3px', background:G, width:'0px' });
  const foot=el('div',{ position:'absolute', left:'50%', top:'80%', transform:'translate(-50%,-50%)', fontSize:'24px', color:'#7c8798' }, 'fees fund the build. <span style="color:'+G+'">revenue funds the burn.</span>');
  return (t)=>{
    const p=eOutExpo(seg(t,0,1.2)); wrap.style.opacity=p; wrap.style.transform=`translate(-50%, calc(-50% + ${px((1-p)*24)})) scale(${lerp(.92,1,p)})`;
    tag.style.opacity=seg(t,1.0,2.0);
    url.style.opacity=eOutExpo(seg(t,2.0,2.8));
    underline.style.width=px(lerp(0,360,eOutCubic(seg(t,2.4,3.4))));
    foot.style.opacity=seg(t,2.6,3.6);
    C.style.opacity = Math.min(1, 1 - seg(t,4.7,5.0));
  };
};

try {
  const params=new URLSearchParams(location.search);
  const name=params.get('scene')||'open';
  const render=scenes[name]();
  window.__render=render;
  window.__seek=(t)=>{ render(t); };
  const tt=parseFloat(params.get('t')||'0'); window.__seek(isNaN(tt)?0:tt);
  window.__ready=true;
} catch(e){ window.__err = (e && e.stack) ? e.stack : String(e); }
