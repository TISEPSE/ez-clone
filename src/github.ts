import * as vscode from 'vscode';

const PROVIDER = 'github';
/** `repo` couvre les dépôts privés ; sans lui on ne verrait que les publics. */
const SCOPES = ['repo', 'read:org'];
const CACHE_KEY = 'ezClone.githubRepos';
const MAX_PAGES = 5;

export interface Repo {
  fullName: string;
  name: string;
  owner: string;
  description: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushedAt: string;
  defaultBranch: string;
}

export class GitHubError extends Error {}

/**
 * Session GitHub via le fournisseur d'authentification intégré de VS Code :
 * aucun token à gérer nous-mêmes, l'utilisateur voit le compte dans le menu Comptes.
 */
export async function getSession(
  createIfNone: boolean
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(PROVIDER, SCOPES, { createIfNone });
  } catch (err) {
    // L'utilisateur a annulé la fenêtre de connexion : ce n'est pas une erreur.
    if (createIfNone) {
      return undefined;
    }
    throw err;
  }
}

export class GitHubRepos {
  private cache: Repo[] | undefined;
  private inflight: Promise<Repo[]> | undefined;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private signedIn = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.cache = ctx.globalState.get<Repo[]>(CACHE_KEY, []);
    if (this.cache.length === 0) {
      this.cache = undefined;
    }
  }

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  /** Met à jour `ezClone.signedIn`, qui pilote l'affichage des vues. */
  async syncSignInState(): Promise<void> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await getSession(false);
    } catch {
      session = undefined;
    }
    this.signedIn = !!session;
    await vscode.commands.executeCommand('setContext', 'ezClone.signedIn', this.signedIn);
    this.emitter.fire();
  }

  async signIn(): Promise<boolean> {
    const session = await getSession(true);
    await this.syncSignInState();
    if (session) {
      await this.refresh();
    }
    return !!session;
  }

  /** Liste en cache si disponible ; sinon va la chercher. */
  async list(): Promise<Repo[]> {
    if (this.cache) {
      return this.cache;
    }
    return this.refresh();
  }

  cached(): Repo[] | undefined {
    return this.cache;
  }

  async refresh(): Promise<Repo[]> {
    // Deux vues peuvent demander la liste en même temps : une seule requête.
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchAll().finally(() => {
      this.inflight = undefined;
    });
    const repos = await this.inflight;
    this.cache = repos;
    await this.ctx.globalState.update(CACHE_KEY, repos);
    this.emitter.fire();
    return repos;
  }

  async clearCache(): Promise<void> {
    this.cache = undefined;
    await this.ctx.globalState.update(CACHE_KEY, []);
    this.emitter.fire();
  }

  private async fetchAll(): Promise<Repo[]> {
    const session = await getSession(false);
    if (!session) {
      throw new GitHubError('Connexion GitHub requise.');
    }

    const out: Repo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        'https://api.github.com/user/repos' +
        `?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vscode-ez-clone'
        }
      });

      if (res.status === 401) {
        throw new GitHubError('Session GitHub expirée. Reconnecte-toi depuis le menu Comptes.');
      }
      if (res.status === 403) {
        throw new GitHubError('GitHub a refusé la requête (quota d’API atteint ?).');
      }
      if (!res.ok) {
        throw new GitHubError(`GitHub a répondu ${res.status} ${res.statusText}.`);
      }

      const batch = (await res.json()) as any[];
      for (const r of batch) {
        out.push({
          fullName: r.full_name,
          name: r.name,
          owner: r.owner?.login ?? '',
          description: r.description ?? '',
          cloneUrl: r.clone_url,
          sshUrl: r.ssh_url,
          private: !!r.private,
          fork: !!r.fork,
          archived: !!r.archived,
          pushedAt: r.pushed_at ?? '',
          defaultBranch: r.default_branch ?? ''
        });
      }
      if (batch.length < 100) {
        break;
      }
    }
    return out;
  }
}
