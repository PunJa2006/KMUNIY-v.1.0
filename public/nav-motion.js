(() => {
  const nav = document.getElementById('main-nav');
  if (!nav || !window.requestAnimationFrame || !window.ResizeObserver) return;
  const buttons = [...nav.querySelectorAll('button')];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bead = document.createElement('span');
  bead.className = 'nav-bead';
  bead.setAttribute('aria-hidden', 'true');
  const primary = nav.querySelector('.nav-primary');
  primary.append(bead);
  nav.classList.add('nav-motion');
  const edges = [0, 0, 0, 0], velocity = [0, 0, 0, 0];
  let target = [...edges], selected, ready = false, frame = 0, previous = 0;
  const pageButton = () => buttons.find(button => button.getAttribute('aria-current') === 'page') || buttons[0];
  const activeButton = () => document.getElementById('post-dialog')?.open ? document.getElementById('open-post') : pageButton();
  const paint = () => {
    bead.style.transform = 'translate3d(' + edges[0] + 'px,' + edges[2] + 'px,0)';
    bead.style.width = Math.max(1, edges[1] - edges[0]) + 'px';
    bead.style.height = Math.max(1, edges[3] - edges[2]) + 'px';
  };
  const measure = button => {
    const bounds = button.getBoundingClientRect(), container = primary.getBoundingClientRect();
    return [bounds.left - container.left - primary.clientLeft, bounds.right - container.left - primary.clientLeft, bounds.top - container.top - primary.clientTop, bounds.bottom - container.top - primary.clientTop];
  };
  const tick = time => {
    if (selected) target = measure(selected);
    const dt = Math.min((time - previous) / 1000 || 1 / 60, 0.032);
    previous = time;
    let moving = false;
    const horizontal = nav.getBoundingClientRect().width > nav.getBoundingClientRect().height;
    const start = horizontal ? 0 : 2, end = start + 1;
    const direction = target[start] + target[end] >= edges[start] + edges[end] ? 1 : -1;
    const lead = direction > 0 ? end : start;
    for (let index = 0; index < 4; index++) {
      const stiffness = index === lead ? 270 : 175;
      const damping = index === lead ? 24 : 23;
      velocity[index] += ((target[index] - edges[index]) * stiffness - velocity[index] * damping) * dt;
      edges[index] += velocity[index] * dt;
      if (Math.abs(target[index] - edges[index]) > 0.08 || Math.abs(velocity[index]) > 0.08) moving = true;
    }
    paint();
    if (moving) frame = requestAnimationFrame(tick);
    else { frame = 0; edges.splice(0, 4, ...target); velocity.fill(0); paint(); }
  };
  const move = (button, immediate = false) => {
    if (!button) return;
    const bounds = button.getBoundingClientRect(), container = primary.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    selected = button;
    for (const item of buttons) item.dataset.motionActive = String(item === button);
    target = measure(button);
    if (!ready || immediate || reduced.matches) {
      cancelAnimationFrame(frame); frame = 0; velocity.fill(0); edges.splice(0, 4, ...target); paint(); ready = true;
    } else if (!frame) { previous = performance.now(); frame = requestAnimationFrame(tick); }
    bead.classList.add('is-ready');
  };
  new ResizeObserver(() => move(selected || activeButton())).observe(nav);
  new MutationObserver(() => move(activeButton())).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
  for (const id of ['post-dialog']) {
    const dialog = document.getElementById(id);
    if (dialog) new MutationObserver(() => move(activeButton())).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }
  reduced.addEventListener('change', () => move(activeButton(), true));
  document.fonts?.ready.then(() => move(activeButton(), true));
  move(activeButton(), true);
})();
