// Original lathed Arc study. The photograph remains the accessible, zero-GPU fallback.
const VERT = `
attribute vec3 aPos, aNorm, aColor;
uniform vec3 eye;
uniform float aspect;
varying vec3 pos, norm, color;
void main() {
  vec3 target = vec3(0.,1.42,0.);
  vec3 f = normalize(target-eye), r = normalize(cross(f,vec3(0.,1.,0.))), u = cross(r,f);
  vec3 d = aPos-eye;
  float z = dot(d,f);
  gl_Position = vec4(dot(d,r)*3.10/aspect, dot(d,u)*3.10, z*1.002-0.2, z);
  pos=aPos; norm=aNorm; color=aColor;
}`;
const FRAG = `
precision highp float;
uniform vec3 eye;
varying vec3 pos, norm, color;
float sq(float x){return x*x;}
void main() {
  vec3 n=normalize(norm), v=normalize(eye-pos), l=normalize(vec3(-3.,6.,3.));
  float grain=fract(sin(dot(mod(gl_FragCoord.xy,256.),vec2(12.97,7.81)))*734.53)-0.5;
  vec3 c;
  if(color.r<0.) {
    vec2 p=pos.xz;
    vec2 shadow=p-vec2(.40,-.36);
    float soft=exp(-dot(shadow,shadow)*1.4), contact=exp(-dot(p,p)*4.4);
    float farLight=smoothstep(-4.,5.,dot(p,vec2(-.64,.42)));
    c=mix(vec3(.58,.46,.72),vec3(.86,.75,.93),farLight);
    c*=1.-.24*soft-.36*contact;
  } else {
    float ndl=max(dot(n,l),0.);
    vec3 reflected=reflect(-v,n);
    // Two tall studio softboxes reflected in the glazed shade and stem.
    float box=exp(-sq((reflected.x+.63)*5.6)-sq((reflected.y-.53)*2.7))*smoothstep(-.2,.8,reflected.z);
    float seam=smoothstep(.005,.05,abs(reflected.x+.63));
    float ribbon=exp(-sq((reflected.x-.86)*8.)-sq((reflected.y-.2)*1.9));
    float edge=pow(1.-max(dot(n,v),0.),3.);
    c=color*(.50+.57*ndl+.15*max(n.y,0.));
    c+=vec3(1.,.82,.69)*box*(.62+.32*seam)+vec3(.52,.48,.65)*(.47*ribbon+.20*edge);
  }
  gl_FragColor=vec4(clamp(c+grain*.004,0.,1.),1.);
}`;
const TAU=2*Math.PI;
function scene() {
  const data=[];
  const add=(p,n,c)=>data.push(...p,...n,...c);
  const ground=[-1,0,0], glaze=[.88,.235,.064], shade=[.95,.265,.058], inner=[.78,.43,.22];
  const a=[-65,-.016,-65], b=[65,-.016,-65], c=[65,-.016,65], d=[-65,-.016,65];
  for(const p of [a,c,b,a,d,c]) add(p,[0,1,0],ground);
  function lathe(rows,col) {
    const count=80;
    function item(i,j){
      const [rad,y]=rows[i], before=rows[Math.max(0,i-1)], after=rows[Math.min(rows.length-1,i+1)];
      const dr=after[0]-before[0], dy=after[1]-before[1], len=Math.hypot(dr,dy)||1;
      const ang=TAU*j/count, co=Math.cos(ang), si=Math.sin(ang);
      add([rad*co,y,rad*si],[dy/len*co,-dr/len,dy/len*si],col);
    }
    for(let i=0;i<rows.length-1;i++)for(let j=0;j<count;j++)
      for(const [row,colIndex] of [[i,j],[i+1,j],[i,j+1],[i,j+1],[i+1,j],[i+1,j+1]])item(row,colIndex);
  }
  // A rolled base, flared foot, narrow stem and spun dome. Ordered bottom to top.
  lathe([[.01,.012],[.55,.012],[.635,.025],[.66,.047],[.66,.074],[.642,.099],[.59,.11],
    [.535,.119],[.492,.145],[.467,.19],[.45,.268],[.424,.357],[.387,.412],[.335,.457],
    [.247,.495],[.192,.523],[.155,.56],[.134,.62],[.124,.7],[.124,1.48],[.145,1.53],[.195,1.56]],glaze);
  lathe([[.02,1.54],[.2,1.53],[.8,1.527],[1.13,1.51],[1.188,1.515]],inner);
  const shell=[[1.184,1.505],[1.198,1.515],[1.204,1.535]];
  for(let i=0;i<=32;i++){
    const t=i*Math.PI/64;
    shell.push([Math.max(.0001,1.204*Math.cos(t)),1.55+1.20*Math.sin(t)]);
  }
  lathe(shell,shade);
  // Power cord: a real asymmetric part that makes camera perspective readable.
  const samples=56, sides=9;
  const path=t=>[.20+2.9*t,.026,-.07-.44*Math.sin(t*Math.PI*2.15)-.80*t];
  const tube=(i,j)=>{
    const t=i/samples, p=path(t), q=path(t+.001), dx=q[0]-p[0],dz=q[2]-p[2],l=Math.hypot(dx,dz);
    const a=TAU*j/sides, n=[-dz/l*Math.cos(a),Math.sin(a),dx/l*Math.cos(a)];
    add([p[0]+n[0]*.019,p[1]+n[1]*.019,p[2]+n[2]*.019],n,[.28,.13,.11]);
  };
  for(let i=0;i<samples;i++)for(let j=0;j<sides;j++)
    for(const [k,h] of [[i,j],[i+1,j+1],[i+1,j],[i,j],[i,j+1],[i+1,j+1]])tube(k,h);
  return new Float32Array(data);
}
let geometry;
export function mountLampStudio(root) {
  const canvas=root.querySelector('.studio-canvas');
  if(!canvas?.getContext) return;
  const stage=canvas.parentElement, button=stage.querySelector('.studio-turn');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(reduced.matches) return;
  const gl=canvas.getContext('webgl',{alpha:false,antialias:true,preserveDrawingBuffer:false,powerPreference:'low-power'});
  if(!gl) return;
  const shaders=[];
  let program, buffer, frame=0, observer, resizeObserver, active=true, onScreen=true, disposed=false;
  let start=0, from=-.56, to=.22, angle=from, lift=.68, first=true, pending=true;
  function showFallback(){
    canvas.hidden=true; button.hidden=true; active=false; cancelAnimationFrame(frame); frame=0;
  }
  function dispose(){
    if(disposed)return;
    disposed=true;showFallback();observer?.disconnect(); resizeObserver?.disconnect();
    button.removeEventListener('click',turn); document.removeEventListener('visibilitychange',visibility);
    canvas.removeEventListener('webglcontextlost',lost); reduced.removeEventListener('change',preference);
    if(buffer)gl.deleteBuffer(buffer);
    if(program)gl.deleteProgram(program);
    for(const shader of shaders)gl.deleteShader(shader);
    // Release the context immediately when visiting another hash route.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  function lost(e){e.preventDefault();showFallback();}
  function preference(){ if(reduced.matches)dispose(); }
  function visibility(){ if(document.hidden){cancelAnimationFrame(frame);frame=0;}else schedule(); }
  function schedule(){if(active&&onScreen&&!document.hidden&&!frame)frame=requestAnimationFrame(draw);}
  let eye, aspect, total;
  function draw(now){
    frame=0;if(!active||!stage.isConnected||reduced.matches)return;
    if(!start)start=now;
    const t=Math.min((now-start)/(first?2700:1500),1),ease=t*t*(3-2*t);
    angle=from+(to-from)*ease;
    const width=stage.clientWidth,height=stage.clientHeight;
    if(!width||!height)return;
    const ratio=Math.min(window.devicePixelRatio||1,1.45,900/Math.max(width,height));
    const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    gl.viewport(0,0,w,h);gl.clearColor(.70,.58,.80,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const distance=5.24+(first?(1-ease)*.54:0);
    lift=first ? .37+.34*(1-ease) : .37;
    gl.uniform3f(eye,Math.sin(angle)*distance,2.02+lift,Math.cos(angle)*distance);
    gl.uniform1f(aspect,w/h);gl.drawArrays(gl.TRIANGLES,0,total);
    canvas.hidden=false;button.hidden=false;
    if(t<1&&pending)schedule();
    else {pending=false;button.disabled=false;}
  }
  function turn(){
    if(!active||button.disabled)return;
    first=false;from=angle;to=angle+Math.PI*.61;start=0;pending=true;button.disabled=true;schedule();
  }
  try{
    const compile=(kind,src)=>{const s=gl.createShader(kind);shaders.push(s);gl.shaderSource(s,src);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('Studio shader unavailable');return s;};
    program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,VERT));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Studio unavailable');
    gl.useProgram(program);gl.enable(gl.DEPTH_TEST);geometry??=scene();total=geometry.length/9;
    buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,geometry,gl.STATIC_DRAW);
    for(const [attribute,offset] of [['aPos',0],['aNorm',12],['aColor',24]]){
      const id=gl.getAttribLocation(program,attribute);gl.enableVertexAttribArray(id);gl.vertexAttribPointer(id,3,gl.FLOAT,false,36,offset);}
    eye=gl.getUniformLocation(program,'eye');aspect=gl.getUniformLocation(program,'aspect');
    button.addEventListener('click',turn);document.addEventListener('visibilitychange',visibility);
    canvas.addEventListener('webglcontextlost',lost);reduced.addEventListener('change',preference);
    if(window.ResizeObserver){resizeObserver=new ResizeObserver(schedule);resizeObserver.observe(stage);}
    if(window.IntersectionObserver){observer=new IntersectionObserver(([entry])=>{onScreen=entry.isIntersecting;if(onScreen)schedule();else{cancelAnimationFrame(frame);frame=0;}});observer.observe(stage);}
    schedule();
  }catch{dispose();}
  return dispose;
}
