// Public local example: readiness and an opt-in, correlated theme exchange.
;(function () {
  'use strict'
  const root=document.documentElement,token='example:theme',prefix='hinode-preview-theme:'
  const framed=window.parent!==window,marked=!!document.querySelector('meta[name="preview-demo-ready"]')
  let managed=null
  const origin=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&u.origin===value?value:null}catch{return null}}
  const apply=theme=>{root.dataset.bsTheme=theme;root.dataset.theme=theme}
  apply(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')
  if(framed&&marked&&window.name.startsWith(prefix)&&window.name.length<=512){
    try{const seed=JSON.parse(window.name.slice(prefix.length));if(seed.type===token&&['light','dark'].includes(seed.theme)&&Number.isSafeInteger(seed.requestId)&&seed.requestId>=0&&origin(seed.parentOrigin)){
      apply(seed.theme);managed={...seed};if(seed.requestId>0)parent.postMessage({type:token,theme:seed.theme,requestId:seed.requestId,applied:false},seed.parentOrigin)
    }}catch{}
  }
  const ready=()=>{if(framed&&marked&&document.body?.hasAttribute('data-preview-demo-ready'))parent.postMessage('example:ready','*')}
  if(framed&&marked){
    addEventListener('message',event=>{
      if(event.source!==parent||!origin(event.origin))return
      if(event.data==='example:ready'){if(document.readyState!=='loading')ready();return}
      const data=event.data
      if(!data||typeof data!=='object'||Array.isArray(data)||data.type!==token||Object.prototype.hasOwnProperty.call(data,'applied')||!['light','dark'].includes(data.theme)||!Number.isSafeInteger(data.requestId)||data.requestId<=0)return
      apply(data.theme);managed={type:token,theme:data.theme,requestId:data.requestId,parentOrigin:event.origin};window.name=prefix+JSON.stringify(managed)
      parent.postMessage({...data,applied:true},event.origin)
    })
    addEventListener('pagehide',()=>{if(managed?.requestId>0)parent.postMessage({type:token,theme:managed.theme,requestId:managed.requestId,applied:false},managed.parentOrigin)})
  }
  addEventListener('DOMContentLoaded',()=>{
    if(managed)apply(managed.theme)
    let added=0
    document.querySelector('[data-add-task]')?.addEventListener('click',()=>{const target=document.querySelector('[data-tasks]');const card=document.createElement('article');card.className='card task';card.innerHTML='<span class="tag">New</span><h3>New task '+(++added)+'</h3><p>Added in the live example.</p>';target.prepend(card)})
    ready()
  })
}())
