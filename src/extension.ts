import * as vscode from 'vscode';
import * as fs from 'fs';
import { openTarget, performClone, suggestedDestinations, OpenBehavior } from './cloneService';
import { looksLikeRepoUrl } from './git';
import { GitHubRepos } from './github';
import { consumePendingSetup } from './setup';
import { Store } from './store';
import { SyncManager } from './sync';
import { CloneFormProvider } from './view';

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context);
  const github = new GitHubRepos(context);
  const sync = new SyncManager(store);
  const form = new CloneFormProvider(context, store, github, sync);

  const register = vscode.commands.registerCommand;

  context.subscriptions.push(
    sync,
    vscode.window.registerWebviewViewProvider(CloneFormProvider.viewId, form, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    // Connexion/déconnexion depuis le menu Comptes : le panneau se met à jour.
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') {
        void github.syncSignInState();
      }
    }),

    register('ezClone.clone', () => form.focusUrl()),
    register('ezClone.clonePalette', () => paletteFlow(context, store)),
    register('ezClone.githubSignIn', () => github.signIn()),

    // Utilisée par le panneau pour rouvrir un clone récent.
    register('ezClone.openPath', async (target: string, behavior: OpenBehavior) => {
      if (!fs.existsSync(target)) {
        const forget = 'Retirer de la liste';
        const answer = await vscode.window.showWarningMessage(
          `EZ Clone : ${target} est introuvable.`,
          forget
        );
        if (answer === forget) {
          await store.forgetClone(target);
        }
        return;
      }
      await openTarget(target, behavior === 'none' ? 'newWindow' : behavior);
    }),

    // Parcours de l'historique sans la barre latérale.
    register('ezClone.openRecent', () => openRecentFlow(store)),

    register('ezClone.checkUpdates', async () => {
      const statuses = await sync.checkAll({ silent: true });
      const pending = statuses.filter((s) => s.state === 'behind');
      if (pending.length === 0) {
        vscode.window.showInformationMessage(
          statuses.length === 0
            ? 'EZ Clone : aucun clone connu à vérifier.'
            : 'EZ Clone : tous les dépôts sont à jour.'
        );
        return;
      }
      await updateFlow(sync, pending.map((s) => s.path));
    }),

    // Déclenchée par le bouton « Mettre à jour » du panneau.
    register('ezClone.updateRepo', async (target: string) => {
      const outcome = await sync.update(target);
      if (!outcome.ok) {
        vscode.window.showWarningMessage(`EZ Clone : ${outcome.message}`);
      } else {
        vscode.window.showInformationMessage(`EZ Clone : ${outcome.message}`);
      }
    }),

    vscode.window.registerUriHandler({
      // vscode://tisepse.ez-clone/clone?url=https://github.com/user/repo.git
      handleUri: (uri) => {
        const url = new URLSearchParams(uri.query).get('url');
        if (uri.path === '/clone' && url) {
          void form.fill(url);
        }
      }
    })
  );

  void github.syncSignInState();
  void consumePendingSetup(context);
  sync.start(context);
}

/**
 * Confirmation unique puis mise à jour en fast-forward des dépôts en retard.
 * Pour un seul dépôt, on laisse `sync.update` poser sa propre question.
 */
async function updateFlow(sync: SyncManager, paths: string[]): Promise<void> {
  if (paths.length === 1) {
    const single = await sync.update(paths[0]);
    vscode.window[single.ok ? 'showInformationMessage' : 'showWarningMessage'](
      `EZ Clone : ${single.message}`
    );
    return;
  }

  const yes = 'Tout mettre à jour';
  const answer = await vscode.window.showInformationMessage(
    `${paths.length} dépôts peuvent être mis à jour.`,
    {
      modal: true,
      detail:
        sync
          .updatable()
          .map((s) => `• ${s.name} — ${s.behind} commit(s)`)
          .join('\n') + '\n\nAvance en fast-forward uniquement, sans fusion ni rebase.'
    },
    yes
  );
  if (answer !== yes) {
    return;
  }

  const results = [];
  for (const target of paths) {
    results.push(await sync.update(target, false));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    vscode.window.showInformationMessage(`EZ Clone : ${results.length} dépôts mis à jour.`);
  } else {
    vscode.window.showWarningMessage(
      `EZ Clone : ${results.length - failed.length} mis à jour, ${failed.length} en échec (${failed[0].message})`
    );
  }
}

export function deactivate(): void {
  // rien a liberer
}

/** Parcours 100 % clavier, gardé pour la palette de commandes. */
async function paletteFlow(context: vscode.ExtensionContext, store: Store): Promise<void> {
  const clipboard = (await vscode.env.clipboard.readText()).trim();
  const prefill = looksLikeRepoUrl(clipboard) ? clipboard : '';

  const url = await vscode.window.showInputBox({
    title: 'EZ Clone',
    prompt: 'URL du dépôt (ou raccourci "user/repo")',
    placeHolder: 'https://github.com/user/repo.git',
    value: prefill,
    valueSelection: prefill ? [0, prefill.length] : undefined,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim().length === 0 || looksLikeRepoUrl(v) ? undefined : 'URL de dépôt non reconnue.'
  });
  if (!url) {
    return;
  }

  const known = suggestedDestinations(store);
  const browse = {
    label: '$(search) Parcourir…',
    alwaysShow: true,
    dir: undefined as string | undefined
  };
  const picked = await vscode.window.showQuickPick(
    [...known.map((dir) => ({ label: `$(folder) ${dir}`, dir })), browse],
    { title: 'EZ Clone — où cloner ?', ignoreFocusOut: true }
  );
  if (!picked) {
    return;
  }

  let parentDir = picked.dir;
  if (!parentDir) {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Cloner ici'
    });
    parentDir = chosen?.[0]?.fsPath;
  }
  if (!parentDir) {
    return;
  }

  const behavior = await pickBehavior();
  if (!behavior) {
    return;
  }

  const outcome = await performClone(context, store, { url, parentDir, openBehavior: behavior });
  if (outcome.status === 'error') {
    vscode.window.showErrorMessage(`EZ Clone : ${outcome.message}`);
  }
}

/** Liste l'historique des clones et ouvre celui qu'on choisit. */
async function openRecentFlow(store: Store): Promise<void> {
  const clones = store.clones();
  if (clones.length === 0) {
    vscode.window.showInformationMessage('EZ Clone : aucun projet cloné dans l’historique.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    clones.map((c) => ({
      label: `$(repo) ${c.name}`,
      description: fs.existsSync(c.path) ? undefined : 'introuvable',
      detail: c.path,
      path: c.path
    })),
    { title: 'EZ Clone — ouvrir un projet cloné', matchOnDetail: true, ignoreFocusOut: true }
  );
  if (!picked) {
    return;
  }

  const behavior = await pickBehavior('Comment ouvrir ce projet ?');
  if (!behavior) {
    return;
  }
  await vscode.commands.executeCommand('ezClone.openPath', picked.path, behavior);
}

async function pickBehavior(title?: string): Promise<OpenBehavior | undefined> {
  // Le réglage ne vaut que pour le parcours de clonage : ouvrir un projet
  // existant demande toujours, sinon le choix serait invisible.
  if (!title) {
    const configured = vscode.workspace
      .getConfiguration('ezClone')
      .get<string>('openBehavior', 'ask');
    if (configured !== 'ask') {
      return configured as OpenBehavior;
    }
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(empty-window) Nouvelle fenêtre', value: 'newWindow' as const },
      { label: '$(window) Fenêtre courante', value: 'currentWindow' as const },
      { label: '$(add) Ajouter au workspace', value: 'addToWorkspace' as const }
    ],
    { title: title ?? 'Clone terminé — comment l’ouvrir ?', ignoreFocusOut: true }
  );
  return picked?.value;
}
