// The ready side of the preview readiness demo. The page loads it with defer,
// so it runs once the document is parsed: it posts example:ready to the parent
// page, and answers each matching request from the parent page with the same
// string. The page posts nothing else.
;(function () {
  'use strict'

  const message = 'example:ready'

  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data === message) {
      event.source.postMessage(message, event.origin === 'null' ? '*' : event.origin)
    }
  })

  if (window.parent !== window) window.parent.postMessage(message, '*')
}())
