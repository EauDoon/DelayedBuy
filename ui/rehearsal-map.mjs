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
    <div class="map-grid"><section class="map-plot" aria-label="Interactive dependency map">
    <svg class="map-svg" viewBox="-275 -175 550 350" role="img" aria-label="Seven modules in three independent paths. Select modules in the list below."></svg>
    <div class="map-controls" aria-label="Map orientation"><button type="button" data-turn="-1" aria-label="Rotate left">←</button>
    <button type="button" data-turn="1" aria-label="Rotate right">→</button><button type="button" data-reset>Reset view</button></div></section>
    <section class="map-note" aria-live="polite" aria-atomic="true"></section></div>
    <fieldset class="map-picker"><legend>Inspect a module</legend></fieldset>
    <details class="map-data"><summary>Inspect map data (JSON)</summary>
    <p>This read-only response describes the selected module and its dependencies.</p><pre></pre></details></div>`;
  const plot = root.querySelector('.map-svg'), note = root.querySelector('.map-note');
  const picker = root.querySelector('.map-picker');
  function point(node) {
    const x = node.x*Math.cos(yaw) + node.z*Math.sin(yaw);
    const z = node.z*Math.cos(yaw) - node.x*Math.sin(yaw);
    const y = node.y*Math.cos(pitch) - z*Math.sin(pitch);
    const scale = 650 / (650 - (z*Math.cos(pitch)+node.y*Math.sin(pitch)));
    return {x:x*scale,y:y*scale,scale};
  }
  function draw() {
    const points = new Map(modules.map(node => [node.id,point(node)]));
    const scene = document.createDocumentFragment();
    for (const [from,to] of edges) {
      const a=points.get(from), b=points.get(to);
      scene.append(svgElement('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:[from,to].includes(selected.id)?'map-active':''}));
    }
    for (const node of [...modules].sort((a,b)=>points.get(a.id).scale-points.get(b.id).scale)) {
      const p=points.get(node.id);
      const g=svgElement('g',{'data-module':node.id,transform:'translate('+p.x+' '+p.y+') scale('+p.scale+')',class:node===selected?'map-active':''});
      const label=svgElement('text',{y:23,'text-anchor':'middle'});
      label.textContent=node.label;
      g.append(svgElement('circle',{r:15,class:'map-hit'}),svgElement('circle',{r:6}),label);
      scene.append(g);
    }
    plot.replaceChildren(scene);
  }
  function inspect(node) {
    selected=node;
    const relationships=edges.filter(([from,to])=>from===node.id || to===node.id);
    const name=id=>modules.find(item=>item.id===id).label;
    const statements=relationships.map(([from,to,verb])=>name(from)+' '+verb+' '+name(to)+'.');
    note.innerHTML='<p class="kicker">Module detail</p><h2>'+node.label+'</h2><p>'+node.detail+'</p><p class="map-edge">'+statements.join(' ')+'</p>'+
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
}
