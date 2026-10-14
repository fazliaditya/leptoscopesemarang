(() => {
  const menuBtn=document.getElementById('menuBtn');
  const nav=document.getElementById('mainNav');
  menuBtn?.addEventListener('click',()=>nav.classList.toggle('mobile-open'));
  if(typeof L==='undefined' || !document.getElementById('previewMap')) return;
  const map=L.map('previewMap',{zoomControl:false,scrollWheelZoom:false,dragging:true,attributionControl:true}).setView([-7.005,110.438],11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  const colors={'Rendah':'#5b9e75','Sedang':'#d3bd68','Tinggi':'#ca844c','Sangat Tinggi':'#b95552'};
  fetch('data/risk_kecamatan_2023.geojson').then(r=>r.json()).then(g=>{
    const layer=L.geoJSON(g,{style:f=>{const p=f.properties||{};const c=p.history_priority_class||p.risk_class||p.relative_score_class||'Rendah';return{color:'#ffffff',weight:1.2,fillColor:colors[c]||'#7aa88b',fillOpacity:.72}},onEachFeature:(f,l)=>l.bindTooltip(f.properties?.kecamatan_name||'Kecamatan',{direction:'top'})}).addTo(map);
    const b=layer.getBounds(); if(b.isValid()) map.fitBounds(b,{padding:[14,14]});
  }).catch(()=>{});
})();
