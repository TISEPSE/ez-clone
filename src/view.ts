import * as vscode from 'vscode';
import { performClone, suggestedDestinations, OpenBehavior } from './cloneService';
import { looksLikeRepoUrl } from './git';
import { GitHubRepos, Repo } from './github';
import { Store } from './store';
import { SyncManager } from './sync';

interface CloneMessage {
  type: 'clone';
  url: string;
  dest: string;
  openBehavior: OpenBehavior;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'browse' }
  | { type: 'paste' }
  | { type: 'signIn' }
  | { type: 'refreshRepos' }
  | { type: 'openRecent'; path: string; behavior: OpenBehavior }
  | { type: 'removeRecent'; path: string }
  | { type: 'checkUpdates' }
  | { type: 'updateRecent'; path: string }
  | CloneMessage;

/** Panneau unique : dépôts GitHub, formulaire de clone et historique. */
export class CloneFormProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'quickClone.form';

  private view?: vscode.WebviewView;
  private busy = false;
  private reposError: string | undefined;
  private reposLoading = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly github: GitHubRepos,
    private readonly sync: SyncManager
  ) {
    store.onDidChange(() => {
      this.sendDestinations();
      this.sendRecents();
    });
    github.onDidChange(() => this.sendRepos());
    sync.onDidChange(() => this.sendRecents());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: Inbound) => this.onMessage(msg));
  }

  async focusUrl(): Promise<void> {
    await vscode.commands.executeCommand(`${CloneFormProvider.viewId}.focus`);
    await this.prefillFromClipboard();
    this.post({ type: 'focusUrl' });
  }

  /** Remplit le formulaire depuis l'extérieur (lien vscode://). */
  async fill(url: string): Promise<void> {
    await vscode.commands.executeCommand(`${CloneFormProvider.viewId}.focus`);
    this.post({ type: 'setUrl', url, force: true });
  }

  private async onMessage(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendDestinations();
        this.sendRecents();
        this.sendRepos();
        await this.prefillFromClipboard();
        if (this.github.isSignedIn && !this.github.cached()) {
          await this.loadRepos();
        }
        return;

      case 'paste':
        await this.prefillFromClipboard(true);
        return;

      case 'signIn':
        if (await this.github.signIn()) {
          await this.loadRepos();
        }
        return;

      case 'refreshRepos':
        await this.loadRepos(true);
        return;

      case 'browse': {
        const current = suggestedDestinations(this.store)[0];
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Cloner ici',
          defaultUri: current ? vscode.Uri.file(current) : undefined
        });
        if (picked?.[0]) {
          this.post({ type: 'setDest', dest: picked[0].fsPath });
        }
        return;
      }

      case 'openRecent':
        await vscode.commands.executeCommand('quickClone.openPath', msg.path, msg.behavior);
        return;

      case 'removeRecent':
        await this.store.forgetClone(msg.path);
        return;

      case 'checkUpdates':
        await this.sync.checkAll({ silent: true });
        return;

      case 'updateRecent': {
        const outcome = await this.sync.update(msg.path);
        this.post({
          type: 'status',
          kind: outcome.ok ? 'ok' : 'error',
          text: outcome.message
        });
        return;
      }

      case 'clone':
        await this.runClone(msg);
        return;
    }
  }

  private async loadRepos(force = false): Promise<void> {
    this.reposLoading = true;
    this.reposError = undefined;
    this.sendRepos();
    try {
      await (force ? this.github.refresh() : this.github.list());
    } catch (err) {
      this.reposError = (err as Error).message;
    } finally {
      this.reposLoading = false;
      this.sendRepos();
    }
  }

  private async runClone(msg: CloneMessage): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!msg.url.trim()) {
      this.post({ type: 'status', kind: 'error', text: 'Choisis un dépôt ou saisis une URL.' });
      return;
    }
    if (!looksLikeRepoUrl(msg.url)) {
      this.post({
        type: 'status',
        kind: 'error',
        text: 'URL non reconnue. Attendu : https://…, git@…, ou user/repo.'
      });
      return;
    }

    this.busy = true;
    this.post({ type: 'busy', busy: true });
    this.post({ type: 'status', kind: 'info', text: 'Clonage en cours…' });

    const outcome = await performClone(
      this.ctx,
      this.store,
      {
        url: msg.url,
        parentDir: msg.dest,
        // Pas de nom saisi : performClone le déduit de l'URL, et ne demande
        // un autre nom que si le dossier existe déjà. Profondeur et sous-modules
        // ne sont pas laissés : performClone applique les réglages utilisateur.
        openBehavior: msg.openBehavior
      },
      (text, percent) => this.post({ type: 'progress', text, percent })
    );

    this.busy = false;
    this.post({ type: 'busy', busy: false });

    switch (outcome.status) {
      case 'done':
        this.post({ type: 'status', kind: 'ok', text: `Cloné dans ${outcome.target}` });
        this.post({ type: 'reset' });
        break;
      case 'opened-existing':
        this.post({ type: 'status', kind: 'info', text: 'Dossier existant ouvert.' });
        break;
      case 'cancelled':
        this.post({ type: 'status', kind: 'info', text: 'Annulé.' });
        break;
      case 'error':
        this.post({ type: 'status', kind: 'error', text: outcome.message ?? 'Échec du clone.' });
        break;
    }
  }

  private async prefillFromClipboard(force = false): Promise<void> {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!looksLikeRepoUrl(text)) {
      if (force) {
        this.post({
          type: 'status',
          kind: 'error',
          text: 'Le presse-papier ne contient pas une URL de dépôt.'
        });
      }
      return;
    }
    this.post({ type: 'setUrl', url: text, force });
  }

  private sendDestinations(): void {
    this.post({ type: 'setDestinations', destinations: suggestedDestinations(this.store) });
  }

  private sendRecents(): void {
    this.post({
      type: 'setRecents',
      busy: this.sync.busy,
      items: this.store.clones().map((c) => {
        const status = this.sync.status(c.path);
        return {
          name: c.name,
          path: c.path,
          state: status?.state ?? 'unknown',
          behind: status?.behind ?? 0,
          branch: status?.branch,
          message: status?.message
        };
      })
    });
  }

  private sendRepos(): void {
    const protocol = vscode.workspace
      .getConfiguration('quickClone')
      .get<string>('github.protocol', 'https');
    const hideArchived = vscode.workspace
      .getConfiguration('quickClone')
      .get<boolean>('github.hideArchived', true);

    const cached = this.github.cached();
    const repos = (cached ?? [])
      .filter((r: Repo) => !hideArchived || !r.archived)
      .map((r: Repo) => ({
        name: r.name,
        owner: r.owner,
        description: r.description,
        url: protocol === 'ssh' ? r.sshUrl : r.cloneUrl,
        private: r.private,
        fork: r.fork
      }));

    this.post({
      type: 'setRepos',
      signedIn: this.github.isSignedIn,
      loading: this.reposLoading,
      error: this.reposError,
      repos
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', name));
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('view.css')}" rel="stylesheet">
<title>Quick Clone</title>
</head>
<body>
  <div class="field">
    <div class="row">
      <input id="url" type="text" spellcheck="false"
             placeholder="URL, user/repo, ou filtrer mes dépôts…">
      <button id="paste" class="icon-btn" title="Coller depuis le presse-papier">Coller</button>
    </div>
  </div>

  <div id="ghSignedOut" class="gh-box" hidden>
    <button id="signIn" class="secondary">Se connecter à GitHub</button>
    <small>Pour retrouver tous tes dépôts directement ici.</small>
  </div>

  <div id="ghPane" hidden>
    <div class="gh-head">
      <span id="ghCount" class="muted"></span>
      <button id="ghRefresh" class="link-btn">Rafraîchir</button>
    </div>
    <div id="repos" class="repos" role="listbox"></div>
    <p id="ghNote" class="muted" hidden></p>
  </div>

  <label class="field">
    <span>Emplacement</span>
    <div class="row">
      <select id="dest"></select>
      <button id="browse" class="icon-btn" title="Choisir un dossier">Parcourir…</button>
    </div>
  </label>

  <label class="field">
    <span>Après le clone</span>
    <select id="open">
      <option value="newWindow">Ouvrir dans une nouvelle fenêtre</option>
      <option value="currentWindow">Ouvrir dans cette fenêtre</option>
      <option value="addToWorkspace">Ajouter au workspace</option>
      <option value="none">Ne rien ouvrir</option>
    </select>
  </label>

  <button id="submit" class="primary">Cloner</button>

  <div id="bar" class="bar" hidden><div id="fill"></div></div>
  <p id="status" class="status" hidden></p>

  <details id="recentsBox" class="recents-box" hidden>
    <summary>Clones récents</summary>
    <div class="recents-head">
      <span id="recentsInfo" class="muted"></span>
      <button id="checkUpdates" class="link-btn">Vérifier les mises à jour</button>
    </div>
    <div id="recents" class="recents"></div>
  </details>

  <script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
  }
}
