import * as vscode from 'vscode';

const DESTS_KEY = 'ezClone.recentDestinations';
const CLONES_KEY = 'ezClone.recentClones';

export interface RecentClone {
  name: string;
  path: string;
  url: string;
  at: number;
}

/** Historique partagé entre le formulaire, l'arbre des récents et la palette. */
export class Store {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    // Suit le compte de l'utilisateur via Settings Sync : l'historique des
    // clones est alors le même sur toutes ses machines.
    ctx.globalState.setKeysForSync([DESTS_KEY, CLONES_KEY]);
  }

  private get max(): number {
    return vscode.workspace
      .getConfiguration('ezClone')
      .get<number>('maxRecentDestinations', 8);
  }

  destinations(): string[] {
    return this.ctx.globalState.get<string[]>(DESTS_KEY, []);
  }

  async rememberDestination(dir: string): Promise<void> {
    if (this.max <= 0) {
      return;
    }
    const previous = this.destinations().filter(
      (d) => d.toLowerCase() !== dir.toLowerCase()
    );
    await this.ctx.globalState.update(DESTS_KEY, [dir, ...previous].slice(0, this.max));
    this.emitter.fire();
  }

  clones(): RecentClone[] {
    return this.ctx.globalState.get<RecentClone[]>(CLONES_KEY, []);
  }

  async rememberClone(clone: RecentClone): Promise<void> {
    const previous = this.clones().filter(
      (c) => c.path.toLowerCase() !== clone.path.toLowerCase()
    );
    await this.ctx.globalState.update(CLONES_KEY, [clone, ...previous].slice(0, 20));
    this.emitter.fire();
  }

  async forgetClone(path: string): Promise<void> {
    const next = this.clones().filter((c) => c.path.toLowerCase() !== path.toLowerCase());
    await this.ctx.globalState.update(CLONES_KEY, next);
    this.emitter.fire();
  }

  async clearClones(): Promise<void> {
    await this.ctx.globalState.update(CLONES_KEY, []);
    this.emitter.fire();
  }

  async clearDestinations(): Promise<void> {
    await this.ctx.globalState.update(DESTS_KEY, []);
    this.emitter.fire();
  }
}
