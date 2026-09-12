# Quick Clone

Extension VS Code : cloner un dépôt Git depuis un panneau dans la barre latérale,
et l'ouvrir immédiatement.

## L'interface

Une icône **Quick Clone** dans la barre d'activité ouvre un panneau unique,
de haut en bas :

**Le champ du haut** sert à la fois d'URL et de filtre. Tape `api` et la liste
de tes dépôts se réduit ; colle une URL complète et elle est prise telle quelle.
Le bouton **Coller** récupère le presse-papier.

**La liste de tes dépôts GitHub** apparaît juste en dessous. Tant que tu n'es pas
connecté, un bouton **Se connecter à GitHub** prend sa place. Un clic sur un dépôt
le sélectionne, un double-clic clone directement. Les badges distinguent privé et
fork. Le compteur et le lien **Rafraîchir** sont au-dessus de la liste.

**Dossier** est déduit du dépôt choisi et reste modifiable.

**Emplacement** est une liste déroulante des racines connues, avec **Parcourir…**.

**Après le clone** : nouvelle fenêtre, fenêtre courante, workspace, ou rien.

**Cloner** lance l'opération, avec barre de progression et statut en dessous.
`Entrée` dans un champ texte fait la même chose.

**Clones récents** (replié, en bas) : un clic sur le nom rouvre le projet dans une
**nouvelle fenêtre**. `Ctrl`/`Cmd` + clic, ou le bouton `⇱` au survol, l'ouvre dans
la fenêtre courante. La croix retire l'entrée de la liste — sans toucher au disque.

### La connexion GitHub

Elle passe par le fournisseur d'authentification intégré de VS Code (le même que
celui de l'extension GitHub officielle) : aucun token à créer ni à stocker, et le
compte est révocable depuis le menu **Comptes** en bas à gauche. Les scopes demandés
sont `repo` (nécessaire pour voir les dépôts privés) et `read:org`. La liste couvre
tes dépôts, ceux où tu es collaborateur et ceux de tes organisations, triés par date
de dernier push, mise en cache et rechargée à la demande.

## Raccourci et palette

- `Ctrl+Alt+Shift+C` ouvre le panneau avec le curseur dans le champ URL.
- `Quick Clone: Cloner un dépôt (au clavier, sans la barre latérale)` garde
  l'ancien parcours 100 % clavier à base de QuickPicks, pour ceux qui préfèrent.
- `Quick Clone: Ouvrir un projet cloné` parcourt l'historique et ouvre le projet
  choisi, sans passer par la barre latérale.

## Mise à jour des dépôts clonés

Quick Clone garde un œil sur les clones qu'il connaît et prévient quand le dépôt
a avancé en amont — mais ne touche jamais au disque sans confirmation.

- Au démarrage, au retour de focus sur la fenêtre, puis au plus une fois par
  `quickClone.updateCheckInterval` minutes, un `git fetch --prune` silencieux est
  lancé sur chaque clone récent (3 en parallèle au maximum).
- Les dépôts en retard affichent un bouton `↓ n` dans « Clones récents ».
  Un clic ouvre une confirmation qui rappelle le nombre de commits et la branche.
- La mise à jour est un `git merge --ff-only @{u}` : jamais de fusion, jamais de
  rebase, jamais de perte de travail local.
- Un dépôt est marqué « bloqué » et laissé tel quel s'il a des commits locaux non
  poussés, des modifications non commitées (fichiers suivis), un HEAD détaché ou
  aucune branche de suivi. Le détail apparaît en infobulle.
- `Quick Clone: Vérifier les mises à jour des dépôts clonés` force une
  vérification, et propose de tout mettre à jour en une confirmation.
- Mettre `quickClone.autoCheckUpdates` à `false` désactive les vérifications
  automatiques ; le bouton du panneau et la commande restent disponibles.

L'historique des clones est marqué pour Settings Sync : la même liste de dépôts
suit ton compte d'une machine à l'autre. Attention, git synchronise des *commits* :
le travail non commité et les fichiers ignorés (`.env`, `node_modules`) ne voyagent pas.

## Ce qui se passe sous le capot

- Le binaire git vient de l'API de l'extension Git intégrée : ton réglage
  `git.path` est respecté.
- `git clone --progress` est lancé directement, la progression affichée est la
  vraie sortie de git, et le clone est annulable. Annuler nettoie le dossier partiel.
- Si le dossier cible existe déjà, une boîte de dialogue propose de l'ouvrir ou
  de renommer — au lieu de laisser git échouer.
- Si un `package.json`, `Cargo.toml`, `requirements.txt`… est détecté,
  l'installation des dépendances est proposée dans un terminal *après* l'ouverture.

## Réglages

| Clé | Défaut | Rôle |
|---|---|---|
| `quickClone.defaultRoot` | `""` | Emplacement en tête de liste (`~` accepté) |
| `quickClone.openBehavior` | `ask` | Comportement de la commande palette uniquement |
| `quickClone.depth` | `0` | `--depth` appliqué à tous les clones ; `0` = clone complet |
| `quickClone.recurseSubmodules` | `false` | `--recurse-submodules` appliqué à tous les clones |
| `quickClone.shorthandHost` | `https://github.com/` | Hôte pour les raccourcis `user/repo` |
| `quickClone.postCloneSetup` | `ask` | `ask` / `always` / `never` |
| `quickClone.github.protocol` | `https` | `https` ou `ssh` pour les clones depuis la liste GitHub |
| `quickClone.github.hideArchived` | `true` | Masquer les dépôts archivés |
| `quickClone.autoCheckUpdates` | `true` | Vérifier en arrière-plan les nouveaux commits en amont |
| `quickClone.updateCheckInterval` | `30` | Délai minimum entre deux vérifications, en minutes |
| `quickClone.maxRecentDestinations` | `8` | Taille de la liste des emplacements |

## Lien externe

L'extension enregistre un gestionnaire d'URI :

```
vscode://local.quick-clone/clone?url=https://github.com/user/repo.git
```

Il ouvre le panneau avec l'URL pré-remplie.

## Développement

```sh
npm install
npm run compile        # ou npm run watch
npm run package        # produit le .vsix
```

`F5` lance une fenêtre « Extension Development Host » avec l'extension chargée.
Pour installer le paquet réellement :

```sh
code --install-extension quick-clone-0.5.0.vsix --force
```

## Structure

```
media/
  view.css       styles du panneau, basés sur les variables de thème VS Code
  view.js        logique du panneau : filtre, liste GitHub, récents (webview)
resources/
  quick-clone.svg  icône de la barre d'activité
src/
  extension.ts   activation, commandes, parcours palette
  view.ts        fournisseur de la webview + HTML + messages
  github.ts      session GitHub, appels API, cache
  cloneService.ts chemin unique du clone : collision, git, historique, ouverture
  store.ts       historique (emplacements + clones) dans globalState, synchronisé
  sync.ts        fetch en arrière-plan, écart avec l'upstream, mise à jour ff-only
  git.ts         binaire git, clone + progression, parsing d'URL
  setup.ts       détection du gestionnaire de dépendances, install différée
```

## Limites connues

- Desktop uniquement : le clone utilise `child_process`, donc pas de support
  vscode.dev / github.dev.
- Ouvrir dans la fenêtre courante recharge l'extension host ; c'est pour ça que
  l'installation des dépendances passe par `globalState` et se déclenche à
  l'activation suivante plutôt que juste après le clone.
- L'authentification repose sur le credential helper de git. `GIT_TERMINAL_PROMPT=0`
  est forcé pour éviter qu'un prompt invisible bloque le processus : un dépôt privé
  sans credential configuré échouera avec un message d'erreur explicite.
