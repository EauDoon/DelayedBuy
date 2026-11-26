const modules = [
  {id:'interface', label:'Reservation desk', x:-173,y:-68,z:30, file:'ui/reservation.mjs', route:'reservation',
    detail:'Two shoppers can request the same lamp. The merchant decides which request to accept. The desk reads and writes through the reservation store.'},
  {id:'store', label:'Reservation store', x:0,y:-120,z:-62, file:'ui/reservation-store.mjs', route:'reservation',
    detail:'A transaction checks the latest state before accepting the request. The store saves committed events and notifies other open tabs.'},
  {id:'policy', label:'One-unit policy', x:176,y:-52,z:12, file:'core/reservation.mjs', route:'reservation',
    detail:'Acceptance fixes the price and starts 24 hours on one lamp. A return, cancellation, release or expiry frees it exactly once.'},
  {id:'checkout', label:'Funded checkout', x:-174,y:60,z:-6, file:'ui/app.js', route:'checkout',
    detail:'This separate simulation lets a shopper hold demo funds and choose a waiting period. It does not allocate the reservation lamp.'},
  {id:'ledger', label:'Demo ledger', x:-28,y:114,z:70, file:'core/ledger.mjs', route:'merchant',
    detail:'Card and wallet balances reconcile independently. A refund returns principal to its original simulated funding source.'},
  {id:'report', label:'Scenario report', x:166,y:61,z:-70, file:'ui/report.mjs', route:'report',
    detail:'The report reads a fixed grid of 64 scenarios. Changing a modeling assumption does not change a shopper’s request or a demo balance.'},
  {id:'fixtures', label:'Model fixtures', x:16,y:6,z:42, file:'ui/report-data.mjs', route:'report',
    detail:'Two committed CSV inputs supply the offline report. Its illustrations can be inspected independently of browser history.'}
];
const edges = [['interface','store','saves requests through'],['store','policy','applies'],['checkout','ledger','records simulated movements in'],['report','fixtures','reads']];
const paths = {
  reservation: {name:'Reservation', color:'#ffa375'},
  checkout: {name:'Demo funds', color:'#bbacff'},
  report: {name:'Scenarios', color:'#9ae3c3'}
};
function pathFor(node) {
  return paths[node.route === 'merchant' ? 'checkout' : node.route];
}
// On a narrow plot, separate the three paths into horizontal bands.
const compactPositions = {
  interface:[-157,-78], store:[0,-119], policy:[157,-72],
  checkout:[-130,4], ledger:[134,-6], report:[-134,93], fixtures:[134,84]
};
const namespace = 'http://www.w3.org/2000/svg';

function svgElement(name, attributes) {
  const element = document.createElementNS(namespace,name);
  for (const [key,value] of Object.entries(attributes)) element.setAttribute(key,value);
  return element;
}

export function mountRehearsalMap(root, startingId) {
  let yaw = 0.12, pitch = -0.14;
  let selected = modules.find(node => node.id === startingId) || modules[0];
  root.innerHTML = `<div class="frame workspace map-page"><a class="backlink" href="#home">← Back to home</a>
    <header><p class="kicker">DelayedBuy / Architecture</p><h1>The rehearsal map.</h1>
    <p class="intro">Trace the one-unit reservation, demo funds and report from each interface to its rules and data.</p></header>
    <div class="map-grid"><div><section class="map-plot" aria-label="Interactive dependency map">
    <div class="map-legend" aria-label="Paths">
      ${Object.values(paths).map(path=>'<span style="--path:'+path.color+'">'+path.name+'</span>').join('')}
    </div>
    <svg class="map-svg" role="img" aria-label="Seven modules in three independent paths. Arrows point to dependencies. Select a module to inspect it."></svg>
    <div class="map-controls" aria-label="Map orientation"><p>Drag to rotate</p><button type="button" data-turn="-1" aria-label="Rotate left">←</button>
    <button type="button" data-turn="1" aria-label="Rotate right">→</button><button type="button" data-reset>Reset view</button></div></section>
    <details class="map-data"><summary>Inspect map data (JSON)</summary>
    <p>This read-only response describes the selected module and its dependencies.</p><pre></pre></details></div>
    <aside class="map-aside"><section class="map-note" aria-live="polite" aria-atomic="true"></section>
    <fieldset class="map-picker"><legend>Inspect another module</legend></fieldset></aside></div></div>`;
  const plot = root.querySelector('.map-svg'), note = root.querySelector('.map-note');
  const picker = root.querySelector('.map-picker');
  function point(node, width, height) {
    const [baseX,baseY] = width < 460 ? compactPositions[node.id] : [node.x,node.y];
    const x = baseX*Math.cos(yaw) + node.z*Math.sin(yaw);
    const z = node.z*Math.cos(yaw) - baseX*Math.sin(yaw);
    const y = baseY*Math.cos(pitch) - z*Math.sin(pitch);
    const scale = 650 / (650 - (z*Math.cos(pitch)+baseY*Math.sin(pitch)));
    return {x:width/2 + x*scale*(width-82)/450, y:height/2 + y*scale*(height-70)/280, scale};
  }
  const labelBounds = new Map();
  function draw() {
    const width=plot.clientWidth, height=plot.clientHeight;
    if (!width || !height) return;
    plot.setAttribute('viewBox', '0 0 '+width+' '+height);
    const points = new Map(modules.map(node => [node.id,point(node,width,height)]));
    const scene = document.createDocumentFragment();
    for (const [from,to] of edges) {
      const a=points.get(from), b=points.get(to);
      const color=pathFor(modules.find(node=>node.id===from)).color;
      const angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
      const x=a.x+(b.x-a.x)*0.56, y=a.y+(b.y-a.y)*0.56;
      scene.append(svgElement('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:color,class:[from,to].includes(selected.id)?'map-active':''}));
      scene.append(svgElement('path',{d:'M-5,-4 L4,0 -5,4',fill:'none',stroke:color,'stroke-width':2.5,
        transform:'translate('+x+' '+y+') rotate('+angle+')'}));
    }
    const nodes=[...modules].sort((a,b)=>points.get(a.id).scale-points.get(b.id).scale);
    for (const node of nodes) {
      const p=points.get(node.id), color=pathFor(node).color;
      const g=svgElement('g',{'data-module':node.id,transform:'translate('+p.x+' '+p.y+')'});
      const radius=6*p.scale;
      g.append(svgElement('circle',{r:20,fill:'transparent'}));
      if (node===selected) g.append(svgElement('circle',{r:radius+6,stroke:color,class:'map-halo'}));
      g.append(svgElement('circle',{r:radius,fill:color,stroke:'#2b2531','stroke-width':2}));
      scene.append(g);
    }
    // Keep text in screen pixels. Fit labels around the projected points as the view rotates.
    const occupied=[...points.values()].map(p=>({x:p.x-9,y:p.y-9,w:18,h:18}));
    plot.replaceChildren(scene);
    for (const node of [selected,...nodes.filter(node=>node!==selected)]) {
      const p=points.get(node.id);
      const label=svgElement('text',{'data-module':node.id,'text-anchor':'middle',class:node===selected?'map-active':''});
      label.textContent=node.label;
      plot.append(label);
      if (!labelBounds.has(node.id)) {
        const box=label.getBBox();
        labelBounds.set(node.id,{w:box.width+8,h:box.height+4,top:box.y-2});
      }
      const {w,h,top}=labelBounds.get(node.id);
      const x=Math.max(w/2+4,Math.min(width-w/2-4,p.x));
      const positions=[p.y+26,p.y-17];
      for (const box of occupied) {
        positions.push(box.y-top-h-1,box.y+box.h-top+1);
      }
      let best;
      for (const position of positions) {
        const y=Math.max(2-top,Math.min(height-2-top-h,position));
        const box={x:x-w/2,y:y+top,w,h,label:true};
        const cost=occupied.reduce((sum,b)=>sum+Math.max(0,Math.min(box.x+w,b.x+b.w)-Math.max(box.x,b.x))*
          Math.max(0,Math.min(box.y+h,b.y+b.h)-Math.max(box.y,b.y))*(b.label?1000:10),0)
          + Math.abs(y-(p.y+6));
        if (!best || cost<best.cost) best={y,box,cost};
      }
      if (Math.abs(best.y-p.y)>31 || Math.abs(x-p.x)>24) {
        const endY=best.y>p.y ? best.y-16 : best.y+5;
        const lead=svgElement('line',{x1:p.x,y1:p.y,x2:x,y2:endY,class:'map-leader'});
        plot.insertBefore(lead,plot.firstChild);
      }
      occupied.push(best.box);
      label.setAttribute('x',x);
      label.setAttribute('y',best.y);
    }
  }
  function inspect(node) {
    selected=node;
    const relationships=edges.filter(([from,to])=>from===node.id || to===node.id);
    const name=id=>modules.find(item=>item.id===id).label;
    const statements=relationships.map(([from,to,verb])=>name(from)+' '+verb+' '+name(to)+'.');
    note.style.setProperty('--path',pathFor(node).color);
    note.innerHTML='<p class="kicker">'+pathFor(node).name+' path</p><h2>'+node.label+'</h2><p>'+node.detail+'</p><p class="map-edge">'+statements.join(' ')+'</p>'+
      '<a href="#'+node.route+'">Open demo view →</a><a href="https://github.com/EauDoon/DelayedBuy/blob/main/'+node.file+'">View source · '+node.file+'</a>'+
      '<a href="#map/'+node.id+'">Link to this module</a>';
    root.querySelector('.map-data pre').textContent=JSON.stringify({data:{module:{id:node.id,name:node.label,path:node.file,
      dependencies:edges.filter(([from])=>from===node.id).map(([,to])=>({id:to,name:name(to)}))}}},null,2);
    for(const button of picker.querySelectorAll('button')) button.setAttribute('aria-pressed',String(button.dataset.module===node.id));
    draw();
  }
  for(const node of modules) {
    const button=document.createElement('button');
    button.type='button'; button.dataset.module=node.id; button.textContent=node.label;
    picker.append(button);
  }
  root.querySelector('.map-page').addEventListener('click', event=>{
    const target=event.target.closest('[data-module], [data-turn], [data-reset]');
    if(!target) return;
    if(target.dataset.module) { inspect(modules.find(node=>node.id===target.dataset.module)); return; }
    if(target.hasAttribute('data-reset')) { yaw=0.12; pitch=-0.14; }
    else yaw+=Number(target.dataset.turn)*Math.PI/8;
    draw();
  });
  let drag;
  plot.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !event.isPrimary) return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,pitch,initial:event.target.closest('[data-module]')?.dataset.module};
    plot.setPointerCapture(event.pointerId);
  });
  plot.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId) return;
    yaw=drag.yaw+(event.clientX-drag.x)*0.009;
    pitch=Math.max(-0.8,Math.min(0.8,drag.pitch+(event.clientY-drag.y)*0.006));
    draw();
  });
  plot.addEventListener('pointerup',event=>{
    if(drag?.id!==event.pointerId) return;
    if(drag.initial && Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5) inspect(modules.find(node=>node.id===drag.initial));
    drag=undefined;
  });
  plot.addEventListener('lostpointercapture',()=>{drag=undefined;});
  inspect(selected);
  const sizeObserver = new ResizeObserver(draw);
  sizeObserver.observe(plot);
  return () => sizeObserver.disconnect();
}
