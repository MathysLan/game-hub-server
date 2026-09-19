# game-hub-server

Orchestrateur de session du portfolio [mathyslan.github.io](https://mathyslan.github.io).
Un salon (un groupe d'amis, leurs identités, leur hôte) et **le tirage du jeu**
pour ce groupe. Rien d'autre.

```
PROFIL / JOUEURS  →  SESSION  →  SÉLECTION (tirage)  →  (plus tard) HANDOFF  →  SERVEUR DE JEU
                     ▲────── ce dépôt ──────▲                                    ▲ les 7 existants
```

## Ce que le Hub ne fait pas — et ne doit jamais faire

Il ne connaît **aucune règle**, **aucun score**, **aucun secret**, **aucun
contenu**. Les sept serveurs de jeu (morpion, imitation, demicercle, ban,
precision, passeur, qui-ment) restent seuls arbitres de leurs parties. Si une
notion de gameplay apparaît un jour dans `src/`, c'est que la frontière a bougé
au mauvais endroit.

## Ce qui n'est pas encore là

Volontairement absents :

| | |
|---|---|
| handoff vers un jeu, jeton de lancement | phase suivante |
| score cumulé de soirée, retour du jeu au Hub | avec le handoff |
| historique de CONTENU (`usedContent`), rejouer | phases tardives |
| compte, authentification, base de données | jamais |
| matchmaking public | jamais — c'est un Hub entre amis |

Aucun des sept serveurs de jeu n'a été modifié, et aucun ne l'est par ce dépôt.

## Lancer

```bash
npm install
npm start            # écoute sur $PORT, 8100 par défaut
npm test             # modèle, puis protocole, puis bout en bout
```

Variables d'environnement : `PORT` (8100), `MANIFEST_URL` (défaut : le
manifest publié par GitHub Pages, `https://mathyslan.github.io/data/games.manifest.json`),
`MANIFEST_FILE` (un fichier local à la place — tests, développement hors ligne).

## Modèle

### Session

```js
{
  id,                    // interne — NE SORT JAMAIS ; le code est la poignée publique
  code,                  // 5 caractères, public
  hostId,
  state,                 // voir plus bas
  createdAt,
  players: [ … ],
  sockets: Map,          // à CÔTÉ des joueurs, jamais dedans
  draw: null,            // le tirage courant, ou le dernier confirmé (voir « Randomizer »)
  drawCount: 0,          // numérote les tirages
  history: { played: [], usedContent: {} },   // played grandit à chaque tirage, jamais remis à zéro
  constraints: { maxMinutes: null },           // réglé par l'hôte
  maxPlayers, graceMs
}
```

### Player

```js
{
  id,                    // fourni par le client, valeur OPAQUE
  name,                  // ≤ 16 caractères
  avatar: { kind: 'emoji' | 'image', emoji, src? },
  caps:  { mic: false },  // DÉCLARATIF, faux par défaut ; clés : mic, cam, consent
  veto:  [],             // ids de jeux — modifiable par le joueur LUI-MÊME seulement
  love:  [],
  connected,             // un socket vivant est-il attaché ?
  since                  // interne, ne sort pas
}
```

⚠️ `player.id` **ne prouve rien**. L'autorité vient du socket, comme dans les
sept jeux. Cet id sert uniquement à se reconnaître dans SA session lors d'une
reconnexion.

### États

`lobby` → `drawing` → `launching` → `inGame` → `debrief` → `closed`

Le randomizer en fait vivre quatre :

| État | Quand |
|---|---|
| `lobby` | le salon, avant le premier tirage |
| `drawing` | un tirage est demandé (`draw.status: 'pending'`), puis révélé (`'drawn'`) |
| `debrief` | l'hôte a confirmé (`'confirmed'`) : retour au Hub, prêt pour la suite — ou le tirage suivant |
| `closed` | fin |

`launching` et `inGame` restent réservés au handoff : **aucune transition ne
les atteint aujourd'hui**. On entre dans une session en `lobby`, `drawing` ou
`debrief`.

## Protocole WebSocket

Même convention que les sept jeux : le client envoie `{ action }`, le serveur
renvoie `{ type }`, en JSON sur un seul socket.

### Client → serveur

| `action` | Charge | Effet |
|---|---|---|
| `create` | `player` | crée une session, l'appelant devient hôte |
| `join` | `code`, `player` | rejoint, ou **reprend sa place** si l'id est déjà connu |
| `leave` | — | quitte tout de suite, sans délai de grâce |
| `prefs` | `love[]`, `veto[]` | ses PROPRES ❤️ / 🚫 (ids de jeux) |
| `caps` | `caps` (`{ mic: true }`) | ses PROPRES capacités, déclaratives |
| `constraints` | `maxMinutes` (ou `null`) | **hôte** — durée maximale d'un jeu |
| `draw` | — | **hôte** — « tire le prochain jeu ». Aucun autre champ n'est lu |
| `continue` | — | **hôte** — prend acte du jeu tiré |

### Serveur → client

| `type` | Charge |
|---|---|
| `created` | `you` (l'id de l'appelant), `session` |
| `joined` | `you`, `session` |
| `session` | `session` — diffusé à tous à chaque changement |
| `error` | `code`, `message` |

`session` est l'**état public** : `{ code, state, hostId, maxPlayers, players[],
constraints, draw, history, pool }`. Ni socket, ni identifiant interne.
`pool` = ce que le moteur dit du catalogue pour CE groupe, recalculé à chaque
diffusion : `{ catalog, games[], eligible[], why{}, weights{}, health{} }`.
Un `error` `NO_ELIGIBLE_GAME` porte en plus `why`.

### Erreurs

Les jeux n'envoient que `{ type: 'error', message }`. Le Hub ajoute un `code`
machine : il devra distinguer « code inconnu » de « session pleine » pour
proposer la bonne suite. Le `message` humain reste au même endroit.

| `code` | Quand |
|---|---|
| `BAD_JSON` | message illisible |
| `TOO_BIG` | au-delà de 32 Ko — le socket est fermé ensuite |
| `UNKNOWN_ACTION` | action hors de la liste |
| `BAD_PLAYER` | identité refusée (le `message` dit pourquoi) |
| `BAD_CODE` | code mal formé |
| `SESSION_NOT_FOUND` | aucune session avec ce code |
| `SESSION_FULL` | 12 joueurs déjà présents |
| `SESSION_CLOSED` | session terminée |
| `ALREADY_IN_SESSION` | ce socket est déjà dans une session |
| `NOT_IN_SESSION` | `leave` sans session |
| `REPLACED` | ce socket vient d'être remplacé par une autre connexion du même joueur |
| `NOT_HOST` | `draw`, `continue` ou `constraints` par un non-hôte |
| `DRAW_IN_PROGRESS` | un tirage est déjà en cours (`drawing`) |
| `NOT_DRAWN` | `continue` sans tirage révélé |
| `NO_ELIGIBLE_GAME` | aucun jeu possible pour ce groupe — `why` dit pourquoi, jeu par jeu |
| `MANIFEST_UNAVAILABLE` | catalogue illisible et aucun ancien en mémoire |
| `DRAW_FAILED` | erreur interne pendant un tirage (la session revient à son état) |
| `BAD_PREFS` / `BAD_CAPS` / `BAD_CONSTRAINTS` | réglage mal formé |

## Décisions, et pourquoi

### Le code a 5 caractères, pas 4

Relevé dans les sept serveurs : cinq tirent 4 signes dans
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, deux (passeur, qui-ment) tirent 4 lettres
dans un alphabet de 23. Le Hub reprend l'alphabet non ambigu — ni I, ni L, ni O,
ni 0, ni 1 — mais **passe à 5**, parce qu'un joueur aura bientôt deux codes en
main : celui de la session et celui de la partie. À 5 contre 4, on sait tout de
suite lequel on tient. 31⁵ = 28,6 millions de combinaisons.

### Un seul socket actif par joueur, et c'est le dernier qui gagne

Une seconde connexion avec le même `player.id` **ferme la première** (code
`REPLACED`, fermeture 4001). Le cas fréquent est un téléphone qui a perdu le
réseau et dont l'ancien socket met des minutes à mourir : refuser le nouveau
rendrait le retour impossible.

⚠️ **Contrepartie assumée** : quelqu'un qui connaît le code **et** un
`player.id` peut évincer son propriétaire. Entre amis, acceptable. À rediscuter
avant le handoff.

### Déconnexion ≠ départ

| Événement | Effet |
|---|---|
| **coupure réseau** (socket fermé, ou coupé par le heartbeat) | joueur **absent**, gardé **60 s** ; il reprend sa place en rejouant `join` avec le même `player.id` |
| **`leave`** (départ volontaire) | joueur **retiré tout de suite**, sans délai de grâce |
| plus **aucun joueur connecté** après l'un ou l'autre | session **supprimée immédiatement**, absents compris |

La dernière ligne vaut pour les deux chemins : un salon où il ne reste que des
absents n'a plus de participant volontairement présent. Jusqu'au 2026-09-19,
un `leave` n'appliquait pas cette règle et la session survivait 60 s pour un
absent.

### Heartbeat : un ping toutes les 20 s

Une connexion morte (mode avion, Wi-Fi coupé, onglet tué par l'OS) n'envoie
aucune trame de fermeture : sans heartbeat, le joueur restait « connecté »
jusqu'à ce que TCP abandonne. Le serveur envoie un **ping WebSocket natif**
toutes les **20 s** ; une connexion qui n'a pas répondu au ping précédent est
coupée au tour suivant (`terminate()`), donc **détectée en 20 à 40 s**, puis
traitée comme n'importe quelle coupure (absent, grâce, reprise).

Pourquoi 20 s : assez court pour que le salon soit juste avant un lancement,
assez long pour ne rien coûter (2 octets par joueur) et laisser une connexion
lente répondre. Le navigateur répond aux pings dans sa pile réseau, sans code
côté page — même un onglet en arrière-plan. Un trafic régulier évite aussi
qu'un proxy ferme une connexion jugée inactive.

⚠️ Conséquence : un hôte seul qui recharge sa page perd sa session. C'est le
comportement demandé (« suppression de la session quand le dernier joueur
part ») ; une vraie survie demanderait un délai avant fermeture, à décider.

### 12 joueurs

C'est le `MAX_PLAYERS` de `precision-server`, le plus permissif des sept.
Plafonner à 8 interdirait une session de dix amis qui veulent jouer à Precision.
Le filtre par jeu viendra du manifest, avec le randomizer.

### L'image est acceptée ici, pas dans les jeux

Les six serveurs qui prennent un avatar font `String(avatar || '🙂').slice(0, 4)` :
une image n'y tiendra jamais. Une session de Hub n'est pas un protocole de jeu,
donc le Hub garde l'avatar complet en mémoire. Le jour du handoff, c'est
**l'emoji seul** qui partira vers le serveur du jeu.

⚠️ `slice(0, 4)` compte des unités **UTF-16**. Un emoji à ZWJ (👨‍👩‍👧 = 8
unités) serait coupé en plein milieu par les jeux : `src/identity.js` le refuse
ici, comme le client le refuse déjà.

## Randomizer

### Le catalogue : le manifest du portfolio, relu, pas recopié

`src/catalog.js` va chercher `data/games.manifest.json` sur GitHub Pages
(`MANIFEST_URL`, cache 5 min), exactement comme `ban-server` va chercher
`videos.json`. Mathys édite `data/games.js`, rebuild, push : **aucun
redéploiement Render**. `MANIFEST_FILE` le remplace par un fichier (tests).
Chaque jeu est relu ; un jeu mal formé est écarté, une version de schéma
inconnue refusée en bloc. Si GitHub Pages ne répond pas, l'ancien catalogue
sert encore.

### Filtrer → pondérer → tirer (`src/engine.js`, module pur)

**1. Filtre** — un jeu sort si l'une de ces raisons s'applique (toutes sont
renvoyées, pas seulement la première, dans `pool.why`) :

| Raison | Règle (valeurs du manifest, telles quelles) |
|---|---|
| `TOO_FEW` / `TOO_MANY` | `session.players.length` hors de `players.min..max` (absents compris : ils sont dans le groupe) |
| `LOCAL_ONLY` | `mode: 'local'` et plus d'un joueur (un jeu local tourne dans UN navigateur) |
| `NEEDS` | un `needs` que **un seul** joueur n'a pas déclaré — nommé |
| `VETO` | **un** joueur l'a mis en veto — nommé. Personne d'autre ne peut le lever |
| `TOO_LONG` | `minutes.max` > la durée max réglée par l'hôte (c'est le MAX qui compte) |
| `SERVER_DOWN` | le `/health` du jeu n'a pas répondu 2xx |

**2. Poids** — `(1 + 0,5 × nombre de ❤️) × récence`. Récence selon le dernier
passage du jeu : tirage précédent ×0,15, avant-dernier ×0,4, celui d'avant ×0,7,
sinon ×1. **Un cœur penche, il n'oblige pas ; la récence freine, elle n'interdit
pas** (à deux jeux possibles, un groupe alternerait sinon mécaniquement).

**3. Tirage** — pondéré, hasard cryptographique. Rien n'est tiré avant que la
liste éligible soit connue.

### Le tirage, côté Hub

- `draw` ne porte rien : ni jeu, ni nombre de joueurs. Tout est relu dans
  l'état serveur.
- L'état passe à `drawing` **synchronement**, avant tout `await` : un second
  `draw`, même dans la même milliseconde, reçoit `DRAW_IN_PROGRESS`. Deux
  tirages vivants, ou deux jeux pour un tirage, sont impossibles.
- Le Hub vérifie la santé des jeux pas encore vus vivants (GET en parallèle,
  40 s au plus : un serveur Render endormi a le temps de se réveiller), puis
  filtre sur l'état de **ce moment-là** — un veto posé pendant l'attente compte.
- Résultat : `draw = { id, n, status: 'drawn', by, gameId, eligible[], weights{},
  requestedAt, drawnAt }`, et `history.played.push(gameId)`. L'historique ne
  fait que grandir pendant la session ; une nouvelle session repart de zéro.
- Aucun jeu possible : `NO_ELIGIBLE_GAME` + `why`, **aucun repli**, la session
  revient exactement à son état d'avant.
- `continue` (hôte) : `draw.status = 'confirmed'`, état `debrief`. Le jeu ne se
  lance pas : c'est le point d'accroche du handoff.
- Revenir (reconnexion) ne déclenche rien : on retrouve le tirage en cours.
- **Enchaîner** : `debrief` → `draw` → `drawing` → `continue` → `debrief`…
  Le moteur est sans état : une « soirée en N jeux » ne serait qu'un compteur
  autour de ce cycle.

### Santé des serveurs de jeu (`src/health.js`)

Un **GET** sur l'URL `health` du manifest, rien d'autre : le Hub n'ouvre
**jamais** de WebSocket vers un serveur de jeu. `up` (2xx) vaut 5 min, `down`
(autre code, ou rien en 40 s) écarte le jeu 2 min. Pré-réveil à la création
d'une session ; revérification avant chaque tirage si ce n'est plus frais. Un
jeu en cours de vérification n'est pas écarté du salon (il se réveille), mais
seul un jeu vu vivant peut être **tiré**.

## HTTP

```
GET /health   (et GET / , même réponse)
{ "ok": true, "service": "game-hub-server", "protocolVersion": 1,
  "serverVersion": "0.1.0", "sessions": 0, "players": 0, "uptimeSec": 12 }
```

Pas de tableau de bord. `protocolVersion` change quand un client à jour ne peut
plus parler à un serveur ancien — pas à chaque correctif.

## Architecture

| Fichier | Rôle | Connaît le réseau ? |
|---|---|---|
| `src/codes.js` | tirage et normalisation des codes | non |
| `src/identity.js` | validation de l'identité cliente | non |
| `src/session.js` | modèle de session, joueurs, élection d'hôte | non |
| `src/serialize.js` | l'état public (liste **blanche**) | non |
| `src/protocol.js` | messages acceptés, codes d'erreur | non |
| `src/engine.js` | **le moteur de tirage** : filtre, poids, tirage — pur | non |
| `src/prefs.js` | validation de prefs, caps, contrainte | non |
| `src/catalog.js` | lecture et validation du manifest | HTTP (GET) |
| `src/health.js` | santé des serveurs de jeu | HTTP (GET) |
| `src/hub.js` | le magasin de sessions et les handlers | oui |
| `src/http.js` | `/health` | oui |
| `src/server.js` | assemblage et démarrage | oui |

⚠️ `serialize.js` construit un objet neuf **champ par champ**. On ne prend
jamais la session pour en retirer des morceaux : avec une liste noire, un champ
interne ajouté demain partirait tout seul sur le fil. Un test le vérifie en
ajoutant un champ au modèle.

## Tests

```bash
node test-session.js   # 41 — modèle pur, sans réseau
node test-engine.js    # 65 — moteur de tirage pur, sur les valeurs du manifest réel
node test.js           # 37 — protocole, vraies connexions WebSocket
node test-presence.js  # 23 — heartbeat, leave, coupures, reprises (vraies connexions)
node test-draw.js      # 54 — randomizer sur vraies connexions : prefs, caps, tirage,
                       #      concurrence, reconnexion, serveur malade, sécurité
node test-e2e.js       # 26 — le vrai serveur, HTTP et tirage compris
```

`test-draw.js` et `test-e2e.js` n'utilisent PAS le réseau : le catalogue est
un fichier local aux valeurs du manifest réel, et les `/health` des jeux
pointent vers un faux serveur HTTP local (ou le Hub lui-même) — qu'on rend
malade, lent ou mort à volonté.

`test-presence.js` simule une connexion MORTE avec un client `ws` créé en
`autoPong: false` : il ne répond plus aux pings, comme un téléphone hors ligne.

`test.js` monte le hub à la main pour raccourcir le délai de grâce à 200 ms ;
c'est `test-e2e.js` qui démarre **`src/server.js` tel quel** — sans lui,
personne ne vérifierait que l'assemblage se lance.

⚠️ Dans ces tests, on n'attend jamais « le prochain message `session` » : la
diffusion déclenchée par l'action **précédente** peut arriver juste après et se
faire passer pour elle. On attend un état qui satisfait une **condition**
(`c.until(...)`). Les deux premiers échecs de ce dépôt venaient exactement de
là — et le serveur, lui, était correct.
