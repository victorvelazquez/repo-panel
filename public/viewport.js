'use strict';
// RP180: on a touch screen the layout is as tall as the VISIBLE part of the page. iOS does not shrink 100dvh when the keyboard opens, so Safari
// scrolled the whole page to show the chat box. Here --vvh follows visualViewport (style.css uses it with 100dvh as the fallback) and a page that
// the browser shifted is brought back to the top, but ONLY while a text field has the focus (that is the keyboard). RP182: it used to do it on every
// event, and the bounce at the end of a page fires them, so Settings, Work and Conformity (which scroll as a page) jumped back up. A pinch-zoomed
// page is left alone: its visible height is not the layout height.
const typing = (el) => !!el && (el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

function fitViewport(win) {
  const vv = win && win.visualViewport;
  if (!vv || typeof win.matchMedia !== 'function' || !win.matchMedia('(pointer: coarse)').matches) return false;
  const root = win.document.documentElement;
  const sync = () => {
    if (vv.scale > 1.01) return;
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    if (win.scrollY && typing(win.document.activeElement)) win.scrollTo(0, 0);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return true;
}

if (typeof window !== 'undefined') fitViewport(window);
if (typeof module !== 'undefined' && module.exports) module.exports = { fitViewport };
