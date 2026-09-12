// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    url: /** @type {HTMLInputElement} */ (document.getElementById('url')),
    dest: /** @type {HTMLSelectElement} */ (document.getElementById('dest')),
    open: /** @type {HTMLSelectElement} */ (document.getElementById('open')),
    paste: /** @type {HTMLButtonElement} */ (document.getElementById('paste')),
    browse: /** @type {HTMLButtonElement} */ (document.getElementById('browse')),
    submit: /** @type {HTMLButtonElement} */ (document.getElementById('submit')),
    bar: /** @type {HTMLElement} */ (document.getElementById('bar')),
    fill: /** @type {HTMLElement} */ (document.getElementById('fill')),
    status: /** @type {HTMLElement} */ (document.getElementById('status')),
    signedOut: /** @type {HTMLElement} */ (document.getElementById('ghSignedOut')),
    signIn: /** @type {HTMLButtonElement} */ (document.getElementById('signIn')),
    ghPane: /** @type {HTMLElement} */ (document.getElementById('ghPane')),
    ghCount: /** @type {HTMLElement} */ (document.getElementById('ghCount')),
    ghRefresh: /** @type {HTMLButtonElement} */ (document.getElementById('ghRefresh')),
    ghNote: /** @type {HTMLElement} */ (document.getElementById('ghNote')),
    repos: /** @type {HTMLElement} */ (document.getElementById('repos')),
    recentsBox: /** @type {HTMLDetailsElement} */ (document.getElementById('recentsBox')),
    recents: /** @type {HTMLElement} */ (document.getElementById('recents')),
    recentsInfo: /** @type {HTMLElement} */ (document.getElementById('recentsInfo')),
    checkUpdates: /** @type {HTMLButtonElement} */ (document.getElementById('checkUpdates'))
  };

  /** @type {{name:string,owner:string,description:string,url:string,private:boolean,fork:boolean}[]} */
  let repos = [];
  let ghState = { signedIn: false, loading: false, error: undefined };

  /** Le champ ne filtre la liste que pendant la frappe, pas après une sélection. */
  let filtering = false;
  let selectedUrl = '';

  function saveState() {
    vscode.setState({
      url: el.url.value,
      dest: el.dest.value,
      open: el.open.value
    });
  }

  function restoreState() {
    const s = vscode.getState();
    if (!s) {
      return;
    }
    el.url.value = s.url || '';
    el.open.value = s.open || 'newWindow';
  }

  function setStatus(kind, text) {
    el.status.hidden = !text;
    el.status.className = 'status ' + kind;
    el.status.textContent = text || '';
  }

  // ---------------------------------------------------------------- dépôts

  function renderRepos() {
    el.signedOut.hidden = ghState.signedIn;
    el.ghPane.hidden = !ghState.signedIn;
    if (!ghState.signedIn) {
      return;
    }

    const query = filtering ? el.url.value.trim().toLowerCase() : '';
    const shown = query
      ? repos.filter(
          (r) =>
            r.name.toLowerCase().indexOf(query) !== -1 ||
            r.owner.toLowerCase().indexOf(query) !== -1 ||
            (r.description || '').toLowerCase().indexOf(query) !== -1
        )
      : repos;

    el.repos.textContent = '';
    for (const repo of shown) {
      el.repos.appendChild(repoRow(repo));
    }

    el.ghCount.textContent = ghState.loading
      ? 'Chargement…'
      : repos.length === 0
        ? ''
        : query
          ? shown.length + ' / ' + repos.length + ' dépôts'
          : repos.length + ' dépôts';

    const note = ghState.error
      ? ghState.error
      : !ghState.loading && repos.length && shown.length === 0
        ? 'Aucun dépôt ne correspond. Entrée pour cloner l’URL saisie.'
        : '';
    el.ghNote.hidden = !note;
    el.ghNote.textContent = note;
    el.ghNote.classList.toggle('error', !!ghState.error);
    el.repos.hidden = shown.length === 0;
  }

  function repoRow(repo) {
    const row = document.createElement('div');
    row.className = 'repo' + (repo.url === selectedUrl ? ' selected' : '');
    row.setAttribute('role', 'option');
    row.title = repo.description || repo.owner + '/' + repo.name;

    const main = document.createElement('div');
    main.className = 'repo-main';

    const name = document.createElement('span');
    name.className = 'repo-name';
    name.textContent = repo.name;
    main.appendChild(name);

    if (repo.private) {
      main.appendChild(badge('privé'));
    }
    if (repo.fork) {
      main.appendChild(badge('fork'));
    }

    const owner = document.createElement('div');
    owner.className = 'repo-owner';
    owner.textContent = repo.owner;

    row.appendChild(main);
    row.appendChild(owner);

    row.addEventListener('click', () => selectRepo(repo));
    row.addEventListener('dblclick', () => {
      selectRepo(repo);
      el.submit.click();
    });
    return row;
  }

  function badge(text) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = text;
    return b;
  }

  function selectRepo(repo) {
    selectedUrl = repo.url;
    filtering = false;
    el.url.value = repo.url;
    setStatus('info', '');
    saveState();
    renderRepos();
  }

  // -------------------------------------------------------------- récents

  function renderRecents(items, busy) {
    el.recentsBox.hidden = items.length === 0;
    el.checkUpdates.disabled = busy;
    el.checkUpdates.textContent = busy ? 'Vérification…' : 'Vérifier les mises à jour';

    const pending = items.filter((i) => i.state === 'behind');
    el.recentsInfo.textContent = busy
      ? ''
      : pending.length === 0
        ? ''
        : pending.length + ' mise(s) à jour disponible(s)';
    el.recentsInfo.classList.toggle('accent', pending.length > 0);

    // Une mise à jour disponible mérite d'être vue sans déplier la section.
    if (pending.length > 0) {
      el.recentsBox.open = true;
    }

    el.recents.textContent = '';
    for (const item of items) {
      el.recents.appendChild(recentRow(item));
    }
  }

  function recentRow(item) {
    const row = document.createElement('div');
    row.className = 'recent';
    row.title = item.message ? item.path + ' — ' + item.message : item.path;

    const label = document.createElement('button');
    label.className = 'recent-open';
    label.textContent = item.name;
    label.title = 'Ouvrir dans une nouvelle fenêtre — ' + item.path;
    // Ctrl/Cmd + clic pour réutiliser la fenêtre courante, comme ailleurs dans VS Code.
    label.addEventListener('click', (e) =>
      vscode.postMessage({
        type: 'openRecent',
        path: item.path,
        behavior: e.ctrlKey || e.metaKey ? 'currentWindow' : 'newWindow'
      })
    );
    row.appendChild(label);

    const mark = stateMark(item);
    if (mark) {
      row.appendChild(mark);
    }

    if (item.state === 'behind') {
      const update = document.createElement('button');
      update.className = 'recent-update';
      update.textContent = '↓ ' + item.behind;
      update.title = 'Mettre à jour (' + item.behind + ' commit(s) sur ' + (item.branch || 'la branche courante') + ')';
      update.addEventListener('click', () =>
        vscode.postMessage({ type: 'updateRecent', path: item.path })
      );
      row.appendChild(update);
    }

    const here = document.createElement('button');
    here.className = 'recent-here';
    here.textContent = '⇱';
    here.title = 'Ouvrir dans la fenêtre courante';
    here.addEventListener('click', () =>
      vscode.postMessage({ type: 'openRecent', path: item.path, behavior: 'currentWindow' })
    );
    row.appendChild(here);

    const remove = document.createElement('button');
    remove.className = 'recent-remove';
    remove.textContent = '✕';
    remove.title = 'Retirer de la liste';
    remove.addEventListener('click', () =>
      vscode.postMessage({ type: 'removeRecent', path: item.path })
    );
    row.appendChild(remove);
    return row;
  }

  /** Pastille d'état : muette quand tout va bien, explicite sinon. */
  function stateMark(item) {
    if (item.state === 'behind' || item.state === 'clean' || item.state === 'unknown') {
      return null;
    }
    const mark = document.createElement('span');
    mark.className = 'recent-state ' + item.state;
    mark.textContent =
      item.state === 'checking'
        ? '…'
        : item.state === 'missing'
          ? 'introuvable'
          : item.state === 'error'
            ? 'erreur'
            : 'bloqué';
    if (item.message) {
      mark.title = item.message;
    }
    return mark;
  }

  // ------------------------------------------------------------ emplacements

  function setDestinations(dirs) {
    const previous = el.dest.value;
    el.dest.textContent = '';
    for (const dir of dirs) {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = dir;
      el.dest.appendChild(opt);
    }
    if (dirs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Choisis un dossier…';
      el.dest.appendChild(opt);
    }
    const saved = (vscode.getState() || {}).dest;
    const wanted = previous || saved;
    if (wanted && dirs.indexOf(wanted) !== -1) {
      el.dest.value = wanted;
    }
  }

  function ensureDestOption(dir) {
    if (!Array.prototype.some.call(el.dest.options, (o) => o.value === dir)) {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = dir;
      el.dest.insertBefore(opt, el.dest.firstChild);
    }
    el.dest.value = dir;
  }

  // -------------------------------------------------------------- événements

  el.url.addEventListener('input', () => {
    filtering = true;
    selectedUrl = '';
    renderRepos();
    saveState();
  });

  [el.dest, el.open].forEach((n) => n.addEventListener('change', saveState));

  el.paste.addEventListener('click', () => vscode.postMessage({ type: 'paste' }));
  el.browse.addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
  el.signIn.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
  el.ghRefresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshRepos' }));
  el.checkUpdates.addEventListener('click', () => vscode.postMessage({ type: 'checkUpdates' }));

  el.submit.addEventListener('click', () => {
    setStatus('info', '');
    vscode.postMessage({
      type: 'clone',
      url: el.url.value,
      dest: el.dest.value,
      openBehavior: el.open.value
    });
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.submit.click();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'setRepos':
        repos = msg.repos || [];
        ghState = { signedIn: msg.signedIn, loading: msg.loading, error: msg.error };
        renderRepos();
        break;

      case 'setRecents':
        renderRecents(msg.items || [], !!msg.busy);
        break;

      case 'setDestinations':
        setDestinations(msg.destinations);
        saveState();
        break;

      case 'setDest':
        ensureDestOption(msg.dest);
        saveState();
        break;

      case 'setUrl':
        // Sans `force`, on ne réécrit pas ce que l'utilisateur a déjà tapé.
        if (msg.force || !el.url.value.trim()) {
          filtering = false;
          selectedUrl = msg.url;
          el.url.value = msg.url;
          setStatus('info', '');
          renderRepos();
          saveState();
        }
        break;

      case 'focusUrl':
        el.url.focus();
        el.url.select();
        break;

      case 'busy':
        el.submit.disabled = msg.busy;
        el.submit.textContent = msg.busy ? 'Clonage…' : 'Cloner';
        el.bar.hidden = !msg.busy;
        if (!msg.busy) {
          el.fill.style.width = '0';
        }
        break;

      case 'progress':
        if (msg.percent >= 0) {
          el.fill.style.width = msg.percent + '%';
        }
        setStatus('info', msg.text);
        break;

      case 'status':
        setStatus(msg.kind, msg.text);
        break;

      case 'reset':
        el.url.value = '';
        selectedUrl = '';
        filtering = false;
        renderRepos();
        saveState();
        break;
    }
  });

  restoreState();
  vscode.postMessage({ type: 'ready' });
})();
