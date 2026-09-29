import {MOBILE_VIEWPORT_QUERY} from './mobileViewport.js';

// Select menus teleport outside their dialog. Bound their own scroller and
// update Popper after keyboard resize/pan, without changing desktop placement.
export function mobileSelectOptions(win = globalThis.window) {
  const mobile = () => Boolean(win?.matchMedia?.(MOBILE_VIEWPORT_QUERY).matches);
  return {
    strategy: mobile() ? 'fixed' : 'absolute',
    modifiers: [
      {name: 'preventOverflow', options: mobile() ? {altAxis: true, tether: false, padding: 12} : {}},
      {
        name: 'mobileSelectViewport', enabled: true, phase: 'write', fn() {},
        effect({state, instance}) {
          if (!win) return;
          const panel = state.elements.popper, viewport = win.visualViewport;
          let frame = null, disposed = false;
          const previous = panel.style.getPropertyValue('--mobile-select-height');
          const priority = panel.style.getPropertyPriority('--mobile-select-height');
          const hadClass = panel.classList.contains('mobile-select-popper');
          panel.classList.add('mobile-select-popper');
          function size() {
            // Pinch zoom remains native, like the application viewport owner.
            if (!mobile() || (viewport && Math.abs(Number(viewport.scale || 1) - 1) > .01)) return;
            const height = Number(viewport?.height || win.innerHeight);
            if (Number.isFinite(height) && height > 0) panel.style.setProperty('--mobile-select-height', `${height}px`);
          }
          function schedule() {
            if (disposed || frame !== null) return;
            frame = win.requestAnimationFrame(() => {
              frame = null;
              if (disposed) return;
              size();
              const strategy = mobile() ? 'fixed' : 'absolute';
              if (state.options.strategy !== strategy) {
                // setOptions replaces this effect; its cleanup owns listeners.
                instance.setOptions(options => ({...options, ...mobileSelectOptions(win)}));
              } else instance.update();
            });
          }
          size();
          for (const target of [win, viewport]) {
            target?.addEventListener('resize', schedule);
            target?.addEventListener('scroll', schedule);
          }
          return () => {
            disposed = true;
            if (frame !== null) win.cancelAnimationFrame(frame);
            for (const target of [win, viewport]) {
              target?.removeEventListener('resize', schedule);
              target?.removeEventListener('scroll', schedule);
            }
            if (!hadClass) panel.classList.remove('mobile-select-popper');
            if (previous) panel.style.setProperty('--mobile-select-height', previous, priority);
            else panel.style.removeProperty('--mobile-select-height');
          };
        },
      },
    ],
  };
}
