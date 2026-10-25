// The ready side of the preview readiness demo. Once the DOM of the page is
// ready, it posts example:ready to the parent page, and from then on it answers
// a matching request from the parent page with the same string. The page posts
// nothing else.
;(function () {
  'use strict'

  const message = 'example:ready'
  let ready = false

  window.addEventListener('message', event => {
    if (ready && event.source === window.parent && event.data === message) {
      event.source.postMessage(message, event.origin === 'null' ? '*' : event.origin)
    }
  })

  function announce () {
    ready = true
    if (window.parent !== window) window.parent.postMessage(message, '*')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce)
  else announce()
}())
