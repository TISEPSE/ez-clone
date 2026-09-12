import * as vscode from 'vscode';
import { spawn } from 'child_process';

/**
 * Récupère le binaire git configuré par l'extension Git intégrée
 * (respecte donc le réglage `git.path` de l'utilisateur).
 */
export async function getGitPath(): Promise<string> {
  const ext = vscode.extensions.getExtension<any>('vscode.git');
  if (ext) {
    try {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports.getAPI(1);
      if (api?.git?.path) {
        return api.git.path as string;
      }
    } catch {
      // l'extension Git peut être désactivée : on retombe sur le PATH
    }
  }
  return 'git';
}

export interface CloneOptions {
  url: string;
  parentDir: string;
  folderName: string;
  depth: number;
  recurseSubmodules: boolean;
}

const PROGRESS_RE = /^(remote: )?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/;

/**
 * Clone en affichant la progression réelle de git, avec annulation.
 * Rejette avec la sortie de git si le clone échoue.
 */
export async function clone(
  gitPath: string,
  opts: CloneOptions,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<void> {
  const args = ['clone', '--progress'];
  if (opts.depth > 0) {
    args.push('--depth', String(opts.depth));
  }
  if (opts.recurseSubmodules) {
    args.push('--recurse-submodules');
  }
  args.push('--', opts.url, opts.folderName);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(gitPath, args, {
      cwd: opts.parentDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    let lastPercent = 0;
    const stderr: string[] = [];

    const onLine = (line: string) => {
      stderr.push(line);
      const m = PROGRESS_RE.exec(line.trim());
      if (!m) {
        return;
      }
      const phase = m[2];
      const percent = Number(m[3]);
      // On ne fait avancer la barre que sur la phase la plus parlante.
      const increment = phase === 'Receiving objects' ? Math.max(0, percent - lastPercent) : 0;
      if (increment > 0) {
        lastPercent = percent;
      }
      progress.report({ message: `${phase} ${percent}%`, increment });
    };

    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      // git sépare la progression par \r et les messages par \n
      const parts = buffer.split(/\r|\n/);
      buffer = parts.pop() ?? '';
      parts.filter(Boolean).forEach(onLine);
    });

    const cancel = token.onCancellationRequested(() => child.kill());

    child.on('error', (err) => {
      cancel.dispose();
      reject(new Error(`Impossible de lancer git (${gitPath}) : ${err.message}`));
    });

    child.on('close', (code) => {
      cancel.dispose();
      if (buffer.trim()) {
        stderr.push(buffer);
      }
      if (token.isCancellationRequested) {
        reject(new CloneCancelled());
      } else if (code === 0) {
        resolve();
      } else {
        const tail = stderr.slice(-6).join(' ').trim();
        reject(new Error(tail || `git clone a échoué (code ${code}).`));
      }
    });
  });
}

export class CloneCancelled extends Error {
  constructor() {
    super('Clone annulé.');
  }
}

const URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)\S+$/i;
const SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/;

/** Vrai si le texte ressemble à une URL de dépôt ou à un raccourci `user/repo`. */
export function looksLikeRepoUrl(text: string): boolean {
  const t = text.trim();
  return URL_RE.test(t) || SHORTHAND_RE.test(t);
}

/** Développe `user/repo` en URL complète ; laisse les URLs intactes. */
export function normalizeUrl(text: string, shorthandHost: string): string {
  const t = text.trim();
  if (SHORTHAND_RE.test(t)) {
    return `${shorthandHost.replace(/\/?$/, '/')}${t}.git`;
  }
  return t;
}

/** Déduit le nom de dossier à partir de l'URL du dépôt. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '');
  const m = /([^/\\:]+)$/.exec(cleaned);
  return m ? m[1] : 'repo';
}
