(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const revealNodes = document.querySelectorAll('.reveal');
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    revealNodes.forEach(node => node.classList.add('visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' });
    revealNodes.forEach(node => observer.observe(node));
  }

  const traces = {
    scan: {
      command: 'cos scan',
      state: 'graph ready',
      content: '<span class="muted">graph</span>  repository structure indexed\n<span class="muted">scope</span>  dependency relationships mapped\n<span class="good">ready</span>  planning context available'
    },
    plan: {
      command: 'cos plan "target change"',
      state: 'ordered',
      content: '<span class="muted">root</span>   requested change located\n<span class="muted">blast</span>  dependent files identified\n<span class="good">order</span>  dependency-first plan produced'
    },
    change: {
      command: 'cos ask "implement the change"',
      state: 'recorded',
      content: '<span class="muted">patch</span>  file context validated\n<span class="muted">record</span> durable history written\n<span class="good">state</span>  tracked mutation available for verify'
    },
    verify: {
      command: 'verification engine',
      state: 'evidence gate',
      content: '<span class="muted">discover</span> repository gates selected\n<span class="muted">execute</span> checks run outside model self-report\n<span class="good">finish</span>  completion depends on gate result'
    }
  };

  const traceButtons = document.querySelectorAll('.trace-step');
  const traceCommand = document.getElementById('trace-command');
  const traceState = document.getElementById('trace-duration');
  const traceContent = document.getElementById('trace-content');

  function selectTrace(key) {
    const trace = traces[key];
    if (!trace || !traceCommand || !traceState || !traceContent) return;
    traceButtons.forEach(button => button.classList.toggle('active', button.dataset.trace === key));
    traceCommand.textContent = trace.command;
    traceState.textContent = trace.state;
    traceContent.innerHTML = `<code>${trace.content}</code>`;
  }

  traceButtons.forEach(button => {
    button.addEventListener('click', () => selectTrace(button.dataset.trace));
  });

  if (!prefersReducedMotion && traceButtons.length > 1) {
    let index = 0;
    const interval = window.setInterval(() => {
      if (document.hidden || document.activeElement?.classList.contains('trace-step')) return;
      index = (index + 1) % traceButtons.length;
      selectTrace(traceButtons[index].dataset.trace);
    }, 4200);
    window.addEventListener('pagehide', () => clearInterval(interval), { once: true });
  }

  const menuButton = document.querySelector('.menu-button');
  const mobileNav = document.getElementById('mobile-nav');
  if (menuButton && mobileNav) {
    const closeMenu = () => {
      mobileNav.hidden = true;
      menuButton.setAttribute('aria-expanded', 'false');
    };
    menuButton.addEventListener('click', () => {
      const nextOpen = mobileNav.hidden;
      mobileNav.hidden = !nextOpen;
      menuButton.setAttribute('aria-expanded', String(nextOpen));
    });
    mobileNav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
    window.addEventListener('resize', () => {
      if (window.innerWidth > 980) closeMenu();
    }, { passive: true });
  }

  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = 'copied';
        setTimeout(() => { button.textContent = previous; }, 1400);
      } catch {
        button.textContent = 'select';
      }
    });
  });
})();
