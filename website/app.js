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
      duration: '1.2s',
      content: '<span class="muted">graph</span>  1,842 nodes / 3,116 edges\n<span class="muted">scope</span>  auth, api, database\n<span class="good">ready</span>  dependency topology loaded'
    },
    plan: {
      command: 'cos plan "refresh-token rotation"',
      duration: '186ms',
      content: '<span class="muted">root</span>   src/auth/session.ts\n<span class="muted">blast</span>  7 files / 3 layers\n<span class="good">order</span>  schema → service → api → tests'
    },
    change: {
      command: 'cos ask "rotate refresh tokens safely"',
      duration: '4 steps',
      content: '<span class="muted">patch</span>  context validated\n<span class="muted">record</span> transaction persisted\n<span class="good">state</span>  mutation committed'
    },
    verify: {
      command: 'verification engine',
      duration: '8.4s',
      content: '<span class="muted">types</span>  pass\n<span class="muted">tests</span>  pass\n<span class="muted">build</span>  pass\n<span class="good">done</span>   completion independently allowed'
    }
  };

  const traceButtons = document.querySelectorAll('.trace-step');
  const traceCommand = document.getElementById('trace-command');
  const traceDuration = document.getElementById('trace-duration');
  const traceContent = document.getElementById('trace-content');

  function selectTrace(key) {
    const trace = traces[key];
    if (!trace || !traceCommand || !traceDuration || !traceContent) return;
    traceButtons.forEach(button => button.classList.toggle('active', button.dataset.trace === key));
    traceCommand.textContent = trace.command;
    traceDuration.textContent = trace.duration;
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
