import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const PENDING_KEY = 'ezClone.pendingSetup';

interface PendingSetup {
  folder: string;
  label: string;
  command: string;
}

/** Premier match gagne : les lockfiles passent avant les manifestes. */
const DETECTORS: { file: string; label: string; command: string }[] = [
  { file: 'pnpm-lock.yaml', label: 'pnpm', command: 'pnpm install' },
  { file: 'yarn.lock', label: 'Yarn', command: 'yarn install' },
  { file: 'bun.lockb', label: 'Bun', command: 'bun install' },
  { file: 'bun.lock', label: 'Bun', command: 'bun install' },
  { file: 'package-lock.json', label: 'npm', command: 'npm install' },
  { file: 'package.json', label: 'npm', command: 'npm install' },
  { file: 'uv.lock', label: 'uv', command: 'uv sync' },
  { file: 'poetry.lock', label: 'Poetry', command: 'poetry install' },
  { file: 'requirements.txt', label: 'pip', command: 'pip install -r requirements.txt' },
  { file: 'Cargo.toml', label: 'Cargo', command: 'cargo fetch' },
  { file: 'go.mod', label: 'Go', command: 'go mod download' },
  { file: 'composer.json', label: 'Composer', command: 'composer install' },
  { file: 'Gemfile', label: 'Bundler', command: 'bundle install' }
];

/** Détecte le gestionnaire de dépendances d'un projet fraîchement cloné. */
export function detectSetup(folder: string): { label: string; command: string } | undefined {
  for (const d of DETECTORS) {
    if (fs.existsSync(path.join(folder, d.file))) {
      return { label: d.label, command: d.command };
    }
  }
  return undefined;
}

/**
 * Mémorise l'installation à proposer. Nécessaire car `vscode.openFolder`
 * recharge l'extension : on ne peut rien exécuter juste après le clone.
 */
export async function queueSetup(
  context: vscode.ExtensionContext,
  folder: string,
  setup: { label: string; command: string }
): Promise<void> {
  const pending = context.globalState.get<PendingSetup[]>(PENDING_KEY, []);
  const next = pending.filter((p) => !samePath(p.folder, folder));
  next.push({ folder, ...setup });
  await context.globalState.update(PENDING_KEY, next.slice(-5));
}

/** À l'activation : si le workspace courant est un clone en attente, on propose l'install. */
export async function consumePendingSetup(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<PendingSetup[]>(PENDING_KEY, []);
  if (pending.length === 0) {
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const hit = pending.find((p) => folders.some((f) => samePath(f.uri.fsPath, p.folder)));
  if (!hit) {
    return;
  }
  await context.globalState.update(
    PENDING_KEY,
    pending.filter((p) => p !== hit)
  );

  const mode = vscode.workspace.getConfiguration('ezClone').get<string>('postCloneSetup', 'ask');
  if (mode === 'never') {
    return;
  }
  if (mode === 'ask') {
    const choice = await vscode.window.showInformationMessage(
      `Projet ${hit.label} détecté. Installer les dépendances ?`,
      'Installer',
      'Ignorer'
    );
    if (choice !== 'Installer') {
      return;
    }
  }
  const terminal = vscode.window.createTerminal({ name: 'EZ Clone: setup', cwd: hit.folder });
  terminal.show();
  terminal.sendText(hit.command);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[/\\]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
