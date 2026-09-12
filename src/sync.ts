import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getGitPath } from './git';
import { Store } from './store';

/** État d'un clone connu, tel qu'affiché dans le panneau. */
export interface RepoStatus {
  path: string;
  name: string;
  /** Commits présents en amont et pas en local. */
  behind: number;
  /** Commits locaux pas encore poussés — bloque le fast-forward. */
  ahead: number;
  /** Modifications non commitées (fichiers suivis uniquement). */
  dirty: boolean;
  branch?: string;
  state: 'unknown' | 'checking' | 'clean' | 'behind' | 'blocked' | 'missing' | 'error';
  message?: string;
  checkedAt?: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 45000;
const MAX_PARALLEL = 3;

/** Lance git dans un dépôt, sans jamais ouvrir de prompt bloquant. */
function runGit(gitPath: string, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(gitPath, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));

    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    const done = (code: number, extra = '') => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: (stderr + extra).trim() });
    };

    child.on('error', (err) => done(-1, `Impossible de lancer git : ${err.message}`));
    child.on('close', (code) => done(code ?? -1));
  });
}

/** Dernière ligne utile de git, pour un message d'erreur lisible. */
function tail(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1] ?? '';
}

/**
 * Interroge un dépôt : fetch (optionnel) puis comparaison avec l'upstream.
 * Ne lève jamais — un échec devient un état affichable.
 */
async function inspect(
  gitPath: string,
  repo: { name: string; path: string },
  fetch: boolean
): Promise<RepoStatus> {
  const base: RepoStatus = {
    path: repo.path,
    name: repo.name,
    behind: 0,
    ahead: 0,
    dirty: false,
    state: 'unknown',
    checkedAt: Date.now()
  };

  if (!fs.existsSync(repo.path)) {
    return { ...base, state: 'missing', message: 'Dossier introuvable.' };
  }
  const inside = await runGit(gitPath, repo.path, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout !== 'true') {
    return { ...base, state: 'missing', message: 'Ce dossier n’est plus un dépôt Git.' };
  }

  const branchRes = await runGit(gitPath, repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.stdout : undefined;
  if (branch === 'HEAD') {
    return { ...base, state: 'blocked', message: 'HEAD détaché.' };
  }

  const upstream = await runGit(gitPath, repo.path, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}'
  ]);
  if (upstream.code !== 0) {
    return { ...base, branch, state: 'blocked', message: 'Aucune branche de suivi.' };
  }

  if (fetch) {
    const fetched = await runGit(gitPath, repo.path, ['fetch', '--prune', '--quiet']);
    if (fetched.code !== 0) {
      return {
        ...base,
        branch,
        state: 'error',
        message: tail(fetched.stderr) || 'Échec du fetch.'
      };
    }
  }

  const counts = await runGit(gitPath, repo.path, [
    'rev-list',
    '--count',
    '--left-right',
    'HEAD...@{u}'
  ]);
  if (counts.code !== 0) {
    return {
      ...base,
      branch,
      state: 'error',
      message: tail(counts.stderr) || 'Comparaison impossible.'
    };
  }
  const [aheadStr, behindStr] = counts.stdout.split(/\s+/);
  const ahead = Number(aheadStr) || 0;
  const behind = Number(behindStr) || 0;

  // Les fichiers non suivis n'empêchent pas un fast-forward : on les ignore.
  const status = await runGit(gitPath, repo.path, [
    'status',
    '--porcelain',
    '--untracked-files=no'
  ]);
  const dirty = status.code === 0 && status.stdout.length > 0;

  if (behind === 0) {
    return { ...base, branch, ahead, behind, dirty, state: 'clean' };
  }
  if (ahead > 0) {
    return {
      ...base,
      branch,
      ahead,
      behind,
      dirty,
      state: 'blocked',
      message: `${behind} commit(s) en amont, mais ${ahead} commit(s) local(aux) non poussé(s).`
    };
  }
  if (dirty) {
    return {
      ...base,
      branch,
      ahead,
      behind,
      dirty,
      state: 'blocked',
      message: `${behind} commit(s) en amont, mais des modifications non commitées.`
    };
  }
  return { ...base, branch, ahead, behind, dirty, state: 'behind' };
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

/**
 * Suit l'état des clones connus et applique les mises à jour, uniquement
 * en fast-forward et uniquement sur demande explicite de l'utilisateur.
 */
export class SyncManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private readonly statuses = new Map<string, RepoStatus>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastCheck = 0;

  constructor(private readonly store: Store) {
    store.onDidChange(() => this.prune());
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.emitter.dispose();
  }

  /** Statut connu d'un clone (clé insensible à la casse). */
  status(target: string): RepoStatus | undefined {
    return this.statuses.get(key(target));
  }

  all(): RepoStatus[] {
    return this.store
      .clones()
      .map((c) => this.statuses.get(key(c.path)))
      .filter((s): s is RepoStatus => !!s);
  }

  updatable(): RepoStatus[] {
    return this.all().filter((s) => s.state === 'behind');
  }

  get busy(): boolean {
    return this.running;
  }

  /** Démarre la surveillance : au lancement, au retour de focus, puis par intervalle. */
  start(context: vscode.ExtensionContext): void {
    const enabled = () =>
      vscode.workspace.getConfiguration('ezClone').get<boolean>('autoCheckUpdates', true);

    if (enabled()) {
      void this.checkAll();
    }

    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && enabled() && Date.now() - this.lastCheck > this.intervalMs()) {
          void this.checkAll();
        }
      })
    );

    this.timer = setInterval(() => {
      if (enabled() && Date.now() - this.lastCheck > this.intervalMs()) {
        void this.checkAll();
      }
    }, 5 * 60000);
  }

  private intervalMs(): number {
    const minutes = vscode.workspace
      .getConfiguration('ezClone')
      .get<number>('updateCheckInterval', 30);
    return Math.max(1, minutes) * 60000;
  }

  /** Interroge tous les clones connus, quelques-uns à la fois. */
  async checkAll(options: { silent?: boolean } = {}): Promise<RepoStatus[]> {
    if (this.running) {
      return this.all();
    }
    const clones = this.store.clones();
    if (clones.length === 0) {
      return [];
    }

    this.running = true;
    this.lastCheck = Date.now();

    for (const clone of clones) {
      const previous = this.statuses.get(key(clone.path));
      this.statuses.set(key(clone.path), {
        path: clone.path,
        name: clone.name,
        behind: previous?.behind ?? 0,
        ahead: previous?.ahead ?? 0,
        dirty: previous?.dirty ?? false,
        branch: previous?.branch,
        state: 'checking'
      });
    }
    this.emitter.fire();

    try {
      const gitPath = await getGitPath();
      const queue = [...clones];
      const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) {
            return;
          }
          this.statuses.set(key(next.path), await inspect(gitPath, next, true));
          this.emitter.fire();
        }
      });
      await Promise.all(workers);
    } finally {
      this.running = false;
      this.emitter.fire();
    }

    if (!options.silent) {
      this.announce();
    }
    return this.all();
  }

  /** Réinterroge un seul dépôt (après une mise à jour, par exemple). */
  async refreshOne(target: string, fetch = true): Promise<RepoStatus | undefined> {
    const clone = this.store.clones().find((c) => key(c.path) === key(target));
    if (!clone) {
      return undefined;
    }
    const gitPath = await getGitPath();
    const status = await inspect(gitPath, clone, fetch);
    this.statuses.set(key(target), status);
    this.emitter.fire();
    return status;
  }

  /**
   * Met à jour un dépôt en fast-forward, après confirmation de l'utilisateur.
   * `confirm: false` saute la boîte de dialogue (l'appelant a déjà confirmé).
   */
  async update(target: string, confirm = true): Promise<UpdateResult> {
    const status = this.status(target) ?? (await this.refreshOne(target));
    if (!status) {
      return { ok: false, message: 'Dépôt inconnu.' };
    }
    if (status.state === 'missing' || status.state === 'blocked' || status.state === 'error') {
      return { ok: false, message: status.message ?? 'Mise à jour impossible.' };
    }
    if (status.state !== 'behind') {
      return { ok: true, message: `${status.name} est déjà à jour.` };
    }

    if (confirm) {
      const yes = 'Mettre à jour';
      const answer = await vscode.window.showInformationMessage(
        `Mettre à jour ${status.name} ?`,
        {
          modal: true,
          detail:
            `${status.behind} nouveau(x) commit(s) sur ${status.branch ?? 'la branche courante'}.\n` +
            'Le dépôt sera avancé en fast-forward, sans fusion ni rebase.'
        },
        yes
      );
      if (answer !== yes) {
        return { ok: false, message: 'Mise à jour annulée.' };
      }
    }

    const gitPath = await getGitPath();
    const merged = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Mise à jour de ${status.name}…` },
      () => runGit(gitPath, status.path, ['merge', '--ff-only', '@{u}'])
    );

    // Le fetch vient d'avoir lieu : on se contente de recalculer l'écart.
    await this.refreshOne(target, false);

    if (merged.code !== 0) {
      return { ok: false, message: tail(merged.stderr) || 'Le fast-forward a échoué.' };
    }
    return { ok: true, message: `${status.name} mis à jour (${status.behind} commit(s)).` };
  }

  /** Notification discrète quand des mises à jour sont disponibles. */
  private announce(): void {
    const pending = this.updatable();
    if (pending.length === 0) {
      return;
    }
    const review = 'Voir';
    const label =
      pending.length === 1
        ? `${pending[0].name} : ${pending[0].behind} nouveau(x) commit(s) disponible(s).`
        : `${pending.length} dépôts ont des mises à jour disponibles.`;

    void vscode.window.showInformationMessage(label, review).then((answer) => {
      if (answer === review) {
        void vscode.commands.executeCommand('ezClone.form.focus');
      }
    });
  }

  /** Oublie les statuts des clones retirés de l'historique. */
  private prune(): void {
    const known = new Set(this.store.clones().map((c) => key(c.path)));
    for (const k of [...this.statuses.keys()]) {
      if (!known.has(k)) {
        this.statuses.delete(k);
      }
    }
  }
}

function key(target: string): string {
  return target.toLowerCase();
}
