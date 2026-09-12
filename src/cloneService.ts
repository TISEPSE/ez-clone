import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clone, CloneCancelled, getGitPath, normalizeUrl, repoNameFromUrl } from './git';
import { detectSetup, queueSetup } from './setup';
import { Store } from './store';

export type OpenBehavior = 'newWindow' | 'currentWindow' | 'addToWorkspace' | 'none';

export interface CloneRequest {
  url: string;
  parentDir: string;
  folderName?: string;
  openBehavior: OpenBehavior;
  depth?: number;
  recurseSubmodules?: boolean;
}

export type ProgressReporter = (message: string, percent: number) => void;

export interface CloneOutcome {
  status: 'done' | 'cancelled' | 'error' | 'opened-existing';
  target?: string;
  message?: string;
}

/**
 * Chemin unique du clone : validation, collision, git, historique, ouverture.
 * Ne lève pas — retourne un statut, pour que le formulaire puisse l'afficher.
 */
export async function performClone(
  ctx: vscode.ExtensionContext,
  store: Store,
  req: CloneRequest,
  report: ProgressReporter = () => undefined
): Promise<CloneOutcome> {
  const cfg = vscode.workspace.getConfiguration('quickClone');
  const url = normalizeUrl(req.url, cfg.get<string>('shorthandHost', 'https://github.com/'));
  const parentDir = expandHome(req.parentDir.trim());

  if (!url) {
    return { status: 'error', message: 'URL manquante.' };
  }
  if (!parentDir) {
    return { status: 'error', message: 'Emplacement manquant.' };
  }

  try {
    await fs.promises.mkdir(parentDir, { recursive: true });
  } catch (err) {
    return {
      status: 'error',
      message: `Impossible de créer ${parentDir} : ${(err as Error).message}`
    };
  }

  const wanted = (req.folderName || '').trim() || repoNameFromUrl(url);
  const resolved = await resolveFolderName(parentDir, wanted);
  if (resolved.action === 'cancel') {
    return { status: 'cancelled' };
  }
  if (resolved.action === 'open-existing') {
    await openTarget(resolved.target, req.openBehavior === 'none' ? 'newWindow' : req.openBehavior);
    return { status: 'opened-existing', target: resolved.target };
  }

  const folderName = resolved.name;
  const target = path.join(parentDir, folderName);
  const gitPath = await getGitPath();

  const depth = req.depth ?? cfg.get<number>('depth', 0);
  const recurseSubmodules = req.recurseSubmodules ?? cfg.get<boolean>('recurseSubmodules', false);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Clonage de ${folderName}...`,
        cancellable: true
      },
      (progress, token) =>
        clone(
          gitPath,
          { url, parentDir, folderName, depth, recurseSubmodules },
          {
            report: (value: { message?: string; increment?: number }) => {
              progress.report(value);
              const m = /(\d{1,3})%/.exec(value.message ?? '');
              report(value.message ?? '', m ? Number(m[1]) : -1);
            }
          },
          token
        )
    );
  } catch (err) {
    if (err instanceof CloneCancelled) {
      // Le dossier partiel empecherait un nouvel essai avec le meme nom.
      await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
      return { status: 'cancelled' };
    }
    return { status: 'error', message: (err as Error).message };
  }

  await store.rememberDestination(parentDir);
  await store.rememberClone({ name: folderName, path: target, url, at: Date.now() });

  const setup = detectSetup(target);
  if (setup && cfg.get<string>('postCloneSetup', 'ask') !== 'never') {
    await queueSetup(ctx, target, setup);
  }

  if (req.openBehavior !== 'none') {
    await openTarget(target, req.openBehavior);
  }
  return { status: 'done', target };
}

type Resolution =
  | { action: 'clone'; name: string }
  | { action: 'open-existing'; target: string }
  | { action: 'cancel' };

/** Gere la collision avec un dossier existant plutot que de laisser git echouer. */
async function resolveFolderName(parentDir: string, suggestion: string): Promise<Resolution> {
  let name = suggestion;
  for (;;) {
    const target = path.join(parentDir, name);
    if (!fs.existsSync(target)) {
      return { action: 'clone', name };
    }
    const isRepo = fs.existsSync(path.join(target, '.git'));
    const openIt = 'Ouvrir ce dossier';
    const rename = 'Choisir un autre nom';
    const choice = await vscode.window.showWarningMessage(
      `${target} existe déjà${isRepo ? ' et contient un dépôt Git.' : '.'}`,
      { modal: true },
      ...(isRepo ? [openIt, rename] : [rename])
    );
    if (choice === openIt) {
      return { action: 'open-existing', target };
    }
    if (choice !== rename) {
      return { action: 'cancel' };
    }
    const next = await vscode.window.showInputBox({
      title: 'Nom du dossier',
      value: name,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Nom requis.')
    });
    if (!next) {
      return { action: 'cancel' };
    }
    name = next.trim();
  }
}

export async function openTarget(target: string, behavior: OpenBehavior): Promise<void> {
  const uri = vscode.Uri.file(target);
  if (behavior === 'none') {
    return;
  }
  if (behavior === 'addToWorkspace') {
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(count, 0, { uri });
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  // Attention : en fenetre courante, cet appel recharge l'extension host.
  await vscode.commands.executeCommand('vscode.openFolder', uri, {
    forceNewWindow: behavior === 'newWindow'
  });
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Emplacements proposés dans le formulaire, sans doublon, ordre = pertinence. */
export function suggestedDestinations(store: Store): string[] {
  const cfg = vscode.workspace.getConfiguration('quickClone');
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (dir?: string) => {
    if (!dir) {
      return;
    }
    const full = expandHome(dir.trim());
    const key = path.resolve(full).toLowerCase();
    if (!full || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(full);
  };

  push(cfg.get<string>('defaultRoot', ''));
  store.destinations().forEach(push);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    push(path.dirname(workspaceRoot));
  }
  return out;
}
