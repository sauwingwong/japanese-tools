// Shared renderer for 4-option multiple-choice cards.
// Mirrors listening-quiz.html's #options-grid / .opt styling.
//
// Usage:
//   renderOptions(gridEl, [
//     { label: 'A', sub: 'foo', correct: true,  value: a },
//     { label: 'B', sub: 'bar', correct: false, value: b },
//     ...
//   ], (picked) => { ... });
//
// CSS expected: each page defines `.opt` / `.opt.correct` / `.opt.wrong` /
// `.opt-meaning` / `#options-grid` or equivalent passed-in classnames.

export function renderOptions(grid, options, onPick, {
  optClass = 'opt',
  subClass = 'opt-meaning',
  shuffle = true,
} = {}) {
  const items = shuffle ? [...options].sort(() => Math.random() - 0.5) : options;
  grid.innerHTML = '';
  let answered = false;

  items.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = optClass;
    const main = document.createElement('span');
    main.textContent = opt.label;
    btn.appendChild(main);
    if (opt.sub) {
      const sub = document.createElement('span');
      sub.className = subClass;
      sub.textContent = opt.sub;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      btn.classList.add(opt.correct ? 'correct' : 'wrong');
      // Reveal correct when user picked wrong
      if (!opt.correct) {
        Array.from(grid.querySelectorAll('.' + optClass)).forEach(b => {
          const idx = Array.from(grid.children).indexOf(b);
          if (items[idx] && items[idx].correct) b.classList.add('correct');
        });
      }
      Array.from(grid.querySelectorAll('.' + optClass)).forEach(b => b.disabled = true);
      onPick(opt, btn);
    });
    grid.appendChild(btn);
  });
}

// Utility: pick n distinct random distractors from `pool`, excluding `exclude`.
export function pickDistractors(pool, exclude, n) {
  const filtered = pool.filter(x => x !== exclude);
  const shuffled = filtered.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
